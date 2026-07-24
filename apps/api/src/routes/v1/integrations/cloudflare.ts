/**
 * "Connect Cloudflare" OAuth routes.
 *
 * POST /start          → authorize URL (admin; full-page redirect from the SPA)
 * GET  /callback       → code exchange; NO auth preHandler — this is a top-level
 *                        cross-site redirect carrying no usable cookies, so all
 *                        context is bound to the single-use DB state row.
 * GET  /status         → connection state for the settings UI (never tokens)
 * POST /select-account → finalize when the grant spans several accounts
 * POST /disconnect     → best-effort revoke + forget
 */
import { cloudflareConnections, cloudflareOauthStates, projects } from '@innolope/db'
import { and, eq, lt } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { encryptSecret } from '../../../lib/crypto.js'
import { getUser } from '../../../plugins/auth.js'
import { getProject } from '../../../plugins/project.js'
import {
	buildAuthorizeUrl,
	type CloudflareTokens,
	cloudflareOauthEnabled,
	cloudflareRedirectUri,
	discoverImagesAccountHash,
	exchangeCode,
	getAccessToken,
	listAccounts,
	newPkcePair,
	newStateNonce,
	revokeToken,
} from '../../../services/cloudflare-oauth.js'

const STATE_TTL_MS = 10 * 60 * 1000

/** Settings-page path the callback redirects back to (SPA served by this API). */
function settingsPath(params: Record<string, string>): string {
	const admin = (process.env.ADMIN_URL || '').replace(/\/$/, '')
	const query = new URLSearchParams({ tab: 'storage', ...params })
	return `${admin}/settings?${query}`
}

/**
 * Mirror non-secret discovery results into `settings.cloudflare` (where the
 * media adapter reads them) and select Cloudflare as the project's adapter.
 */
async function finalizeConnection(
	app: FastifyInstance,
	projectId: string,
	accessToken: string,
	account: { id: string; name: string },
): Promise<void> {
	const accountHash = await discoverImagesAccountHash(accessToken, account.id)
	await app.db
		.update(cloudflareConnections)
		.set({
			accountId: account.id,
			accountName: account.name,
			status: 'active',
			updatedAt: new Date(),
		})
		.where(eq(cloudflareConnections.projectId, projectId))

	const [project] = await app.db.select().from(projects).where(eq(projects.id, projectId)).limit(1)
	if (!project) return
	const settings = { ...((project.settings as unknown as Record<string, unknown>) || {}) }
	const cf = { ...((settings.cloudflare as Record<string, unknown>) || {}) }
	cf.accountId = account.id
	if (accountHash) cf.imagesAccountHash = accountHash
	cf.source = 'oauth'
	settings.cloudflare = cf
	settings.mediaAdapter = 'cloudflare'
	await app.db
		.update(projects)
		.set({
			settings: settings as unknown as (typeof projects.$inferInsert)['settings'],
			updatedAt: new Date(),
		})
		.where(eq(projects.id, projectId))
}

async function upsertConnection(
	app: FastifyInstance,
	projectId: string,
	userId: string,
	tokens: CloudflareTokens,
): Promise<void> {
	const values = {
		accessTokenEnc: encryptSecret(tokens.accessToken),
		refreshTokenEnc: tokens.refreshToken ? encryptSecret(tokens.refreshToken) : null,
		accessTokenExpiresAt: tokens.expiresAt ?? null,
		scopes: tokens.scopes,
		status: 'pending_account' as const,
		connectedByUserId: userId,
		updatedAt: new Date(),
	}
	const [existing] = await app.db
		.select({ id: cloudflareConnections.id })
		.from(cloudflareConnections)
		.where(eq(cloudflareConnections.projectId, projectId))
		.limit(1)
	if (existing) {
		await app.db
			.update(cloudflareConnections)
			.set(values)
			.where(eq(cloudflareConnections.id, existing.id))
	} else {
		await app.db.insert(cloudflareConnections).values({ projectId, ...values })
	}
}

export async function cloudflareIntegrationRoutes(app: FastifyInstance) {
	// Start the flow: single-use state + PKCE bound to project & user.
	app.post('/start', { preHandler: [app.requireProject('admin')] }, async (request, reply) => {
		if (!cloudflareOauthEnabled()) {
			return reply.status(400).send({ error: 'Cloudflare OAuth is not configured on this server' })
		}
		const state = newStateNonce()
		const { verifier, challenge } = newPkcePair()
		// Opportunistic GC of expired states.
		await app.db
			.delete(cloudflareOauthStates)
			.where(lt(cloudflareOauthStates.expiresAt, new Date()))
		await app.db.insert(cloudflareOauthStates).values({
			state,
			projectId: getProject(request).id,
			userId: getUser(request).id,
			verifier,
			expiresAt: new Date(Date.now() + STATE_TTL_MS),
		})
		return {
			url: buildAuthorizeUrl({
				state,
				codeChallenge: challenge,
				redirectUri: cloudflareRedirectUri(request),
			}),
		}
	})

	// OAuth callback — context comes exclusively from the state row.
	app.get<{ Querystring: { code?: string; state?: string; error?: string } }>(
		'/callback',
		async (request, reply) => {
			const { code, state, error } = request.query
			if (error) {
				return reply.redirect(settingsPath({ cf: 'error', reason: error }))
			}
			if (!code || !state) {
				return reply.redirect(settingsPath({ cf: 'error', reason: 'missing-code' }))
			}
			const [stateRow] = await app.db
				.select()
				.from(cloudflareOauthStates)
				.where(eq(cloudflareOauthStates.state, state))
				.limit(1)
			// Single use: consume before any exchange.
			if (stateRow) {
				await app.db.delete(cloudflareOauthStates).where(eq(cloudflareOauthStates.id, stateRow.id))
			}
			if (!stateRow || stateRow.expiresAt.getTime() < Date.now()) {
				return reply.redirect(settingsPath({ cf: 'error', reason: 'state-expired' }))
			}

			try {
				const tokens = await exchangeCode(code, stateRow.verifier, cloudflareRedirectUri(request))
				await upsertConnection(app, stateRow.projectId, stateRow.userId, tokens)

				const accounts = await listAccounts(tokens.accessToken)
				if (accounts.length === 1) {
					await finalizeConnection(app, stateRow.projectId, tokens.accessToken, accounts[0])
					return reply.redirect(settingsPath({ cf: 'connected' }))
				}
				return reply.redirect(settingsPath({ cf: 'choose-account' }))
			} catch (err) {
				app.log.error({ err }, 'Cloudflare OAuth callback failed')
				return reply.redirect(settingsPath({ cf: 'error', reason: 'exchange-failed' }))
			}
		},
	)

	// Connection state for the settings card. Booleans + account labels only.
	app.get('/status', { preHandler: [app.requireProject('admin')] }, async (request) => {
		const pid = getProject(request).id
		const [conn] = await app.db
			.select()
			.from(cloudflareConnections)
			.where(eq(cloudflareConnections.projectId, pid))
			.limit(1)
		const base = {
			oauthAvailable: cloudflareOauthEnabled(),
			connected: conn?.status === 'active',
			status: conn?.status ?? null,
			accountId: conn?.accountId ?? null,
			accountName: conn?.accountName ?? null,
			scopes: conn?.scopes ?? [],
		}
		if (conn?.status !== 'pending_account') return base
		// Mid-flow with several accounts: list them live for the picker.
		try {
			const token = await getAccessTokenForPending(app, pid)
			const accounts = token ? await listAccounts(token) : []
			return { ...base, accounts }
		} catch {
			return { ...base, accounts: [] }
		}
	})

	// Finalize a multi-account grant.
	app.post(
		'/select-account',
		{ preHandler: [app.requireProject('admin')] },
		async (request, reply) => {
			const { accountId } = (request.body as { accountId?: string }) || {}
			if (!accountId) return reply.status(400).send({ error: 'accountId is required' })
			const pid = getProject(request).id
			const token = await getAccessTokenForPending(app, pid)
			if (!token) return reply.status(400).send({ error: 'No pending Cloudflare connection' })
			const accounts = await listAccounts(token)
			const account = accounts.find((a) => a.id === accountId)
			if (!account) {
				return reply.status(400).send({ error: 'That account is not part of the authorized grant' })
			}
			await finalizeConnection(app, pid, token, account)
			return { ok: true }
		},
	)

	// Forget the connection. Existing media keeps working — delivery URLs are public.
	app.post('/disconnect', { preHandler: [app.requireProject('admin')] }, async (request, reply) => {
		const pid = getProject(request).id
		const [conn] = await app.db
			.select()
			.from(cloudflareConnections)
			.where(eq(cloudflareConnections.projectId, pid))
			.limit(1)
		if (!conn) return reply.status(404).send({ error: 'No Cloudflare connection' })
		try {
			const token = await getAccessToken(app, pid)
			if (token) await revokeToken(token)
		} catch {
			// best-effort — the row is deleted regardless
		}
		await app.db.delete(cloudflareConnections).where(eq(cloudflareConnections.id, conn.id))

		// Remove OAuth-derived settings keys; keep anything manually entered.
		const [project] = await app.db.select().from(projects).where(eq(projects.id, pid)).limit(1)
		if (project) {
			const settings = { ...((project.settings as unknown as Record<string, unknown>) || {}) }
			const cf = { ...((settings.cloudflare as Record<string, unknown>) || {}) }
			if (cf.source === 'oauth') {
				delete cf.accountId
				delete cf.imagesAccountHash
				delete cf.source
				settings.cloudflare = Object.keys(cf).length > 0 ? cf : undefined
			}
			await app.db
				.update(projects)
				.set({
					settings: settings as unknown as (typeof projects.$inferInsert)['settings'],
					updatedAt: new Date(),
				})
				.where(eq(projects.id, pid))
		}
		return { ok: true }
	})
}

/** Access token for a pending (account-not-yet-selected) connection. */
async function getAccessTokenForPending(
	app: FastifyInstance,
	projectId: string,
): Promise<string | null> {
	const [conn] = await app.db
		.select()
		.from(cloudflareConnections)
		.where(
			and(
				eq(cloudflareConnections.projectId, projectId),
				eq(cloudflareConnections.status, 'pending_account'),
			),
		)
		.limit(1)
	if (!conn) return null
	const { decryptSecret } = await import('../../../lib/crypto.js')
	return decryptSecret(conn.accessTokenEnc)
}
