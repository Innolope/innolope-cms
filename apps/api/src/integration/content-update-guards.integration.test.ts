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

/**
 * PUT /content/:id and PUT /content/bulk must respect the same rules as the
 * create and publish routes: the review workflow, collection identity, the
 * project's locales, slug uniqueness and body/html consistency.
 */
describe.skipIf(!hasTestDb)('content update guards (real Postgres)', () => {
	let app: FastifyInstance
	let projectId: string
	let ownerId: string
	let editorId: string
	let viewerId: string
	let colA: string
	let colB: string
	let ownerToken: string
	let editorToken: string
	let viewerToken: string
	const cleanupUsers: string[] = []

	const as = (token: string) => ({ authorization: `Bearer ${token}`, 'x-project-id': projectId })

	async function create(token: string, body: Record<string, unknown>) {
		const res = await app.inject({
			method: 'POST',
			url: '/api/v1/content',
			headers: as(token),
			payload: body,
		})
		expect(res.statusCode).toBe(201)
		return res.json().id as string
	}

	beforeAll(async () => {
		app = await buildTestApp()
		const short = randomUUID().slice(0, 8)
		const [owner] = await app.db
			.insert(users)
			.values({ email: `cu-o-${short}@example.com`, name: 'O', role: 'editor' })
			.returning()
		const [editor] = await app.db
			.insert(users)
			.values({ email: `cu-e-${short}@example.com`, name: 'E', role: 'editor' })
			.returning()
		const [viewer] = await app.db
			.insert(users)
			.values({ email: `cu-v-${short}@example.com`, name: 'V', role: 'editor' })
			.returning()
		ownerId = owner.id
		editorId = editor.id
		viewerId = viewer.id
		cleanupUsers.push(owner.id, editor.id, viewer.id)
		const [p] = await app.db
			.insert(projects)
			.values({
				name: 'CU',
				slug: `cu-${short}`,
				ownerId,
				settings: { locales: ['en', 'ua'], defaultLocale: 'en', requireReview: true },
			})
			.returning()
		projectId = p.id
		const [mOwner] = await app.db
			.insert(projectMembers)
			.values({ projectId, userId: ownerId, role: 'owner' })
			.returning()
		const [mEditor] = await app.db
			.insert(projectMembers)
			.values({ projectId, userId: editorId, role: 'editor', canPublishDirectly: false })
			.returning()
		const [mViewer] = await app.db
			.insert(projectMembers)
			.values({ projectId, userId: viewerId, role: 'viewer' })
			.returning()
		void mOwner
		const [a] = await app.db
			.insert(collections)
			.values({
				projectId,
				name: `a_${short}`,
				label: 'A',
				fields: [{ name: 'title', type: 'text' }],
			})
			.returning()
		const [b] = await app.db
			.insert(collections)
			.values({
				projectId,
				name: `b_${short}`,
				label: 'B',
				fields: [{ name: 'title', type: 'text' }],
			})
			.returning()
		colA = a.id
		colB = b.id
		await app.db.insert(projectMemberCollections).values([
			{ memberId: mEditor.id, collectionId: colA },
			{ memberId: mViewer.id, collectionId: colA },
		])
		ownerToken = await createJwt({ id: ownerId, email: owner.email, name: 'O', role: 'editor' })
		editorToken = await createJwt({ id: editorId, email: editor.email, name: 'E', role: 'editor' })
		viewerToken = await createJwt({ id: viewerId, email: viewer.email, name: 'V', role: 'editor' })
	})

	afterAll(async () => {
		await app.db.delete(projects).where(eq(projects.id, projectId))
		for (const id of cleanupUsers) await app.db.delete(users).where(eq(users.id, id))
		await app?.close()
	})

	it('PUT cannot publish past the review gate', async () => {
		const id = await create(editorToken, {
			collectionId: colA,
			slug: `rv-${randomUUID().slice(0, 6)}`,
			metadata: { title: 't' },
			status: 'draft',
		})
		const res = await app.inject({
			method: 'PUT',
			url: `/api/v1/content/${id}`,
			headers: as(editorToken),
			payload: { status: 'published' },
		})
		expect(res.statusCode).toBe(403)
		const bulk = await app.inject({
			method: 'PUT',
			url: '/api/v1/content/bulk',
			headers: as(editorToken),
			payload: { items: [{ id, status: 'published' }] },
		})
		expect(bulk.statusCode).toBe(400)
		const [row] = await app.db.select().from(content).where(eq(content.id, id))
		expect(row.status).toBe('draft')
	})

	it('PUT cannot move a record into another collection', async () => {
		const id = await create(editorToken, {
			collectionId: colA,
			slug: `mv-${randomUUID().slice(0, 6)}`,
			metadata: { title: 't' },
		})
		const res = await app.inject({
			method: 'PUT',
			url: `/api/v1/content/${id}`,
			headers: as(editorToken),
			payload: { collectionId: colB },
		})
		expect(res.statusCode).toBe(400)
		const [row] = await app.db.select().from(content).where(eq(content.id, id))
		expect(row.collectionId).toBe(colA)
	})

	it('PUT validates the locale and the slug/locale identity', async () => {
		const slug = `sl-${randomUUID().slice(0, 6)}`
		const id = await create(ownerToken, { collectionId: colA, slug, metadata: { title: 't' } })
		const other = await create(ownerToken, {
			collectionId: colA,
			slug: `${slug}-2`,
			metadata: { title: 't' },
		})
		const badLocale = await app.inject({
			method: 'PUT',
			url: `/api/v1/content/${id}`,
			headers: as(ownerToken),
			payload: { locale: 'uk' },
		})
		expect(badLocale.statusCode).toBe(400)
		const clash = await app.inject({
			method: 'PUT',
			url: `/api/v1/content/${other}`,
			headers: as(ownerToken),
			payload: { slug },
		})
		expect(clash.statusCode).toBe(409)
	})

	it('clearing the markdown clears the rendered html too', async () => {
		const id = await create(ownerToken, {
			collectionId: colA,
			slug: `md-${randomUUID().slice(0, 6)}`,
			metadata: { title: 't' },
			markdown: '# Secret',
		})
		const res = await app.inject({
			method: 'PUT',
			url: `/api/v1/content/${id}`,
			headers: as(ownerToken),
			payload: { markdown: '' },
		})
		expect(res.statusCode).toBe(200)
		const [row] = await app.db.select().from(content).where(eq(content.id, id))
		expect(row.markdown).toBe('')
		expect(row.html ?? '').not.toContain('Secret')
	})

	it('PUT /bulk strips frontmatter like every other write path', async () => {
		const id = await create(ownerToken, {
			collectionId: colA,
			slug: `fm-${randomUUID().slice(0, 6)}`,
			metadata: { title: 'old' },
		})
		const res = await app.inject({
			method: 'PUT',
			url: '/api/v1/content/bulk',
			headers: as(ownerToken),
			payload: { items: [{ id, markdown: '---\ntitle: New title\n---\n\nBody text' }] },
		})
		expect(res.statusCode).toBe(200)
		const [row] = await app.db.select().from(content).where(eq(content.id, id))
		expect(row.markdown).toBe('Body text')
		expect((row.metadata as Record<string, unknown>).title).toBe('New title')
	})

	it('stats and scheduling lists respect the collection allowlist', async () => {
		await create(ownerToken, {
			collectionId: colB,
			slug: `secret-${randomUUID().slice(0, 6)}`,
			metadata: { title: 'TOP SECRET B' },
		})
		await create(ownerToken, {
			collectionId: colB,
			slug: `sched-${randomUUID().slice(0, 6)}`,
			metadata: { title: 'SCHEDULED B SECRET' },
			status: 'scheduled',
			publishedAt: new Date(Date.now() + 86_400_000).toISOString(),
		})
		const recent = await app.inject({
			method: 'GET',
			url: '/api/v1/stats/recent',
			headers: as(viewerToken),
		})
		expect(recent.statusCode).toBe(200)
		expect(JSON.stringify(recent.json())).not.toContain('TOP SECRET B')
		const scheduled = await app.inject({
			method: 'GET',
			url: '/api/v1/ee/scheduling/scheduled',
			headers: as(viewerToken),
		})
		expect(scheduled.statusCode).toBe(200)
		expect(JSON.stringify(scheduled.json())).not.toContain('SCHEDULED B SECRET')
		const ownerRecent = await app.inject({
			method: 'GET',
			url: '/api/v1/stats/recent',
			headers: as(ownerToken),
		})
		expect(JSON.stringify(ownerRecent.json())).toContain('TOP SECRET B')
	})

	it('malformed date filters are a 400, not a 500', async () => {
		const res = await app.inject({
			method: 'GET',
			url: '/api/v1/content?updatedFrom=abc',
			headers: as(ownerToken),
		})
		expect(res.statusCode).toBe(400)
	})
})
