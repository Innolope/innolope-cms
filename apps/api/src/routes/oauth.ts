import { createHash, randomUUID } from 'node:crypto'
import {
	oauthAuthCodes,
	oauthClients,
	oauthRefreshTokens,
	refreshTokens,
	users,
} from '@innolope/db'
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

// Mirrors the admin app's theme tokens (apps/admin/src/index.css) so the
// server-rendered OAuth screens look native next to the CMS login: light by
// default, dark via prefers-color-scheme, monochrome primary button, and the
// Red Hat Display brand font.
function htmlShell(title: string, body: string): string {
	return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<link rel="icon" href="/logo.svg">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Red+Hat+Display:wght@400;500;600;700&display=swap">
<style>
:root{
--bg:#fafafa;--surface:#fff;--border:#e4e4e7;--border-strong:#d4d4d8;
--text:#18181b;--text-secondary:#71717a;--text-muted:#a1a1aa;
--input:#fff;--btn:#18181b;--btn-text:#fff;--btn-hover:#27272a;
--btn2:#f4f4f5;--btn2-text:#18181b;--btn2-hover:#e4e4e7;
--danger:#dc2626;--danger-surface:#fef2f2}
@media (prefers-color-scheme:dark){:root{
--bg:#09090b;--surface:#18181b;--border:#27272a;--border-strong:#3f3f46;
--text:#f4f4f5;--text-secondary:#a1a1aa;--text-muted:#71717a;
--input:#27272a;--btn:#f4f4f5;--btn-text:#18181b;--btn-hover:#e4e4e7;
--btn2:#27272a;--btn2-text:#f4f4f5;--btn2-hover:#3f3f46;
--danger:#f87171;--danger-surface:#450a0a}}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:16px;
background:var(--bg);color:var(--text);
font-family:"Red Hat Display","Sora",system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
.wrap{width:100%;max-width:384px}
.brand{text-align:center;margin-bottom:32px}
.brand img{width:40px;height:40px;margin:0 auto 16px;display:block}
.brand h1{font-size:24px;font-weight:700;margin:0}
.brand p{font-size:14px;color:var(--text-secondary);margin:4px 0 0;line-height:1.5}
form{display:flex;flex-direction:column;gap:16px}
label{display:block;font-size:12px;color:var(--text-secondary);margin-bottom:6px}
input{width:100%;padding:10px 12px;font-size:14px;border-radius:8px;
border:1px solid var(--border);background:var(--input);color:var(--text);font-family:inherit}
input:focus{outline:none;border-color:var(--border-strong)}
button{width:100%;padding:10px 12px;font-size:14px;font-weight:500;border-radius:8px;border:0;cursor:pointer;font-family:inherit}
.row{display:flex;gap:12px}
.row button{flex:1}
.primary{background:var(--btn);color:var(--btn-text)}
.primary:hover{background:var(--btn-hover)}
.secondary{background:var(--btn2);color:var(--btn2-text)}
.secondary:hover{background:var(--btn2-hover)}
.err{font-size:14px;color:var(--danger);background:var(--danger-surface);padding:8px 12px;border-radius:8px;margin:0 0 16px}
.desc{font-size:14px;color:var(--text-secondary);line-height:1.5;margin:0}
.muted{font-size:12px;color:var(--text-muted);text-align:center;margin-top:16px}
button:disabled{opacity:.65;cursor:default}
</style></head><body><div class="wrap">${body}</div>
<script>
// Give submit buttons an immediate pending state (the POST is a full-page
// navigation, so without this the click feels dead). Preserve the clicked
// button's name/value via a hidden input first, since a disabled button is not
// included in the form submission — otherwise "Allow" would submit as no action.
for (const f of document.querySelectorAll('form')) {
  f.addEventListener('submit', (e) => {
    const btn = e.submitter
    // Consent form uses named buttons (allow/deny). If we can't tell which was
    // clicked, leave the buttons enabled so the action still submits.
    if (f.querySelector('button[name]') && !(btn && btn.name)) return
    if (btn && btn.name) {
      const h = document.createElement('input')
      h.type = 'hidden'; h.name = btn.name; h.value = btn.value
      f.appendChild(h)
    }
    for (const b of f.querySelectorAll('button')) b.disabled = true
    const active = btn || f.querySelector('button.primary')
    if (active) active.textContent = active.value === 'deny' ? 'Denying…' : active.value === 'allow' ? 'Authorizing…' : 'Signing in…'
  }, { once: true })
}
</script>
</body></html>`
}

/** Shared logo + "Innolope CMS" heading + one-line subtitle. */
function brandHeader(subtitle: string): string {
	return `<div class="brand"><img src="/logo.svg" alt="Innolope CMS"><h1>Innolope CMS</h1><p>${subtitle}</p></div>`
}

function loginPage(ticket: string, clientName: string, error?: string): string {
	return htmlShell(
		'Sign in — Innolope CMS',
		`${brandHeader(`<strong>${escapeHtml(clientName)}</strong> wants to connect to your account`)}
${error ? `<p class="err">${escapeHtml(error)}</p>` : ''}
<form method="post" action="/oauth/authorize">
<input type="hidden" name="ticket" value="${escapeHtml(ticket)}">
<div><label for="email">Email</label>
<input id="email" name="email" type="email" autocomplete="username" required autofocus></div>
<div><label for="password">Password</label>
<input id="password" name="password" type="password" autocomplete="current-password" required></div>
<button class="primary" type="submit">Sign in</button>
</form>`,
	)
}

function consentPage(ticket: string, clientName: string, _scope: string, email: string): string {
	return htmlShell(
		'Authorize — Innolope CMS',
		`${brandHeader('Authorize access to your account')}
<form method="post" action="/oauth/authorize">
<input type="hidden" name="ticket" value="${escapeHtml(ticket)}">
<p class="desc"><strong>${escapeHtml(clientName)}</strong> is requesting access to your Innolope CMS account, including creating projects, managing collections, and reading/writing content.</p>
<div class="row">
<button class="secondary" type="submit" name="action" value="deny">Deny</button>
<button class="primary" type="submit" name="action" value="allow">Allow</button>
</div>
</form>
<p class="muted">Signed in as ${escapeHtml(email)}</p>`,
	)
}

function errorPage(reply: FastifyReply, status: number, message: string) {
	return reply
		.status(status)
		.type('text/html')
		.send(
			htmlShell(
				'Error — Innolope CMS',
				`${brandHeader('Authorization error')}<p class="desc" style="text-align:center">${escapeHtml(message)}</p>`,
			),
		)
}

async function currentUser(app: FastifyInstance, request: FastifyRequest) {
	// Prefer the short-lived access cookie when it's still valid.
	const cookieToken = request.cookies?.innolope_token
	if (cookieToken) {
		const jwtUser = await verifyJwt(cookieToken)
		if (jwtUser) {
			// Confirm the account still exists (and fetch canonical fields).
			const [user] = await app.db.select().from(users).where(eq(users.id, jwtUser.id)).limit(1)
			if (user) return user
		}
	}

	// The access JWT lives only an hour, but an admin who is "logged in" keeps a
	// 30-day refresh cookie. Recognize that existing web session here so the OAuth
	// consent screen doesn't force a redundant sign-in. Read-only on purpose: we
	// validate the token but never rotate or revoke it, so the user's open admin
	// tab keeps its session intact.
	const refreshCookie = request.cookies?.innolope_refresh
	if (refreshCookie) {
		const [row] = await app.db
			.select()
			.from(refreshTokens)
			.where(
				and(
					eq(refreshTokens.tokenHash, hashToken(refreshCookie)),
					eq(refreshTokens.revoked, false),
				),
			)
			.limit(1)
		if (row && row.expiresAt > new Date()) {
			const [user] = await app.db.select().from(users).where(eq(users.id, row.userId)).limit(1)
			if (user) return user
		}
	}

	return null
}

/** OAuth 2.1 discovery documents. Registered at the domain root. */
export async function wellKnownRoutes(app: FastifyInstance) {
	const asMetadata = async (request: FastifyRequest) =>
		authorizationServerMetadata(publicBaseUrl(request))
	const prMetadata = async (request: FastifyRequest) =>
		protectedResourceMetadata(publicBaseUrl(request))

	app.get('/.well-known/oauth-authorization-server', asMetadata)
	app.get('/.well-known/oauth-protected-resource', prMetadata)

	// RFC 9728 §3.1: the metadata URL for a resource identifier is formed by
	// inserting `/.well-known/oauth-protected-resource` *before* the resource's
	// path. Our resource is `<base>/mcp`, so the canonical document lives at
	// `<base>/.well-known/oauth-protected-resource/mcp`. MCP clients (e.g. the
	// Claude connector) derive this path-suffixed URL straight from the resource
	// identifier rather than only trusting the WWW-Authenticate hint — so it MUST
	// return the JSON here. Without it, the SPA static catch-all answers with
	// index.html (HTTP 200, text/html), the client fails to parse the metadata,
	// and the OAuth handshake dies before it ever redirects (blank connect page).
	app.get('/.well-known/oauth-protected-resource/mcp', prMetadata)
	// Same rationale for authorization-server metadata: some clients path-insert
	// the resource path onto the issuer as well. Harmless to answer both.
	app.get('/.well-known/oauth-authorization-server/mcp', asMetadata)
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
