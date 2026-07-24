/**
 * Cloudflare OAuth integration ("Connect Cloudflare" button).
 *
 * Cloudflare ships self-managed OAuth clients (June 2026): Authorization Code
 * flow against dash.cloudflare.com, scopes mirroring API-token permission
 * names, refresh tokens via `offline_access`. Innolope registers one
 * confidential client (Manage Account → OAuth clients); a project's tokens are
 * stored encrypted in `cloudflare_connections` and exchanged for the user's
 * account id + Images delivery hash so they never type credentials.
 *
 * Endpoints per https://developers.cloudflare.com/fundamentals/oauth/integrate-with-cloudflare/
 */
import { createHash, randomBytes } from 'node:crypto'
import { cloudflareConnections } from '@innolope/db'
import { eq } from 'drizzle-orm'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { decryptSecret, encryptSecret } from '../lib/crypto.js'
import { publicBaseUrl } from './oauth-metadata.js'

const AUTHORIZE_URL = 'https://dash.cloudflare.com/oauth2/auth'
const TOKEN_URL = 'https://dash.cloudflare.com/oauth2/token'
const REVOKE_URL = 'https://dash.cloudflare.com/oauth2/revoke'
const CF_API = 'https://api.cloudflare.com/client/v4'

/** Refresh this many ms before the recorded expiry. */
const REFRESH_AHEAD_MS = 60_000

/** The OAuth feature is off (manual credential entry only) until a client id is configured. */
export function cloudflareOauthEnabled(): boolean {
	return Boolean(process.env.CLOUDFLARE_OAUTH_CLIENT_ID)
}

/**
 * Scopes requested at authorization, verified against Cloudflare's live scope
 * catalog (GET /client/v4/oauth/scopes): `account-settings.read` is the
 * permission behind GET /accounts (there is no generic `account.read`), and
 * `offline_access` is the protocol-level scope for refresh tokens — the client
 * must also carry the `refresh_token` grant type. Override via env if the
 * catalog ever drifts.
 */
export function cloudflareOauthScopes(): string {
	return (
		process.env.CLOUDFLARE_OAUTH_SCOPES ||
		'account-settings.read images.read images.write offline_access'
	)
}

export function cloudflareRedirectUri(request: FastifyRequest): string {
	return (
		process.env.CLOUDFLARE_OAUTH_REDIRECT_URI ||
		`${publicBaseUrl(request)}/api/v1/integrations/cloudflare/callback`
	)
}

function clientId(): string {
	const id = process.env.CLOUDFLARE_OAUTH_CLIENT_ID
	if (!id) throw new Error('CLOUDFLARE_OAUTH_CLIENT_ID is not configured')
	return id
}

function clientSecret(): string {
	const secret = process.env.CLOUDFLARE_OAUTH_CLIENT_SECRET
	if (!secret) throw new Error('CLOUDFLARE_OAUTH_CLIENT_SECRET is not configured')
	return secret
}

const base64url = (buf: Buffer) => buf.toString('base64url')

/** PKCE S256 pair — belt and braces on top of the confidential client secret. */
export function newPkcePair(): { verifier: string; challenge: string } {
	const verifier = base64url(randomBytes(32))
	const challenge = base64url(createHash('sha256').update(verifier).digest())
	return { verifier, challenge }
}

export function newStateNonce(): string {
	return base64url(randomBytes(24))
}

export function buildAuthorizeUrl(opts: {
	state: string
	codeChallenge: string
	redirectUri: string
}): string {
	const url = new URL(AUTHORIZE_URL)
	url.searchParams.set('response_type', 'code')
	url.searchParams.set('client_id', clientId())
	url.searchParams.set('redirect_uri', opts.redirectUri)
	url.searchParams.set('scope', cloudflareOauthScopes())
	url.searchParams.set('state', opts.state)
	url.searchParams.set('code_challenge', opts.codeChallenge)
	url.searchParams.set('code_challenge_method', 'S256')
	return url.toString()
}

export interface CloudflareTokens {
	accessToken: string
	refreshToken?: string
	/** Absolute expiry; undefined when Cloudflare reports no expiry. */
	expiresAt?: Date
	scopes: string[]
}

async function tokenRequest(params: Record<string, string>): Promise<CloudflareTokens> {
	const res = await fetch(TOKEN_URL, {
		method: 'POST',
		headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
		body: new URLSearchParams({
			client_id: clientId(),
			client_secret: clientSecret(),
			...params,
		}),
	})
	const data = (await res.json().catch(() => ({}))) as {
		access_token?: string
		refresh_token?: string
		expires_in?: number
		scope?: string
		error?: string
		error_description?: string
	}
	if (!res.ok || !data.access_token) {
		throw new Error(
			`Cloudflare token endpoint ${res.status}: ${data.error_description || data.error || 'no access token returned'}`,
		)
	}
	return {
		accessToken: data.access_token,
		refreshToken: data.refresh_token,
		expiresAt:
			typeof data.expires_in === 'number'
				? new Date(Date.now() + data.expires_in * 1000)
				: undefined,
		scopes: data.scope ? data.scope.split(/[\s,]+/).filter(Boolean) : [],
	}
}

export function exchangeCode(
	code: string,
	codeVerifier: string,
	redirectUri: string,
): Promise<CloudflareTokens> {
	return tokenRequest({
		grant_type: 'authorization_code',
		code,
		code_verifier: codeVerifier,
		redirect_uri: redirectUri,
	})
}

export function refreshAccessToken(refreshToken: string): Promise<CloudflareTokens> {
	return tokenRequest({ grant_type: 'refresh_token', refresh_token: refreshToken })
}

/** Best-effort revocation; connection rows are deleted regardless of the outcome. */
export async function revokeToken(token: string): Promise<void> {
	try {
		await fetch(REVOKE_URL, {
			method: 'POST',
			headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
			body: new URLSearchParams({
				client_id: clientId(),
				client_secret: clientSecret(),
				token,
			}),
		})
	} catch {
		// revocation is advisory
	}
}

export interface CloudflareAccount {
	id: string
	name: string
}

export async function listAccounts(accessToken: string): Promise<CloudflareAccount[]> {
	const res = await fetch(`${CF_API}/accounts?per_page=50`, {
		headers: { Authorization: `Bearer ${accessToken}` },
	})
	const data = (await res.json().catch(() => ({}))) as {
		success?: boolean
		result?: Array<{ id: string; name: string }>
		errors?: Array<{ message: string }>
	}
	if (!res.ok || !data.success || !Array.isArray(data.result)) {
		throw new Error(`Cloudflare accounts list failed: ${data.errors?.[0]?.message || res.status}`)
	}
	return data.result.map((a) => ({ id: a.id, name: a.name }))
}

/** Transparent 1×1 PNG used to probe an empty Images account for its delivery hash. */
const PROBE_PNG = Buffer.from(
	'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
	'base64',
)

function hashFromDeliveryUrl(url: string): string | null {
	try {
		const parsed = new URL(url)
		if (!parsed.hostname.endsWith('imagedelivery.net')) return null
		return parsed.pathname.split('/').filter(Boolean)[0] || null
	} catch {
		return null
	}
}

/**
 * The Images delivery account hash is not the account id — it only appears in
 * delivery URLs. List one image and parse it; on an empty account, upload a
 * 1×1 probe, parse its variants, and delete it again.
 */
export async function discoverImagesAccountHash(
	accessToken: string,
	accountId: string,
): Promise<string | null> {
	const listRes = await fetch(`${CF_API}/accounts/${accountId}/images/v1?per_page=1`, {
		headers: { Authorization: `Bearer ${accessToken}` },
	})
	const listData = (await listRes.json().catch(() => ({}))) as {
		result?: { images?: Array<{ variants?: string[] }> }
	}
	for (const variant of listData.result?.images?.[0]?.variants ?? []) {
		const hash = hashFromDeliveryUrl(variant)
		if (hash) return hash
	}

	const form = new FormData()
	form.append('file', new Blob([new Uint8Array(PROBE_PNG)], { type: 'image/png' }), 'probe.png')
	const uploadRes = await fetch(`${CF_API}/accounts/${accountId}/images/v1`, {
		method: 'POST',
		headers: { Authorization: `Bearer ${accessToken}` },
		body: form,
	})
	const uploadData = (await uploadRes.json().catch(() => ({}))) as {
		result?: { id?: string; variants?: string[] }
	}
	const probeId = uploadData.result?.id
	let hash: string | null = null
	for (const variant of uploadData.result?.variants ?? []) {
		hash = hashFromDeliveryUrl(variant)
		if (hash) break
	}
	if (probeId) {
		await fetch(`${CF_API}/accounts/${accountId}/images/v1/${probeId}`, {
			method: 'DELETE',
			headers: { Authorization: `Bearer ${accessToken}` },
		}).catch(() => {})
	}
	return hash
}

/** The connection needs the user to run the consent flow again. */
export class CloudflareReconnectError extends Error {
	constructor() {
		super('The Cloudflare connection has expired — reconnect it in Settings → Media.')
		this.name = 'CloudflareReconnectError'
	}
}

/** In-flight refreshes deduped per project so concurrent uploads share one refresh. */
const refreshing = new Map<string, Promise<string>>()

/**
 * The single entry point for using a project's OAuth connection: returns a
 * valid access token, refreshing (and persisting the rotation) when the stored
 * one is about to expire. Returns null when the project has no active
 * connection; throws CloudflareReconnectError when refresh fails.
 */
export async function getAccessToken(
	app: FastifyInstance,
	projectId: string,
): Promise<string | null> {
	const [conn] = await app.db
		.select()
		.from(cloudflareConnections)
		.where(eq(cloudflareConnections.projectId, projectId))
		.limit(1)
	if (conn?.status !== 'active') return null

	const expiresSoon =
		conn.accessTokenExpiresAt && conn.accessTokenExpiresAt.getTime() - Date.now() < REFRESH_AHEAD_MS
	if (!expiresSoon) return decryptSecret(conn.accessTokenEnc)

	if (!conn.refreshTokenEnc) {
		await app.db
			.update(cloudflareConnections)
			.set({ status: 'needs_reconnect', updatedAt: new Date() })
			.where(eq(cloudflareConnections.id, conn.id))
		throw new CloudflareReconnectError()
	}

	const inFlight = refreshing.get(projectId)
	if (inFlight) return inFlight

	const refreshPromise = (async () => {
		try {
			const tokens = await refreshAccessToken(decryptSecret(conn.refreshTokenEnc as string))
			await app.db
				.update(cloudflareConnections)
				.set({
					accessTokenEnc: encryptSecret(tokens.accessToken),
					// Cloudflare may rotate the refresh token; keep the old one otherwise.
					...(tokens.refreshToken ? { refreshTokenEnc: encryptSecret(tokens.refreshToken) } : {}),
					accessTokenExpiresAt: tokens.expiresAt ?? null,
					updatedAt: new Date(),
				})
				.where(eq(cloudflareConnections.id, conn.id))
			return tokens.accessToken
		} catch (err) {
			app.log.warn({ err, projectId }, 'Cloudflare token refresh failed')
			await app.db
				.update(cloudflareConnections)
				.set({ status: 'needs_reconnect', updatedAt: new Date() })
				.where(eq(cloudflareConnections.id, conn.id))
			throw new CloudflareReconnectError()
		} finally {
			refreshing.delete(projectId)
		}
	})()
	refreshing.set(projectId, refreshPromise)
	return refreshPromise
}
