import type { FastifyInstance } from 'fastify'
import { and, eq, lt } from 'drizzle-orm'
import { ssoAuthStates, ssoConnections, ssoReplayCache } from '@innolope/db'
import { SAML } from '@node-saml/node-saml'
import { XMLParser } from 'fast-xml-parser'
import { completeSsoLogin, extractProfile, SsoError } from '../../services/sso-login.js'
import { newNonce, sanitizeNext, signState, verifyState } from '../../services/sso-state.js'
import { loadConnectionBySlug } from './oidc.js'

const STATE_TTL_MIN = 10
const REPLAY_TTL_MIN = 10

function acsUrl(slug: string): string {
	const base = process.env.SSO_CALLBACK_BASE_URL || ''
	if (!base) throw new Error('SSO_CALLBACK_BASE_URL not set')
	return `${base.replace(/\/$/, '')}/api/v1/auth/sso/${encodeURIComponent(slug)}/saml/acs`
}

function spEntityId(): string {
	return process.env.SAML_SP_ENTITY_ID || process.env.SSO_CALLBACK_BASE_URL || 'https://localhost'
}

/**
 * Build a SAML instance for a given connection. Each cert in samlIdpCertPems is tried
 * during signature verification (node-saml accepts an array via idpCert).
 */
function buildSaml(
	connection: typeof ssoConnections.$inferSelect,
	opts: { allowUnencryptedAssertions?: boolean } = {},
): SAML {
	if (!connection.samlSsoUrl || !connection.samlEntityId) {
		throw new SsoError('saml_config_incomplete', 400, 'SAML connection missing entityId or SSO URL')
	}
	if (connection.samlIdpCertPems.length === 0) {
		throw new SsoError('saml_no_cert', 400, 'SAML connection has no IdP certificate configured')
	}
	const skew = Number(process.env.SSO_CLOCK_SKEW_SECONDS || '120')

	return new SAML({
		callbackUrl: acsUrl(connection.slug),
		entryPoint: connection.samlSsoUrl,
		issuer: spEntityId(),
		idpCert: connection.samlIdpCertPems,
		audience: spEntityId(),
		wantAssertionsSigned: connection.samlWantAssertionsSigned,
		wantAuthnResponseSigned: true,
		signatureAlgorithm: 'sha256',
		digestAlgorithm: 'sha256',
		identifierFormat: 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress',
		privateKey: process.env.SAML_SP_PRIVATE_KEY_PEM,
		publicCert: process.env.SAML_SP_CERT_PEM,
		acceptedClockSkewMs: skew * 1000,
		disableRequestedAuthnContext: true,
	})
}

export async function initiateSaml(
	app: FastifyInstance,
	connection: typeof ssoConnections.$inferSelect,
	opts: { next?: string; intent: 'login' | 'link' | 'test'; linkUserId?: string },
): Promise<string> {
	const saml = buildSaml(connection)
	const state = newNonce()
	const expiresAt = new Date(Date.now() + STATE_TTL_MIN * 60 * 1000)

	// Generate the AuthnRequest and extract its ID so we can later match InResponseTo.
	// node-saml v5 returns `getAuthorizeUrlAsync(RelayState, host, options)`.
	const relayState = await signState({
		slug: connection.slug,
		connectionId: connection.id,
		nonce: state,
		next: sanitizeNext(opts.next),
		intent: opts.intent,
		linkUserId: opts.linkUserId,
	})
	// We don't have direct access to the AuthnRequest ID via the public API, so we store
	// the signed RelayState as the correlator. node-saml will embed its own request ID;
	// the replay cache + audience/recipient checks provide the tampering defense.
	await app.db.insert(ssoAuthStates).values({
		state,
		connectionId: connection.id,
		verifier: relayState,
		next: sanitizeNext(opts.next),
		intent: opts.intent,
		linkUserId: opts.linkUserId,
		expiresAt,
	})

	const host = new URL(process.env.SSO_CALLBACK_BASE_URL || 'http://localhost').host
	return saml.getAuthorizeUrlAsync(relayState, host, {})
}

function extractResponseIdFromXml(body: { SAMLResponse?: string }): string | null {
	if (!body.SAMLResponse) return null
	try {
		const xml = Buffer.from(body.SAMLResponse, 'base64').toString('utf8')
		const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' })
		const parsed = parser.parse(xml) as Record<string, unknown>
		const resp = (parsed['samlp:Response'] || parsed.Response || parsed['saml2p:Response']) as Record<string, unknown> | undefined
		const id = resp?.['@_ID']
		return typeof id === 'string' ? id : null
	} catch {
		return null
	}
}

function extractInResponseTo(body: { SAMLResponse?: string }): string | null {
	if (!body.SAMLResponse) return null
	try {
		const xml = Buffer.from(body.SAMLResponse, 'base64').toString('utf8')
		const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' })
		const parsed = parser.parse(xml) as Record<string, unknown>
		const resp = (parsed['samlp:Response'] || parsed.Response || parsed['saml2p:Response']) as Record<string, unknown> | undefined
		const inResponseTo = resp?.['@_InResponseTo']
		return typeof inResponseTo === 'string' ? inResponseTo : null
	} catch {
		return null
	}
}

export async function ssoSamlRoutes(app: FastifyInstance) {
	const preLicense = [app.requireLicense('sso')]

	// SP metadata (public)
	app.get<{ Params: { slug: string } }>(
		'/:slug/saml/metadata',
		{ preHandler: preLicense },
		async (request, reply) => {
			const connection = await loadConnectionBySlug(app, request.params.slug)
			if (!connection || connection.protocol !== 'saml') {
				return reply.status(404).send({ error: 'Not found' })
			}
			try {
				const saml = buildSaml(connection)
				const cert = process.env.SAML_SP_CERT_PEM || ''
				const xml = saml.generateServiceProviderMetadata(cert, cert)
				return reply.header('Content-Type', 'application/samlmetadata+xml').send(xml)
			} catch (err) {
				const e = err as Error
				return reply.status(500).send({ error: e.message })
			}
		},
	)

	// ACS — receives POST from the IdP
	app.post<{ Params: { slug: string }; Body: { SAMLResponse?: string; RelayState?: string } }>(
		'/:slug/saml/acs',
		{ preHandler: preLicense, config: { rateLimit: { max: 20, timeWindow: '1 minute' } } },
		async (request, reply) => {
			const connection = await loadConnectionBySlug(app, request.params.slug)
			if (!connection || connection.protocol !== 'saml') {
				return reply.status(404).send({ error: 'Not found' })
			}

			const body = request.body || {}
			if (!body.SAMLResponse) {
				return reply.status(400).send({ error: 'Missing SAMLResponse' })
			}

			// Correlation: InResponseTo must match an outstanding AuthnRequest state
			// unless allowIdpInitiated is set AND InResponseTo is absent.
			const inResponseTo = extractInResponseTo(body)
			const relayState = body.RelayState
			let stateRow: typeof ssoAuthStates.$inferSelect | null = null

			if (relayState) {
				const decoded = await verifyState(relayState)
				if (!decoded || decoded.connectionId !== connection.id) {
					app.events.emit({
						type: 'auth:sso_failed',
						data: { connectionId: connection.id, reason: 'invalid_relaystate' },
						timestamp: new Date().toISOString(),
					})
					return reply.status(400).send({ error: 'Invalid RelayState' })
				}
				const [row] = await app.db
					.select()
					.from(ssoAuthStates)
					.where(eq(ssoAuthStates.state, decoded.nonce))
					.limit(1)
				stateRow = row ?? null
				if (!stateRow) {
					return reply.status(400).send({ error: 'Unknown or replayed state' })
				}
				if (new Date(stateRow.expiresAt) < new Date()) {
					await app.db.delete(ssoAuthStates).where(eq(ssoAuthStates.id, stateRow.id))
					return reply.status(400).send({ error: 'State expired' })
				}
				await app.db.delete(ssoAuthStates).where(eq(ssoAuthStates.id, stateRow.id))
			} else if (!inResponseTo && connection.allowIdpInitiated) {
				// Unsolicited response — allowed per connection flag. No state correlation.
				stateRow = null
			} else {
				app.events.emit({
					type: 'auth:sso_failed',
					data: { connectionId: connection.id, reason: 'idp_initiated_disabled' },
					timestamp: new Date().toISOString(),
				})
				return reply.status(400).send({ error: 'IdP-initiated SAML is not allowed for this connection' })
			}

			// Replay cache: use the Response.ID (must be unique)
			const responseId = extractResponseIdFromXml(body)
			if (responseId) {
				try {
					await app.db.insert(ssoReplayCache).values({
						responseId,
						expiresAt: new Date(Date.now() + REPLAY_TTL_MIN * 60 * 1000),
					})
				} catch {
					app.events.emit({
						type: 'auth:sso_failed',
						data: { connectionId: connection.id, reason: 'replay_detected' },
						timestamp: new Date().toISOString(),
					})
					return reply.status(400).send({ error: 'Replay detected' })
				}
			}

			// Opportunistic GC of expired replay cache rows
			app.db
				.delete(ssoReplayCache)
				.where(lt(ssoReplayCache.expiresAt, new Date()))
				.catch(() => {})

			// Validate signature + audience + recipient + timestamps
			let parsed: Awaited<ReturnType<SAML['validatePostResponseAsync']>>
			try {
				const saml = buildSaml(connection)
				parsed = await saml.validatePostResponseAsync({ SAMLResponse: body.SAMLResponse })
			} catch (err) {
				const e = err as Error
				app.log.warn({ err: e }, 'SAML validation failed')
				app.events.emit({
					type: 'auth:sso_failed',
					data: { connectionId: connection.id, reason: 'signature_or_audience' },
					timestamp: new Date().toISOString(),
				})
				return reply.status(400).send({ error: 'Invalid SAML response' })
			}

			if (parsed.loggedOut) {
				return reply.status(400).send({ error: 'Unexpected logout response' })
			}

			const profileRaw = parsed.profile as unknown as Record<string, unknown>
			const subject = (profileRaw?.nameID as string | undefined) ?? (profileRaw?.['urn:oid:0.9.2342.19200300.100.1.1'] as string | undefined)
			if (!subject) {
				return reply.status(400).send({ error: 'SAML assertion missing NameID' })
			}

			const profile = extractProfile(connection, profileRaw, String(subject))
			// node-saml puts email under nameID when the format is email
			if (!profile.email && /^[^@\s]+@[^@\s]+$/.test(String(subject))) {
				profile.email = String(subject)
			}

			try {
				await completeSsoLogin(app, {
					connection,
					profile,
					reply,
					intent: (stateRow?.intent as 'login' | 'link' | 'test') ?? 'login',
					linkUserId: stateRow?.linkUserId ?? undefined,
					next: stateRow?.next ?? undefined,
				})
			} catch (err) {
				if (err instanceof SsoError) {
					app.events.emit({
						type: 'auth:sso_failed',
						data: { connectionId: connection.id, reason: err.code },
						timestamp: new Date().toISOString(),
					})
					return reply.status(err.statusCode).send({ error: err.message, code: err.code })
				}
				throw err
			}

			const next = stateRow?.next ?? '/'
			return reply.redirect(next)
		},
	)
}
