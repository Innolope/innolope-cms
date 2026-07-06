import { randomUUID } from 'node:crypto'
import {
	collections,
	content,
	projectMemberCollections,
	projectMembers,
	projects,
	users,
} from '@innolope/db'
import { eq } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createJwt } from '../plugins/auth.js'
import { buildTestApp, hasTestDb } from '../test/harness.js'

// Regression coverage for the per-member collection access boundary. A project
// member scoped to collection A (via a projectMemberCollections row) must not be
// able to read content in collection B through ANY read path — including the
// query-by-fields endpoint and the version history, which previously skipped the
// checkCollectionAccess gate that GET /content enforces.
describe.skipIf(!hasTestDb)('collection access boundary (real Postgres)', () => {
	let app: FastifyInstance
	let authHeader: string
	let projectId: string
	let collA: string
	let collB: string
	let contentInB: string

	beforeAll(async () => {
		app = await buildTestApp()
		const short = randomUUID().slice(0, 8)

		const [user] = await app.db
			.insert(users)
			.values({ email: `restricted-${short}@example.com`, name: 'Restricted', role: 'editor' })
			.returning()

		const [project] = await app.db
			.insert(projects)
			.values({ name: 'Access Test', slug: `access-${short}`, ownerId: user.id })
			.returning()
		projectId = project.id

		const [a] = await app.db
			.insert(collections)
			.values({ projectId, name: `a_${short}`, label: 'A', fields: [] })
			.returning()
		const [b] = await app.db
			.insert(collections)
			.values({ projectId, name: `b_${short}`, label: 'B', fields: [] })
			.returning()
		collA = a.id
		collB = b.id

		const [member] = await app.db
			.insert(projectMembers)
			.values({ projectId, userId: user.id, role: 'editor' })
			.returning()

		// Restrict the member to collection A only.
		await app.db
			.insert(projectMemberCollections)
			.values({ memberId: member.id, collectionId: collA })

		// Seed a content row in the OUT-OF-SCOPE collection B.
		const [row] = await app.db
			.insert(content)
			.values({
				projectId,
				collectionId: collB,
				slug: `secret-${short}`,
				markdown: '# secret',
				html: '<h1>secret</h1>',
			})
			.returning()
		contentInB = row.id

		authHeader = `Bearer ${await createJwt({
			id: user.id,
			email: user.email,
			name: user.name,
			role: 'editor',
		})}`
	})

	afterAll(async () => {
		if (projectId) await app.db.delete(projects).where(eq(projects.id, projectId))
		await app?.close()
	})

	// Double-submit CSRF token: the app rejects non-GET requests unless the
	// innolope_csrf cookie matches the x-csrf-token header. Any matching pair
	// satisfies it, so POST tests must send both to reach the access logic.
	const CSRF = 'test-csrf-token'
	const headers = () => ({
		authorization: authHeader,
		'x-project-id': projectId,
		'x-csrf-token': CSRF,
	})
	const csrfCookies = { innolope_csrf: CSRF }

	it('denies query-by-fields for an out-of-scope collection', async () => {
		const res = await app.inject({
			method: 'POST',
			url: '/api/v1/content/query-by-fields',
			headers: headers(),
			cookies: csrfCookies,
			payload: { collectionId: collB, filters: {} },
		})
		expect(res.statusCode).toBe(403)
	})

	it('does not leak out-of-scope content when query-by-fields omits a collection', async () => {
		const res = await app.inject({
			method: 'POST',
			url: '/api/v1/content/query-by-fields',
			headers: headers(),
			cookies: csrfCookies,
			payload: { filters: {} },
		})
		expect(res.statusCode).toBe(200)
		const ids = (res.json().data as Array<{ id: string }>).map((r) => r.id)
		expect(ids).not.toContain(contentInB)
	})

	it('denies version history for out-of-scope content', async () => {
		const res = await app.inject({
			method: 'GET',
			url: `/api/v1/content/${contentInB}/versions`,
			headers: headers(),
		})
		expect(res.statusCode).toBe(403)
	})

	it('does not leak out-of-scope content through whole-project export', async () => {
		const res = await app.inject({
			method: 'GET',
			url: '/api/v1/content/export?format=jsonl',
			headers: headers(),
		})
		expect(res.statusCode).toBe(200)
		expect(res.body).not.toContain(contentInB)
	})

	it('denies export scoped to an out-of-scope collection', async () => {
		const res = await app.inject({
			method: 'GET',
			url: `/api/v1/content/export?format=jsonl&collectionId=${collB}`,
			headers: headers(),
		})
		expect(res.statusCode).toBe(403)
	})

	it('allows query-by-fields for an in-scope collection', async () => {
		const res = await app.inject({
			method: 'POST',
			url: '/api/v1/content/query-by-fields',
			headers: headers(),
			cookies: csrfCookies,
			payload: { collectionId: collA, filters: {} },
		})
		expect(res.statusCode).toBe(200)
	})
})
