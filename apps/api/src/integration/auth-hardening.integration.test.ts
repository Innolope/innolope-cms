import { createHash, randomUUID } from 'node:crypto'
import { collections, projectMembers, projects, refreshTokens, users } from '@innolope/db'
import { eq, sql } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createJwt, createOAuthAccessToken } from '../plugins/auth.js'
import { buildTestApp, hasTestDb } from '../test/harness.js'

/**
 * Pins the auth-boundary fixes from the 2026-09-05 adversarial review:
 * API keys are project credentials (never account credentials), key
 * permissions are enforced, MCP access tokens are not web sessions, first-admin
 * registration cannot race, and a password reset ends every session.
 */
describe.skipIf(!hasTestDb)('auth hardening (real Postgres)', () => {
	let app: FastifyInstance
	let ownerId: string
	let ownerToken: string
	let projectId: string
	let otherProjectId: string
	let collectionId: string
	const created: { users: string[]; projects: string[] } = { users: [], projects: [] }

	const asOwner = () => ({ authorization: `Bearer ${ownerToken}`, 'x-project-id': projectId })

	async function mintKey(permissions: string[]) {
		const res = await app.inject({
			method: 'POST',
			url: '/api/v1/auth/api-keys',
			headers: asOwner(),
			payload: { name: `k-${randomUUID().slice(0, 6)}`, permissions },
		})
		expect(res.statusCode).toBe(201)
		return res.json().key as string
	}

	beforeAll(async () => {
		app = await buildTestApp()
		const short = randomUUID().slice(0, 8)
		const [owner] = await app.db
			.insert(users)
			.values({ email: `owner-${short}@example.com`, name: 'Owner', role: 'editor' })
			.returning()
		ownerId = owner.id
		created.users.push(owner.id)
		const [p] = await app.db
			.insert(projects)
			.values({ name: 'Auth P', slug: `auth-${short}`, ownerId })
			.returning()
		projectId = p.id
		const [p2] = await app.db
			.insert(projects)
			.values({ name: 'Auth P2', slug: `auth2-${short}`, ownerId })
			.returning()
		otherProjectId = p2.id
		created.projects.push(p.id, p2.id)
		await app.db.insert(projectMembers).values([
			{ projectId, userId: ownerId, role: 'owner' },
			{ projectId: otherProjectId, userId: ownerId, role: 'owner' },
		])
		const [col] = await app.db
			.insert(collections)
			.values({
				projectId,
				name: `posts_${short}`,
				label: 'Posts',
				fields: [{ name: 'title', type: 'text' }],
			})
			.returning()
		collectionId = col.id
		ownerToken = await createJwt({ id: ownerId, email: owner.email, name: 'Owner', role: 'editor' })
	})

	afterAll(async () => {
		for (const id of created.projects) await app.db.delete(projects).where(eq(projects.id, id))
		for (const id of created.users) await app.db.delete(users).where(eq(users.id, id))
		await app?.close()
	})

	it('an API key cannot touch the owning account', async () => {
		const key = await mintKey(['*'])
		const res = await app.inject({
			method: 'PUT',
			url: '/api/v1/auth/profile',
			headers: { authorization: `Bearer ${key}` },
			payload: { email: `evil-${randomUUID().slice(0, 6)}@example.com` },
		})
		expect(res.statusCode).toBe(403)
		const [row] = await app.db.select().from(users).where(eq(users.id, ownerId))
		expect(row.email).not.toContain('evil-')
		const me = await app.inject({
			method: 'GET',
			url: '/api/v1/auth/me',
			headers: { authorization: `Bearer ${key}` },
		})
		expect(me.statusCode).toBe(403)
	})

	it('an API key lists only the project it was minted for', async () => {
		const key = await mintKey(['*'])
		const res = await app.inject({
			method: 'GET',
			url: '/api/v1/projects',
			headers: { authorization: `Bearer ${key}` },
		})
		expect(res.statusCode).toBe(200)
		const ids = (res.json() as { id: string }[]).map((p) => p.id)
		expect(ids).toEqual([projectId])
	})

	it('key permissions are enforced by method', async () => {
		const readOnly = await mintKey(['content:read'])
		const write = await app.inject({
			method: 'POST',
			url: '/api/v1/content',
			headers: { authorization: `Bearer ${readOnly}` },
			payload: { collectionId, slug: `ro-${randomUUID().slice(0, 6)}`, metadata: { title: 't' } },
		})
		expect(write.statusCode).toBe(403)
		const read = await app.inject({
			method: 'GET',
			url: '/api/v1/content',
			headers: { authorization: `Bearer ${readOnly}` },
		})
		expect(read.statusCode).toBe(200)

		const inert = await mintKey([])
		const denied = await app.inject({
			method: 'GET',
			url: '/api/v1/content',
			headers: { authorization: `Bearer ${inert}` },
		})
		expect(denied.statusCode).toBe(403)
	})

	it('an MCP OAuth access token is not a web session', async () => {
		const token = await createOAuthAccessToken(
			{ id: ownerId, email: 'x@example.com', name: 'Owner', role: 'editor' },
			{ scope: 'mcp', clientId: 'c', audience: 'https://cms.example.com/mcp' },
		)
		const res = await app.inject({
			method: 'GET',
			url: '/api/v1/auth/me',
			headers: { authorization: `Bearer ${token}` },
		})
		expect(res.statusCode).toBe(401)
	})

	it('a password reset revokes every refresh token', async () => {
		const short = randomUUID().slice(0, 8)
		const [u] = await app.db
			.insert(users)
			.values({ email: `reset-${short}@example.com`, name: 'R', role: 'editor', passwordHash: 'x' })
			.returning()
		created.users.push(u.id)
		await app.db.insert(refreshTokens).values({
			userId: u.id,
			family: randomUUID(),
			tokenHash: createHash('sha256').update(randomUUID()).digest('hex'),
			expiresAt: new Date(Date.now() + 86_400_000),
		})
		const raw = randomUUID()
		const tokenHash = createHash('sha256').update(raw).digest('hex')
		await app.db.execute(
			sql`INSERT INTO password_reset_tokens ("userId", "tokenHash", "expiresAt") VALUES (${u.id}, ${tokenHash}, ${new Date(Date.now() + 3_600_000).toISOString()}::timestamptz)`,
		)
		const res = await app.inject({
			method: 'POST',
			url: '/api/v1/auth/reset-password',
			payload: { token: raw, password: 'NewPassword123!' },
		})
		expect(res.statusCode).toBe(200)
		const rows = await app.db.select().from(refreshTokens).where(eq(refreshTokens.userId, u.id))
		expect(rows.every((r) => r.revoked)).toBe(true)
	})

	it('the public licence view hides the licensee', async () => {
		const anon = await app.inject({ method: 'GET', url: '/api/v1/license' })
		expect(anon.statusCode).toBe(200)
		expect(anon.json()).not.toHaveProperty('org')
		expect(anon.json()).not.toHaveProperty('expiresAt')
		const authed = await app.inject({
			method: 'GET',
			url: '/api/v1/license',
			headers: { authorization: `Bearer ${ownerToken}` },
		})
		expect(authed.json()).toHaveProperty('org')
	})
})
