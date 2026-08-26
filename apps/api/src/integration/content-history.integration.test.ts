import { randomUUID } from 'node:crypto'
import { collections, projectMembers, projects, users } from '@innolope/db'
import { eq } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createJwt } from '../plugins/auth.js'
import { buildTestApp, hasTestDb } from '../test/harness.js'

describe.skipIf(!hasTestDb)('content write attribution and history (real Postgres)', () => {
	let app: FastifyInstance
	let token: string
	let projectId: string
	let collectionId: string
	let userId: string
	let email: string

	// The MCP layer re-mints an ordinary session JWT for its loopback REST calls,
	// so the header is the only thing separating an agent's write from a human's.
	const asAdmin = () => ({ authorization: `Bearer ${token}`, 'x-project-id': projectId })
	const asMcp = () => ({ ...asAdmin(), 'x-innolope-client': 'mcp' })

	beforeAll(async () => {
		app = await buildTestApp()
		const short = randomUUID().slice(0, 8)
		email = `history-${short}@example.com`
		const [user] = await app.db
			.insert(users)
			.values({ email, name: 'History Tester', role: 'admin' })
			.returning()
		userId = user.id
		const [project] = await app.db
			.insert(projects)
			.values({ name: 'History Test', slug: `history-${short}`, ownerId: user.id })
			.returning()
		projectId = project.id
		await app.db.insert(projectMembers).values({ projectId, userId: user.id, role: 'admin' })
		const [col] = await app.db
			.insert(collections)
			.values({
				projectId,
				name: 'posts',
				label: 'Posts',
				fields: [{ name: 'title', type: 'text' }],
			})
			.returning()
		collectionId = col.id
		token = await createJwt({ id: user.id, email: user.email, name: user.name, role: 'admin' })
	})

	afterAll(async () => {
		if (app && projectId) await app.db.delete(projects).where(eq(projects.id, projectId))
		if (app && userId) await app.db.delete(users).where(eq(users.id, userId))
		await app?.close()
	})

	async function createPost(headers: Record<string, string>, slug: string) {
		const res = await app.inject({
			method: 'POST',
			url: '/api/v1/content',
			headers,
			payload: { collectionId, slug, markdown: '- one\n- two\n', metadata: { title: slug } },
		})
		expect(res.statusCode).toBe(201)
		return res.json().id as string
	}

	const history = async (id: string) => {
		const res = await app.inject({
			method: 'GET',
			url: `/api/v1/content/${id}/history`,
			headers: asAdmin(),
		})
		expect(res.statusCode).toBe(200)
		return res.json()
	}

	it('records the declared client on create', async () => {
		const body = await history(await createPost(asMcp(), `mcp-created-${randomUUID().slice(0, 6)}`))
		expect(body.current.source).toBe('mcp')
		expect(body.current.version).toBe(1)
		expect(body.current.updatedByEmail).toBe(email)
		expect(body.versions).toEqual([]) // never edited since creation
	})

	it('falls back to admin when no client identifies itself', async () => {
		const body = await history(
			await createPost(asAdmin(), `ui-created-${randomUUID().slice(0, 6)}`),
		)
		expect(body.current.source).toBe('admin')
	})

	// The question that motivated this: a record written by an agent, later
	// reformatted by a human in the CMS editor, has to read as a human's edit.
	it('tracks the source moving from mcp to admin across an edit', async () => {
		const id = await createPost(asMcp(), `handover-${randomUUID().slice(0, 6)}`)
		const res = await app.inject({
			method: 'PUT',
			url: `/api/v1/content/${id}`,
			headers: asAdmin(),
			payload: { markdown: '- one\n- two\n- three\n' },
		})
		expect(res.statusCode).toBe(200)

		const body = await history(id)
		expect(body.current.version).toBe(2)
		expect(body.current.source).toBe('admin')
		// A version row records the write that superseded it, not who authored it.
		expect(body.versions).toHaveLength(1)
		expect(body.versions[0]).toMatchObject({ version: 1, supersededVia: 'admin' })
		expect(body.versions[0].supersededByEmail).toBe(email)
	})

	it('attributes a status transition like any other write', async () => {
		const id = await createPost(asAdmin(), `publish-${randomUUID().slice(0, 6)}`)
		const res = await app.inject({
			method: 'POST',
			url: `/api/v1/content/${id}/publish`,
			headers: asMcp(),
		})
		expect(res.statusCode).toBe(200)
		expect((await history(id)).current).toMatchObject({ source: 'mcp', status: 'published' })
	})

	it('attributes scheduling and unscheduling too', async () => {
		const id = await createPost(asAdmin(), `schedule-${randomUUID().slice(0, 6)}`)
		const publishedAt = new Date(Date.now() + 60 * 60 * 1000).toISOString()
		const scheduled = await app.inject({
			method: 'POST',
			url: `/api/v1/ee/scheduling/${id}/schedule`,
			headers: asMcp(),
			payload: { publishedAt },
		})
		expect(scheduled.statusCode).toBe(200)
		expect((await history(id)).current).toMatchObject({ source: 'mcp', status: 'scheduled' })

		const unscheduled = await app.inject({
			method: 'DELETE',
			url: `/api/v1/ee/scheduling/${id}/schedule`,
			headers: asAdmin(),
		})
		expect(unscheduled.statusCode).toBe(200)
		expect((await history(id)).current).toMatchObject({ source: 'admin', status: 'draft' })
	})

	// A limit is a query string, so it arrives as whatever the caller typed. An
	// invalid one must not reach Postgres as a negative or fractional LIMIT.
	it('clamps a nonsensical limit instead of failing the request', async () => {
		const id = await createPost(asAdmin(), `limit-${randomUUID().slice(0, 6)}`)
		for (const limit of ['-5', 'abc', '0', '2.5', '99999']) {
			const res = await app.inject({
				method: 'GET',
				url: `/api/v1/content/${id}/history?limit=${limit}`,
				headers: asAdmin(),
			})
			expect(res.statusCode, `limit=${limit}`).toBe(200)
		}
	})

	it('discards a forged client value rather than storing it', async () => {
		const id = await createPost(
			{ ...asAdmin(), 'x-innolope-client': 'wordpress' },
			`forged-${randomUUID().slice(0, 6)}`,
		)
		expect((await history(id)).current.source).toBe('admin')
	})

	it('404s for a record outside the project', async () => {
		const res = await app.inject({
			method: 'GET',
			url: `/api/v1/content/${randomUUID()}/history`,
			headers: asAdmin(),
		})
		expect(res.statusCode).toBe(404)
	})
})
