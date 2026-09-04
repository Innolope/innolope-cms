import { ssoAuthStates, type ssoConnections, ssoReplayCache } from '@innolope/db'
import { type CacheProvider, SAML, ValidateInResponseTo } from '@node-saml/node-saml'
import { and, eq, lt } from 'drizzle-orm'
import { XMLParser } from 'fast-xml-parser'
import type { FastifyInstance } from 'fastify'
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

const REQUEST_KEY_PREFIX = 'saml-req:'

/**
 * node-saml keeps outstanding AuthnRequest IDs in a cache provider so it can
 * validate `InResponseTo`. Its default cache is per-instance memory, which is
 * useless when every request builds a fresh SAML object — so the IDs live in
 * `sso_auth_states` instead (keyed `saml-req:<id>`, same TTL as the state).
 * `onSave` lets the initiator learn the ID node-saml generated.
 */
function samlRequestCache(
	app: FastifyInstance,
	connectionId: string,
	onSave?: (requestId: string) => void,
): CacheProvider {
	const key = (id: string) => `${REQUEST_KEY_PREFIX}${id}`
	return {
		async saveAsync(id, value) {
			const createdAt = Date.now()
			await app.db
				.insert(ssoAuthStates)
				.values({
					state: key(id),
					connectionId,
					verifier: value,
					intent: 'login',
					expiresAt: new Date(createdAt + STATE_TTL_MIN * 60 * 1000),
				})
				.onConflictDoNothing()
			onSave?.(id)
			return { value, createdAt }
		},
		async getAsync(id) {
			const [row] = await app.db
				.select({
					id: ssoAuthStates.id,
					verifier: ssoAuthStates.verifier,
					expiresAt: ssoAuthStates.expiresAt,
				})
				.from(ssoAuthStates)
				.where(and(eq(ssoAuthStates.state, key(id)), eq(ssoAuthStates.connectionId, connectionId)))
				.limit(1)
			if (!row) return null
			if (new Date(row.expiresAt) < new Date()) {
				await app.db.delete(ssoAuthStates).where(eq(ssoAuthStates.id, row.id))
				return null
			}
			return row.verifier
		},
		async removeAsync(id) {
			if (!id) return null
			await app.db
				.delete(ssoAuthStates)
				.where(and(eq(ssoAuthStates.state, key(id)), eq(ssoAuthStates.connectionId, connectionId)))
			return id
		},
	}
}

/**
 * Build a SAML instance for a given connection. Each cert in samlIdpCertPems is tried
 * during signature verification (node-saml accepts an array via idpCert). The
 * assertion's Issuer is pinned to the configured IdP entity id, and
 * InResponseTo is validated against the request cache — always, unless the
 * connection explicitly allows unsolicited (IdP-initiated) responses.
 */
function buildSaml(
	app: FastifyInstance,
	connection: typeof ssoConnections.$inferSelect,
	opts: { onRequestId?: (id: string) => void } = {},
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
		idpIssuer: connection.samlEntityId,
		validateInResponseTo: connection.allowIdpInitiated
			? ValidateInResponseTo.ifPresent
			: ValidateInResponseTo.always,
		cacheProvider: samlRequestCache(app, connection.id, opts.onRequestId),
	})
}

export async function initiateSaml(
	app: FastifyInstance,
	connection: typeof ssoConnections.$inferSelect,
	opts: { next?: string; intent: 'login' | 'link' | 'test'; linkUserId?: string },
): Promise<string> {
	let requestId: string | undefined
	const saml = buildSaml(app, connection, { onRequestId: (id) => (requestId = id) })
	const state = newNonce()
	const expiresAt = new Date(Date.now() + STATE_TTL_MIN * 60 * 1000)

	const relayState = await signState({
		slug: connection.slug,
		connectionId: connection.id,
		nonce: state,
		next: sanitizeNext(opts.next),
		intent: opts.intent,
		linkUserId: opts.linkUserId,
	})

	// Generating the AuthnRequest stores its ID through the cache provider, which
	// hands it back here so the state row can pin the exact request this
	// RelayState belongs to. The ACS compares InResponseTo against it.
	const host = new URL(process.env.SSO_CALLBACK_BASE_URL || 'http://localhost').host
	const url = await saml.getAuthorizeUrlAsync(relayState, host, {})
	if (!requestId) throw new SsoError('saml_request_id', 500, 'Could not record the AuthnRequest id')

	await app.db.insert(ssoAuthStates).values({
		state,
		connectionId: connection.id,
		verifier: requestId,
		next: sanitizeNext(opts.next),
		intent: opts.intent,
		linkUserId: opts.linkUserId,
		expiresAt,
	})
	return url
}

function extractResponseIdFromXml(body: { SAMLResponse?: string }): string | null {
	if (!body.SAMLResponse) return null
	try {
		const xml = Buffer.from(body.SAMLResponse, 'base64').toString('utf8')
		const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' })
		const parsed = parser.parse(xml) as Record<string, unknown>
		const resp = (parsed['samlp:Response'] || parsed.Response || parsed['saml2p:Response']) as
			| Record<string, unknown>
			| undefined
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
		const resp = (parsed['samlp:Response'] || parsed.Response || parsed['saml2p:Response']) as
			| Record<string, unknown>
			| undefined
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
			if (connection?.protocol !== 'saml') {
				return reply.status(404).send({ error: 'Not found' })
			}
			try {
				const saml = buildSaml(app, connection)
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
			if (connection?.protocol !== 'saml') {
				return reply.status(404).send({ error: 'Not found' })
			}

			const body = request.body || {}
			if (!body.SAMLResponse) {
				return reply.status(400).send({ error: 'Missing SAMLResponse' })
			}

			// Correlation: the RelayState's stored request id must equal the
			// response's InResponseTo (checked below, after the state row is
			// consumed), and node-saml independently validates InResponseTo against
			// the request cache. Unsolicited responses need allowIdpInitiated.
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
				if (!inResponseTo || inResponseTo !== stateRow.verifier) {
					app.events.emit({
						type: 'auth:sso_failed',
						data: { connectionId: connection.id, reason: 'in_response_to_mismatch' },
						timestamp: new Date().toISOString(),
					})
					return reply
						.status(400)
						.send({ error: 'SAML response does not answer this authentication request' })
				}
			} else if (!inResponseTo && connection.allowIdpInitiated) {
				// Unsolicited response — allowed per connection flag. No state correlation.
				stateRow = null
			} else {
				app.events.emit({
					type: 'auth:sso_failed',
					data: { connectionId: connection.id, reason: 'idp_initiated_disabled' },
					timestamp: new Date().toISOString(),
				})
				return reply
					.status(400)
					.send({ error: 'IdP-initiated SAML is not allowed for this connection' })
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
				const saml = buildSaml(app, connection)
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
			const subject =
				(profileRaw?.nameID as string | undefined) ??
				(profileRaw?.['urn:oid:0.9.2342.19200300.100.1.1'] as string | undefined)
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
