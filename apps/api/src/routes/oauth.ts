import { createHash, randomUUID } from 'node:crypto'
import { oauthAuthCodes, oauthClients, oauthRefreshTokens, users } from '@innolope/db'
import { and, eq, isNull } from 'drizzle-orm'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { jwtVerify, SignJWT } from 'jose'
import {
	createOAuthAccessToken,
	getJwtSecret,
	hashToken,
	normalizeEmail,
	verifyJwt,
	verifyPassword,
} from '../plugins/auth.js'
import { setAuthCookies } from '../services/auth-cookies.js'
import {
	authorizationServerMetadata,
	mcpResourceUrl,
	protectedResourceMetadata,
	publicBaseUrl,
} from '../services/oauth-metadata.js'

const SUPPORTED_SCOPE = 'mcp'
const AUTH_CODE_TTL_MS = 60_000 // 1 minute
const REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000
const ACCESS_TTL_SECONDS = 3600
const TICKET_TTL_SECONDS = 600 // 10 minutes to complete login + consent

function sha256Base64Url(value: string): string {
	return createHash('sha256').update(value).digest('base64url')
}

function escapeHtml(value: string): string {
	return value
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#39;')
}

interface AuthorizeTicket {
	clientId: string
	redirectUri: string
	codeChallenge: string
	codeChallengeMethod: string
	scope: string
	state?: string
}

async function signTicket(ticket: AuthorizeTicket): Promise<string> {
	return new SignJWT({ ...ticket, typ: 'oauth_authorize_ticket' })
		.setProtectedHeader({ alg: 'HS256' })
		.setIssuedAt()
		.setExpirationTime(`${TICKET_TTL_SECONDS}s`)
		.sign(getJwtSecret())
}

async function verifyTicket(token: string): Promise<AuthorizeTicket | null> {
	try {
		const { payload } = await jwtVerify(token, getJwtSecret())
		if (payload.typ !== 'oauth_authorize_ticket') return null
		return {
			clientId: String(payload.clientId),
			redirectUri: String(payload.redirectUri),
			codeChallenge: String(payload.codeChallenge),
			codeChallengeMethod: String(payload.codeChallengeMethod),
			scope: String(payload.scope),
			state: payload.state ? String(payload.state) : undefined,
		}
	} catch {
		return null
	}
}

/** Build a redirect back to the client, preserving any existing query in redirect_uri. */
function redirectTo(redirectUri: string, params: Record<string, string | undefined>): string {
	const url = new URL(redirectUri)
	for (const [k, v] of Object.entries(params)) {
		if (v !== undefined) url.searchParams.set(k, v)
	}
	return url.toString()
}

function htmlShell(title: string, body: string): string {
	return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
:root{color-scheme:light dark}
body{font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#0b0d10;color:#e7e9ea}
.card{width:min(420px,92vw);background:#15181c;border:1px solid #262b31;border-radius:14px;padding:28px 26px;box-shadow:0 10px 40px rgba(0,0,0,.4)}
h1{font-size:18px;margin:0 0 6px}
p{color:#9aa4ad;font-size:14px;line-height:1.5;margin:0 0 18px}
label{display:block;font-size:13px;color:#c3cbd2;margin:12px 0 6px}
input{width:100%;box-sizing:border-box;padding:10px 12px;border-radius:9px;border:1px solid #2b3138;background:#0e1114;color:#e7e9ea;font-size:14px}
.row{display:flex;gap:10px;margin-top:20px}
button{flex:1;padding:11px 12px;border-radius:9px;border:0;font-size:14px;font-weight:600;cursor:pointer}
.primary{background:#3b82f6;color:#fff}
.ghost{background:#22272d;color:#c3cbd2}
.err{background:#3a1720;border:1px solid #5b2130;color:#f7b3c0;padding:10px 12px;border-radius:9px;font-size:13px;margin-bottom:14px}
.scope{background:#0e1114;border:1px solid #2b3138;border-radius:9px;padding:10px 12px;font-size:13px;color:#c3cbd2;margin-bottom:6px}
.muted{font-size:12px;color:#6b747c;margin-top:16px}
</style></head><body><div class="card">${body}</div></body></html>`
}

function loginPage(ticket: string, clientName: string, error?: string): string {
	return htmlShell(
		'Sign in — Innolope CMS',
		`<h1>Sign in to continue</h1>
<p><strong>${escapeHtml(clientName)}</strong> wants to connect to your Innolope CMS account.</p>
${error ? `<div class="err">${escapeHtml(error)}</div>` : ''}
<form method="post" action="/oauth/authorize">
<input type="hidden" name="ticket" value="${escapeHtml(ticket)}">
<label for="email">Email</label>
<input id="email" name="email" type="email" autocomplete="username" required autofocus>
<label for="password">Password</label>
<input id="password" name="password" type="password" autocomplete="current-password" required>
<div class="row"><button class="primary" type="submit">Sign in</button></div>
</form>`,
	)
}

function consentPage(ticket: string, clientName: string, scope: string, email: string): string {
	const scopes = scope
		.split(/\s+/)
		.filter(Boolean)
		.map((s) => `<div class="scope">${escapeHtml(s)}</div>`)
		.join('')
	return htmlShell(
		'Authorize — Innolope CMS',
		`<h1>Authorize access</h1>
<p><strong>${escapeHtml(clientName)}</strong> is requesting access to your Innolope CMS account, including creating projects, managing collections, and reading/writing content.</p>
${scopes}
<form method="post" action="/oauth/authorize">
<input type="hidden" name="ticket" value="${escapeHtml(ticket)}">
<div class="row">
<button class="ghost" type="submit" name="action" value="deny">Deny</button>
<button class="primary" type="submit" name="action" value="allow">Allow</button>
</div>
</form>
<div class="muted">Signed in as ${escapeHtml(email)}</div>`,
	)
}

function errorPage(reply: FastifyReply, status: number, message: string) {
	return reply
		.status(status)
		.type('text/html')
		.send(htmlShell('Error', `<h1>Authorization error</h1><p>${escapeHtml(message)}</p>`))
}

async function currentUser(app: FastifyInstance, request: FastifyRequest) {
	const cookieToken = request.cookies?.innolope_token
	if (!cookieToken) return null
	const jwtUser = await verifyJwt(cookieToken)
	if (!jwtUser) return null
	// Confirm the account still exists (and fetch canonical fields).
	const [user] = await app.db.select().from(users).where(eq(users.id, jwtUser.id)).limit(1)
	return user ?? null
}

/** OAuth 2.1 discovery documents. Registered at the domain root. */
export async function wellKnownRoutes(app: FastifyInstance) {
	app.get('/.well-known/oauth-authorization-server', async (request) =>
		authorizationServerMetadata(publicBaseUrl(request)),
	)
	app.get('/.well-known/oauth-protected-resource', async (request) =>
		protectedResourceMetadata(publicBaseUrl(request)),
	)
}

/** OAuth 2.1 authorization server: register, authorize (login + consent), token. */
export async function oauthRoutes(app: FastifyInstance) {
	// ── Dynamic Client Registration (RFC 7591) ────────────────────────────────
	app.post('/register', async (request, reply) => {
		const body = (request.body ?? {}) as {
			client_name?: string
			redirect_uris?: unknown
			grant_types?: string[]
			scope?: string
			token_endpoint_auth_method?: string
		}
		const redirectUris = Array.isArray(body.redirect_uris)
			? body.redirect_uris.filter((u): u is string => typeof u === 'string')
			: []
		if (redirectUris.length === 0) {
			return reply
				.status(400)
				.send({ error: 'invalid_redirect_uri', error_description: 'redirect_uris is required' })
		}
		for (const uri of redirectUris) {
			let parsed: URL
			try {
				parsed = new URL(uri)
			} catch {
				return reply.status(400).send({
					error: 'invalid_redirect_uri',
					error_description: `Invalid redirect_uri: ${uri}`,
				})
			}
			// Require https, or http only for loopback (native dev clients). Rejecting
			// plaintext remote redirects keeps an authorization code from ever being
			// delivered over an interceptable channel.
			const isLoopback = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1'
			if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && isLoopback)) {
				return reply.status(400).send({
					error: 'invalid_redirect_uri',
					error_description: 'redirect_uris must use https (http allowed only for localhost)',
				})
			}
		}

		const clientId = `mcp_${randomUUID().replace(/-/g, '')}`
		const grantTypes =
			Array.isArray(body.grant_types) && body.grant_types.length > 0
				? body.grant_types
				: ['authorization_code', 'refresh_token']
		const scope = body.scope || SUPPORTED_SCOPE

		await app.db.insert(oauthClients).values({
			clientId,
			clientName: body.client_name ?? null,
			redirectUris,
			grantTypes,
			scope,
			tokenEndpointAuthMethod: 'none',
		})

		return reply.status(201).send({
			client_id: clientId,
			client_name: body.client_name,
			redirect_uris: redirectUris,
			grant_types: grantTypes,
			response_types: ['code'],
			token_endpoint_auth_method: 'none',
			scope,
		})
	})

	// ── Authorization endpoint: GET renders login/consent ─────────────────────
	app.get('/authorize', async (request, reply) => {
		const q = request.query as Record<string, string | undefined>
		const clientId = q.client_id
		const redirectUri = q.redirect_uri
		if (!clientId || !redirectUri) {
			return errorPage(reply, 400, 'Missing client_id or redirect_uri.')
		}

		const [client] = await app.db
			.select()
			.from(oauthClients)
			.where(eq(oauthClients.clientId, clientId))
			.limit(1)
		if (!client) return errorPage(reply, 400, 'Unknown client_id.')
		if (!client.redirectUris.includes(redirectUri)) {
			// Per spec, never redirect to an unregistered URI — show an error instead.
			return errorPage(reply, 400, 'redirect_uri does not match any registered URI.')
		}

		// From here, protocol errors are reported back to the client via redirect.
		if (q.response_type !== 'code') {
			return reply.redirect(
				redirectTo(redirectUri, { error: 'unsupported_response_type', state: q.state }),
			)
		}
		if (!q.code_challenge || q.code_challenge_method !== 'S256') {
			return reply.redirect(
				redirectTo(redirectUri, {
					error: 'invalid_request',
					error_description: 'PKCE with S256 is required',
					state: q.state,
				}),
			)
		}
		const scope = q.scope?.trim() || SUPPORTED_SCOPE
		if (!scope.split(/\s+/).every((s) => s === SUPPORTED_SCOPE)) {
			return reply.redirect(redirectTo(redirectUri, { error: 'invalid_scope', state: q.state }))
		}

		const ticket = await signTicket({
			clientId,
			redirectUri,
			codeChallenge: q.code_challenge,
			codeChallengeMethod: 'S256',
			scope,
			state: q.state,
		})
		const clientName = client.clientName || clientId
		const user = await currentUser(app, request)
		const page = user
			? consentPage(ticket, clientName, scope, user.email)
			: loginPage(ticket, clientName)
		return reply.type('text/html').send(page)
	})

	// ── Authorization endpoint: POST handles login submit and consent decision ─
	app.post('/authorize', async (request, reply) => {
		const body = (request.body ?? {}) as {
			ticket?: string
			action?: string
			email?: string
			password?: string
		}
		if (!body.ticket) return errorPage(reply, 400, 'Missing request ticket. Restart authorization.')
		const ticket = await verifyTicket(body.ticket)
		if (!ticket)
			return errorPage(reply, 400, 'Authorization request expired. Restart authorization.')

		const [client] = await app.db
			.select()
			.from(oauthClients)
			.where(eq(oauthClients.clientId, ticket.clientId))
			.limit(1)
		if (!client?.redirectUris.includes(ticket.redirectUri)) {
			return errorPage(reply, 400, 'Invalid client for this request.')
		}
		const clientName = client.clientName || client.clientId

		// Login step: email + password submitted.
		if (body.email && body.password) {
			const [user] = await app.db
				.select()
				.from(users)
				.where(eq(users.email, normalizeEmail(body.email)))
				.limit(1)
			if (!user?.passwordHash || !(await verifyPassword(body.password, user.passwordHash))) {
				return reply
					.status(401)
					.type('text/html')
					.send(loginPage(body.ticket, clientName, 'Invalid email or password.'))
			}
			await setAuthCookies(reply, app.db, user)
			return reply
				.type('text/html')
				.send(consentPage(body.ticket, clientName, ticket.scope, user.email))
		}

		// Consent decision.
		const user = await currentUser(app, request)
		if (!user) {
			// Session lapsed between GET and POST — ask them to sign in again.
			return reply.type('text/html').send(loginPage(body.ticket, clientName))
		}
		if (body.action !== 'allow') {
			return reply.redirect(
				redirectTo(ticket.redirectUri, { error: 'access_denied', state: ticket.state }),
			)
		}

		// Issue a single-use authorization code bound to the PKCE challenge.
		const rawCode = randomUUID().replace(/-/g, '') + randomUUID().replace(/-/g, '')
		await app.db.insert(oauthAuthCodes).values({
			codeHash: hashToken(rawCode),
			clientId: ticket.clientId,
			userId: user.id,
			redirectUri: ticket.redirectUri,
			codeChallenge: ticket.codeChallenge,
			codeChallengeMethod: ticket.codeChallengeMethod,
			scope: ticket.scope,
			expiresAt: new Date(Date.now() + AUTH_CODE_TTL_MS),
		})
		return reply.redirect(redirectTo(ticket.redirectUri, { code: rawCode, state: ticket.state }))
	})

	// ── Token endpoint: authorization_code + refresh_token grants ──────────────
	app.post('/token', async (request, reply) => {
		reply.header('Cache-Control', 'no-store')
		reply.header('Pragma', 'no-cache')
		const body = (request.body ?? {}) as Record<string, string | undefined>
		const grantType = body.grant_type
		const audience = mcpResourceUrl(publicBaseUrl(request))

		if (grantType === 'authorization_code') {
			const { code, redirect_uri, client_id, code_verifier } = body
			if (!code || !redirect_uri || !client_id || !code_verifier) {
				return reply.status(400).send({ error: 'invalid_request' })
			}
			// Atomically consume the code: only the first caller flips consumedAt.
			const [row] = await app.db
				.update(oauthAuthCodes)
				.set({ consumedAt: new Date() })
				.where(and(eq(oauthAuthCodes.codeHash, hashToken(code)), isNull(oauthAuthCodes.consumedAt)))
				.returning()
			if (!row) return reply.status(400).send({ error: 'invalid_grant' })
			if (row.expiresAt < new Date()) return reply.status(400).send({ error: 'invalid_grant' })
			if (row.clientId !== client_id || row.redirectUri !== redirect_uri) {
				return reply.status(400).send({ error: 'invalid_grant' })
			}
			if (sha256Base64Url(code_verifier) !== row.codeChallenge) {
				return reply
					.status(400)
					.send({ error: 'invalid_grant', error_description: 'PKCE verification failed' })
			}

			const [user] = await app.db.select().from(users).where(eq(users.id, row.userId)).limit(1)
			if (!user) return reply.status(400).send({ error: 'invalid_grant' })

			return reply.send(
				await issueTokens(app, {
					user,
					clientId: client_id,
					scope: row.scope ?? SUPPORTED_SCOPE,
					audience,
				}),
			)
		}

		if (grantType === 'refresh_token') {
			const { refresh_token, client_id } = body
			if (!refresh_token || !client_id) {
				return reply.status(400).send({ error: 'invalid_request' })
			}
			// Single-use rotation: revoke the presented token; reject if already used/expired.
			const [row] = await app.db
				.update(oauthRefreshTokens)
				.set({ revoked: true })
				.where(
					and(
						eq(oauthRefreshTokens.tokenHash, hashToken(refresh_token)),
						eq(oauthRefreshTokens.revoked, false),
					),
				)
				.returning()
			if (!row) return reply.status(400).send({ error: 'invalid_grant' })
			if (row.expiresAt < new Date() || row.clientId !== client_id) {
				return reply.status(400).send({ error: 'invalid_grant' })
			}
			const [user] = await app.db.select().from(users).where(eq(users.id, row.userId)).limit(1)
			if (!user) return reply.status(400).send({ error: 'invalid_grant' })

			return reply.send(
				await issueTokens(app, {
					user,
					clientId: client_id,
					scope: row.scope ?? SUPPORTED_SCOPE,
					audience,
				}),
			)
		}

		return reply.status(400).send({ error: 'unsupported_grant_type' })
	})
}

/** Mint an access token + a fresh rotating refresh token and shape the token response. */
async function issueTokens(
	app: FastifyInstance,
	opts: {
		user: { id: string; email: string; name: string; role: string }
		clientId: string
		scope: string
		audience: string
	},
) {
	const accessToken = await createOAuthAccessToken(
		{
			id: opts.user.id,
			email: opts.user.email,
			name: opts.user.name,
			role: opts.user.role as never,
		},
		{ scope: opts.scope, clientId: opts.clientId, audience: opts.audience },
	)
	const rawRefresh = randomUUID().replace(/-/g, '') + randomUUID().replace(/-/g, '')
	await app.db.insert(oauthRefreshTokens).values({
		tokenHash: hashToken(rawRefresh),
		clientId: opts.clientId,
		userId: opts.user.id,
		scope: opts.scope,
		expiresAt: new Date(Date.now() + REFRESH_TTL_MS),
	})
	return {
		access_token: accessToken,
		token_type: 'Bearer',
		expires_in: ACCESS_TTL_SECONDS,
		refresh_token: rawRefresh,
		scope: opts.scope,
	}
}
