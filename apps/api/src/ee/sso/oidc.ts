import type { FastifyInstance } from 'fastify'
import { and, eq } from 'drizzle-orm'
import { ssoAuthStates, ssoConnections } from '@innolope/db'
import { Issuer, generators } from 'openid-client'
import { decryptSecret } from '../../lib/crypto.js'
import { completeSsoLogin, extractProfile, SsoError } from '../../services/sso-login.js'
import { newNonce, sanitizeNext, signState, verifyState } from '../../services/sso-state.js'

const CALLBACK_TTL_MIN = 10

function callbackUrl(slug: string): string {
	const base = process.env.SSO_CALLBACK_BASE_URL || ''
	if (!base) throw new Error('SSO_CALLBACK_BASE_URL not set')
	return `${base.replace(/\/$/, '')}/api/v1/auth/sso/${encodeURIComponent(slug)}/oidc/callback`
}

export async function loadConnectionBySlug(app: FastifyInstance, slug: string) {
	const [connection] = await app.db
		.select()
		.from(ssoConnections)
		.where(and(eq(ssoConnections.slug, slug), eq(ssoConnections.enabled, true)))
		.limit(1)
	return connection ?? null
}

async function buildClient(connection: Awaited<ReturnType<typeof loadConnectionBySlug>>) {
	if (!connection || connection.protocol !== 'oidc') {
		throw new SsoError('not_oidc', 400, 'Connection is not OIDC')
	}
	if (!connection.oidcIssuer || !connection.oidcClientId || !connection.oidcClientSecretEnc) {
		throw new SsoError('oidc_config_incomplete', 400, 'OIDC connection not fully configured')
	}
	const issuer = await Issuer.discover(connection.oidcIssuer)
	const secret = decryptSecret(connection.oidcClientSecretEnc)
	return new issuer.Client({
		client_id: connection.oidcClientId,
		client_secret: secret,
		redirect_uris: [callbackUrl(connection.slug)],
		response_types: ['code'],
	})
}

/**
 * OIDC callback + helpers. Initiate is unified for OIDC/SAML in sso/initiate.ts.
 * License-gated via app.requireLicense('sso').
 */
export async function initiateOidc(
	app: FastifyInstance,
	connection: NonNullable<Awaited<ReturnType<typeof loadConnectionBySlug>>>,
	opts: { next?: string; intent: 'login' | 'link' | 'test'; linkUserId?: string },
): Promise<string> {
	const client = await buildClient(connection)
	const state = newNonce()
	const nonce = newNonce()
	const codeVerifier = generators.codeVerifier()
	const codeChallenge = generators.codeChallenge(codeVerifier)
	const expiresAt = new Date(Date.now() + CALLBACK_TTL_MIN * 60 * 1000)

	await app.db.insert(ssoAuthStates).values({
		state,
		connectionId: connection.id,
		verifier: codeVerifier,
		nonce,
		next: sanitizeNext(opts.next),
		intent: opts.intent,
		linkUserId: opts.linkUserId,
		expiresAt,
	})

	const stateJwt = await signState({
		slug: connection.slug,
		connectionId: connection.id,
		nonce: state,
		next: sanitizeNext(opts.next),
		intent: opts.intent,
		linkUserId: opts.linkUserId,
	})

	return client.authorizationUrl({
		scope: (connection.oidcScopes ?? ['openid', 'email', 'profile']).join(' '),
		state: stateJwt,
		nonce,
		code_challenge: codeChallenge,
		code_challenge_method: 'S256',
	})
}

export async function ssoOidcRoutes(app: FastifyInstance) {
	const preLicense = [app.requireLicense('sso')]

	// OIDC callback
	app.get<{ Params: { slug: string }; Querystring: { code?: string; state?: string; error?: string } }>(
		'/:slug/oidc/callback',
		{ preHandler: preLicense },
		async (request, reply) => {
			const connection = await loadConnectionBySlug(app, request.params.slug)
			if (!connection || connection.protocol !== 'oidc') {
				return reply.status(404).send({ error: 'Not found' })
			}

			if (request.query.error) {
				app.events.emit({
					type: 'auth:sso_failed',
					data: { connectionId: connection.id, reason: request.query.error },
					timestamp: new Date().toISOString(),
				})
				return reply.status(400).send({ error: `IdP error: ${request.query.error}` })
			}

			const stateJwt = request.query.state
			const code = request.query.code
			if (!stateJwt || !code) {
				return reply.status(400).send({ error: 'Missing state or code' })
			}

			const decoded = await verifyState(stateJwt)
			if (!decoded || decoded.connectionId !== connection.id) {
				return reply.status(400).send({ error: 'Invalid state' })
			}

			const [stateRow] = await app.db
				.select()
				.from(ssoAuthStates)
				.where(eq(ssoAuthStates.state, decoded.nonce))
				.limit(1)
			if (!stateRow) {
				return reply.status(400).send({ error: 'Unknown or replayed state' })
			}
			if (new Date(stateRow.expiresAt) < new Date()) {
				await app.db.delete(ssoAuthStates).where(eq(ssoAuthStates.id, stateRow.id))
				return reply.status(400).send({ error: 'State expired' })
			}
			// Consume: delete first so the same state cannot be replayed concurrently
			await app.db.delete(ssoAuthStates).where(eq(ssoAuthStates.id, stateRow.id))

			let client
			try {
				client = await buildClient(connection)
			} catch (err) {
				const e = err as Error
				return reply.status(500).send({ error: e.message })
			}

			let tokenSet
			try {
				tokenSet = await client.callback(callbackUrl(connection.slug), { code, state: stateJwt }, {
					code_verifier: stateRow.verifier,
					state: stateJwt,
					nonce: stateRow.nonce ?? undefined,
				})
			} catch (err) {
				const e = err as Error
				app.log.warn({ err: e }, 'OIDC token exchange failed')
				app.events.emit({
					type: 'auth:sso_failed',
					data: { connectionId: connection.id, reason: 'token_exchange' },
					timestamp: new Date().toISOString(),
				})
				return reply.status(400).send({ error: 'Token exchange failed' })
			}

			const claims = tokenSet.claims()
			let userInfo: Record<string, unknown> = {}
			try {
				if (tokenSet.access_token) {
					userInfo = (await client.userinfo(tokenSet.access_token)) as Record<string, unknown>
				}
			} catch (err) {
				app.log.warn({ err }, 'OIDC userinfo failed (continuing with id_token claims)')
			}

			const merged = { ...claims, ...userInfo } as Record<string, unknown>
			const subject = claims.sub
			if (!subject) return reply.status(400).send({ error: 'No sub claim' })

			const profile = extractProfile(connection, merged, subject)

			try {
				await completeSsoLogin(app, {
					connection,
					profile,
					reply,
					intent: stateRow.intent as 'login' | 'link' | 'test',
					linkUserId: stateRow.linkUserId ?? undefined,
					next: stateRow.next ?? undefined,
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

			const next = stateRow.next ?? '/'
			return reply.redirect(next)
		},
	)
}
