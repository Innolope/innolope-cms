import { randomUUID } from 'node:crypto'
import {
	collectionPreviewTemplates,
	collections,
	content,
	projectMemberCollections,
	projectMembers,
	projects,
	users,
} from '@innolope/db'
import { and, eq } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createJwt } from '../plugins/auth.js'
import { buildTestApp, hasTestDb } from '../test/harness.js'

const safeFetch = vi.hoisted(() =>
	vi.fn(
		async (_url: string | URL, _init?: RequestInit): Promise<Response> =>
			new Response('', { status: 404 }),
	),
)
const validatePublicUrl = vi.hoisted(() => vi.fn(async (_url: string) => null as string | null))
vi.mock('../adapters/connection-guard.js', async (original) => ({
	...(await original<typeof import('../adapters/connection-guard.js')>()),
	safeFetch,
	validatePublicUrl,
}))

const PAGE = 'https://example.com/blog/sample/en/'
const prose =
	'This is a long paragraph with real article content about the feature and its expected behavior. '.repeat(
		5,
	)
const html = (title = 'Sample') =>
	`<!doctype html><html><head></head><body><article><h1>${title}</h1><div class="post-body"><p>${prose}</p><p>${prose}</p><p>${prose}</p></div></article></body></html>`

describe.skipIf(!hasTestDb)('article preview templates (real Postgres)', () => {
	let app: FastifyInstance
	let projectId: string
	let foreignProjectId: string
	let collectionId: string
	let allowedId: string
	let foreignId: string
	const tokens: Record<string, string> = {}
	const userIds: string[] = []
	let client = 0
	const headers = (role: string, pid = projectId) => ({
		authorization: `Bearer ${tokens[role]}`,
		'x-project-id': pid,
	})
	const path = (id = collectionId) => `/api/v1/collections/${id}/preview-template`
	const post = (url = PAGE, extra: Record<string, unknown> = {}) =>
		app.inject({
			method: 'POST',
			remoteAddress: `192.0.2.${client}`,
			url: path(),
			headers: headers('admin'),
			payload: { url, ...extra },
		})

	beforeAll(async () => {
		app = await buildTestApp()
		const suffix = randomUUID().slice(0, 8)
		const members: Array<{ userId: string; role: 'admin' | 'editor' | 'viewer' }> = []
		for (const role of ['admin', 'editor', 'viewer', 'restricted']) {
			const [user] = await app.db
				.insert(users)
				.values({ email: `preview-${role}-${suffix}@example.com`, name: role, role: 'editor' })
				.returning()
			userIds.push(user.id)
			tokens[role] = await createJwt({ id: user.id, email: user.email, name: role, role: 'editor' })
			members.push({
				userId: user.id,
				role: role === 'restricted' ? 'viewer' : (role as 'admin' | 'editor' | 'viewer'),
			})
		}
		const [project] = await app.db
			.insert(projects)
			.values({ name: 'Preview', slug: `preview-${suffix}`, ownerId: userIds[0] })
			.returning()
		projectId = project.id
		const memberships = await app.db
			.insert(projectMembers)
			.values(members.map((member) => ({ ...member, projectId })))
			.returning()
		const [foreign] = await app.db
			.insert(projects)
			.values({ name: 'Foreign', slug: `preview-foreign-${suffix}`, ownerId: userIds[0] })
			.returning()
		foreignProjectId = foreign.id
		const rows = await app.db
			.insert(collections)
			.values([
				{
					projectId,
					name: 'articles',
					label: 'Articles',
					settings: { publicUrlTemplate: 'https://example.com/blog/{slug}/{locale}/' },
				},
				{ projectId, name: 'allowed', label: 'Allowed' },
				{ projectId: foreignProjectId, name: 'foreign', label: 'Foreign' },
			])
			.returning()
		collectionId = rows[0].id
		allowedId = rows[1].id
		foreignId = rows[2].id
		await app.db
			.insert(projectMemberCollections)
			.values({ memberId: memberships[3].id, collectionId: allowedId })
		await app.db.insert(content).values({
			projectId,
			collectionId,
			slug: 'sample',
			locale: 'en',
			metadata: { title: 'Known heading' },
			markdown: prose,
		})
	}, 30_000)
	beforeEach(() => {
		client++
		validatePublicUrl.mockReset().mockResolvedValue(null)
		safeFetch
			.mockReset()
			.mockImplementation(
				async () => new Response(html(), { headers: { 'content-type': 'text/html' } }),
			)
	})
	afterAll(async () => {
		if (app) {
			if (projectId) await app.db.delete(projects).where(eq(projects.id, projectId))
			if (foreignProjectId) await app.db.delete(projects).where(eq(projects.id, foreignProjectId))
			for (const id of userIds) await app.db.delete(users).where(eq(users.id, id))
			await app.close()
		}
	})

	it('allows viewer/editor reads and denies editor/viewer writes before fetching', async () => {
		for (const role of ['viewer', 'editor']) {
			expect((await app.inject({ url: path(), headers: headers(role) })).statusCode).toBe(200)
			expect(
				(
					await app.inject({
						method: 'POST',
						url: path(),
						headers: headers(role),
						payload: { url: PAGE },
					})
				).statusCode,
			).toBe(403)
			expect(
				(await app.inject({ method: 'DELETE', url: path(), headers: headers(role) })).statusCode,
			).toBe(403)
		}
		expect(safeFetch).not.toHaveBeenCalled()
	})
	it('requires authentication/project tenancy and collection membership', async () => {
		expect((await app.inject({ url: path() })).statusCode).toBe(401)
		for (const method of ['GET', 'POST', 'DELETE'] as const) {
			const result = await app.inject({
				method,
				url: path(foreignId),
				headers: headers('admin'),
				...(method === 'POST' ? { payload: { url: PAGE } } : {}),
			})
			expect(result.statusCode).toBe(404)
		}
		expect((await app.inject({ url: path(), headers: headers('restricted') })).statusCode).toBe(403)
		expect(
			(await app.inject({ url: path(allowedId), headers: headers('restricted') })).statusCode,
		).toBe(200)
		expect(safeFetch).not.toHaveBeenCalled()
	})
	it('captures, persists selectors/actor, replaces atomically, and deletes idempotently', async () => {
		const first = await post(PAGE, { selectors: { body: '.post-body' } })
		expect(first.statusCode).toBe(200)
		expect(first.json().template).toMatchObject({
			collectionId,
			sourceUrl: PAGE,
			selectors: { body: '.post-body' },
		})
		const [stored] = await app.db
			.select()
			.from(collectionPreviewTemplates)
			.where(eq(collectionPreviewTemplates.collectionId, collectionId))
		expect(stored.html).toBe(first.json().template.html)
		expect(stored.capturedBy).toBe(userIds[0])
		safeFetch.mockImplementation(
			async () => new Response(html('Replacement'), { headers: { 'content-type': 'text/html' } }),
		)
		const replacement = await post('https://example.com/another')
		expect(replacement.statusCode).toBe(200)
		expect(replacement.json().template.selectors).toBeNull()
		expect(replacement.json().template.html).toContain('Replacement')
		const read = await app.inject({ url: path(), headers: headers('viewer') })
		expect(read.json().template).toEqual(replacement.json().template)
		const rows = await app.db
			.select()
			.from(collectionPreviewTemplates)
			.where(eq(collectionPreviewTemplates.collectionId, collectionId))
		expect(rows).toHaveLength(1)
		for (let i = 0; i < 2; i++)
			expect(
				(await app.inject({ method: 'DELETE', url: path(), headers: headers('admin') })).statusCode,
			).toBe(204)
		expect((await app.inject({ url: path(), headers: headers('viewer') })).json()).toEqual({
			template: null,
		})
	})
	it('preserves saved state after failed recapture and rejects malformed input before fetching', async () => {
		const saved = await post()
		expect(saved.statusCode).toBe(200)
		safeFetch.mockRejectedValue(new Error('network unavailable'))
		const failed = await post()
		expect(failed.statusCode).toBe(502)
		expect(failed.json().code).toBe('FETCH_FAILED')
		expect((await app.inject({ url: path(), headers: headers('viewer') })).json()).toEqual(
			saved.json(),
		)
		safeFetch.mockClear()
		expect((await post(PAGE, { selectors: { body: 3 } })).statusCode).toBe(400)
		expect(
			(await app.inject({ url: path('not-a-uuid'), headers: headers('viewer') })).statusCode,
		).toBe(400)
		expect(safeFetch).not.toHaveBeenCalled()
	})
	it('uses matching collection record hints and ignores hints for an unrelated URL', async () => {
		safeFetch.mockImplementation(
			async () =>
				new Response(html().replace('<h1>Sample</h1>', '<h1>Other</h1><h1>Known heading</h1>'), {
					headers: { 'content-type': 'text/html' },
				}),
		)
		const matched = await post()
		expect(matched.statusCode).toBe(200)
		expect(matched.json().template.slots.title.strategy).toBe('record-match')
		const unrelated = await post('https://elsewhere.example/blog/sample/en/')
		expect(unrelated.statusCode).toBe(200)
		expect(unrelated.json().template.slots.title.strategy).not.toBe('record-match')
	})
	it('keeps one complete row under simultaneous recaptures', async () => {
		const results = await Promise.all([
			post('https://example.com/a'),
			post('https://example.com/b'),
		])
		expect(results.map((result) => result.statusCode)).toEqual([200, 200])
		const rows = await app.db
			.select()
			.from(collectionPreviewTemplates)
			.where(and(eq(collectionPreviewTemplates.collectionId, collectionId)))
		expect(rows).toHaveLength(1)
		expect(
			results.some(
				(result) =>
					result.json().template.html === rows[0].html &&
					result.json().template.sourceUrl === rows[0].sourceUrl,
			),
		).toBe(true)
	})
})
