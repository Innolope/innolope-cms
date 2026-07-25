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

// The bulk-action endpoint must enforce the same per-member collection
// boundary as the single-record routes: a member scoped to collection A must
// not be able to act on collection B's rows — neither by naming their ids nor
// by resolving "everything matching" through an unscoped filter.
describe.skipIf(!hasTestDb)('bulk actions collection boundary (real Postgres)', () => {
	let app: FastifyInstance
	let authHeader: string
	let projectId: string
	let collA: string
	let collB: string
	let rowInA: string
	let rowInB: string

	beforeAll(async () => {
		app = await buildTestApp()
		const short = randomUUID().slice(0, 8)

		const [user] = await app.db
			.insert(users)
			.values({ email: `bulk-acl-${short}@example.com`, name: 'Bulk ACL', role: 'editor' })
			.returning()

		const [project] = await app.db
			.insert(projects)
			.values({ name: 'Bulk ACL Test', slug: `bulk-acl-${short}`, ownerId: user.id })
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
		await app.db
			.insert(projectMemberCollections)
			.values({ memberId: member.id, collectionId: collA })

		const [inA] = await app.db
			.insert(content)
			.values({
				projectId,
				collectionId: collA,
				slug: `mine-${short}`,
				markdown: '# mine',
				html: '<h1>mine</h1>',
			})
			.returning()
		rowInA = inA.id
		const [inB] = await app.db
			.insert(content)
			.values({
				projectId,
				collectionId: collB,
				slug: `theirs-${short}`,
				markdown: '# theirs',
				html: '<h1>theirs</h1>',
			})
			.returning()
		rowInB = inB.id

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

	const CSRF = 'test-csrf-token'
	const headers = () => ({
		authorization: authHeader,
		'x-project-id': projectId,
		'x-csrf-token': CSRF,
	})
	const csrfCookies = { innolope_csrf: CSRF }

	const statusOf = async (id: string) => {
		const [row] = await app.db.select().from(content).where(eq(content.id, id)).limit(1)
		return row?.status
	}

	it('fails the out-of-scope row (and only that row) when ids name it directly', async () => {
		const res = await app.inject({
			method: 'POST',
			url: '/api/v1/content/bulk-action',
			headers: headers(),
			cookies: csrfCookies,
			payload: { action: 'archive', ids: [rowInA, rowInB] },
		})
		expect(res.statusCode).toBe(200)
		const body = res.json()
		expect(body.succeeded).toBe(1)
		expect(body.failed).toBe(1)
		const failedRow = body.results.find((r: { ok: boolean }) => !r.ok)
		expect(failedRow.id).toBe(rowInB)
		expect(failedRow.error).toMatch(/access/i)

		expect(await statusOf(rowInA)).toBe('archived')
		expect(await statusOf(rowInB)).toBe('draft')
	})

	it('excludes out-of-scope rows when an unscoped filter resolves the selection', async () => {
		const res = await app.inject({
			method: 'POST',
			url: '/api/v1/content/bulk-action',
			headers: headers(),
			cookies: csrfCookies,
			payload: { action: 'unpublish', filter: {} },
		})
		expect(res.statusCode).toBe(200)
		const body = res.json()
		const touched = (body.results as Array<{ id: string }>).map((r) => r.id)
		expect(touched).toContain(rowInA)
		expect(touched).not.toContain(rowInB)
		expect(await statusOf(rowInB)).toBe('draft')
	})

	it('denies a filter that names an out-of-scope collection', async () => {
		const res = await app.inject({
			method: 'POST',
			url: '/api/v1/content/bulk-action',
			headers: headers(),
			cookies: csrfCookies,
			payload: { action: 'archive', filter: { collectionId: collB } },
		})
		expect(res.statusCode).toBe(403)
		expect(await statusOf(rowInB)).toBe('draft')
	})

	it('still gates delete on the project role for scoped editors', async () => {
		const res = await app.inject({
			method: 'POST',
			url: '/api/v1/content/bulk-action',
			headers: headers(),
			cookies: csrfCookies,
			payload: { action: 'delete', ids: [rowInA] },
		})
		expect(res.statusCode).toBe(403)
	})
})
