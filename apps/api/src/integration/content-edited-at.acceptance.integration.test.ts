import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { collections, content, projectMembers, projects, users } from '@innolope/db'
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createJwt } from '../plugins/auth.js'
import { buildTestApp, hasTestDb } from '../test/harness.js'

type ContentResponse = {
	id: string
	contentEditedAt: string | null
	updatedAt: string
	metadata: Record<string, unknown>
}

describe.skipIf(!hasTestDb)('meaningful edit date independent acceptance', () => {
	let app: Awaited<ReturnType<typeof buildTestApp>>
	let userId = ''
	let projectId = ''
	let collectionId = ''
	let headers: Record<string, string>
	const unique = randomUUID()

	beforeAll(async () => {
		app = await buildTestApp()
		const [owner] = await app.db
			.insert(users)
			.values({
				email: `edited-at-${unique}@example.test`,
				name: 'Edit date owner',
				role: 'editor',
			})
			.returning()
		if (!owner) throw new Error('Acceptance owner missing')
		userId = owner.id
		const [project] = await app.db
			.insert(projects)
			.values({
				name: 'Meaningful dates',
				slug: `edited-at-${unique}`,
				ownerId: userId,
				settings: { locales: ['en', 'fr'], defaultLocale: 'en' },
			})
			.returning()
		if (!project) throw new Error('Acceptance project missing')
		projectId = project.id
		await app.db.insert(projectMembers).values({ projectId, userId, role: 'owner' })
		const [collection] = await app.db
			.insert(collections)
			.values({ projectId, name: `edited-at-${unique}`, label: 'Meaningful dates', fields: [] })
			.returning()
		if (!collection) throw new Error('Acceptance collection missing')
		collectionId = collection.id
		headers = {
			authorization: `Bearer ${await createJwt({ id: owner.id, email: owner.email, name: owner.name, role: 'editor' })}`,
			'x-project-id': projectId,
		}
	})

	afterAll(async () => {
		if (!app) return
		if (projectId) await app.db.delete(projects).where(eq(projects.id, projectId))
		if (userId) await app.db.delete(users).where(eq(users.id, userId))
		await app.close()
	})

	async function create(payload: Record<string, unknown> = {}) {
		const response = await app.inject({
			method: 'POST',
			url: '/api/v1/content',
			headers,
			payload: {
				collectionId,
				slug: `entry-${randomUUID()}`,
				markdown: 'Original body',
				metadata: { title: 'Original title' },
				...payload,
			},
		})
		expect(response.statusCode).toBe(201)
		return response.json<ContentResponse>()
	}

	async function read(id: string) {
		const response = await app.inject({ method: 'GET', url: `/api/v1/content/${id}`, headers })
		expect(response.statusCode).toBe(200)
		return response.json<ContentResponse>()
	}

	async function update(id: string, payload: Record<string, unknown>) {
		const response = await app.inject({
			method: 'PUT',
			url: `/api/v1/content/${id}`,
			headers,
			payload,
		})
		expect(response.statusCode).toBe(200)
		return response.json<ContentResponse>()
	}

	function timestamp(record: ContentResponse) {
		expect(typeof record.contentEditedAt).toBe('string')
		const value = Date.parse(record.contentEditedAt ?? '')
		expect(Number.isFinite(value)).toBe(true)
		return value
	}

	async function imported() {
		const [row] = await app.db
			.insert(content)
			.values({
				projectId,
				collectionId,
				slug: `import-${randomUUID()}`,
				markdown: 'Imported body',
				metadata: { title: 'Imported title', updatedAt: '2001-01-01T00:00:00Z', views: 9 },
				externalId: `source-${randomUUID()}`,
				updatedSource: 'import',
			})
			.returning()
		if (!row) throw new Error('Imported acceptance row missing')
		return read(row.id)
	}

	it('starts internal authoring at server time and exposes the date on reads', async () => {
		const before = Date.now() - 1000
		const created = await create({ contentEditedAt: '2099-01-01T00:00:00.000Z' })
		expect(timestamp(created)).toBeGreaterThanOrEqual(before)
		expect(timestamp(created)).toBeLessThanOrEqual(Date.now() + 1000)
		expect((await read(created.id)).contentEditedAt).toBe(created.contentEditedAt)
		const spoofOnly = await update(created.id, { contentEditedAt: '1990-01-01T00:00:00.000Z' })
		expect(spoofOnly.contentEditedAt).toBe(created.contentEditedAt)
	})

	it('keeps imported history unknown until a meaningful edit occurs through a direct writer', async () => {
		const row = await imported()
		expect(row.contentEditedAt).toBeNull()
		await app.db
			.update(content)
			.set({ metadata: { ...row.metadata, views: 10, updatedAt: '2020-01-01T00:00:00Z' } })
			.where(eq(content.id, row.id))
		expect((await read(row.id)).contentEditedAt).toBeNull()
		await app.db
			.update(content)
			.set({ metadata: { ...row.metadata, title: 'Changed externally' } })
			.where(eq(content.id, row.id))
		const changed = await read(row.id)
		expect(timestamp(changed)).toBeGreaterThan(Date.now() - 60_000)
	})

	it('preserves the date on no-ops and every excluded source metadata key', async () => {
		const row = await create()
		const noOp = await update(row.id, {
			markdown: 'Original body',
			metadata: { title: 'Original title' },
		})
		expect(noOp.contentEditedAt).toBe(row.contentEditedAt)
		const excluded = [
			'updatedAt',
			'createdAt',
			'__v',
			'_v',
			'_rev',
			'_version',
			'_etag',
			'etag',
			'views',
			'viewsCount',
			'viewCount',
			'view_count',
			'views_count',
			'lastViewedAt',
			'lastViewed',
			'last_viewed_at',
		]
		let metadata: Record<string, unknown> = { title: 'Original title' }
		for (const key of excluded) {
			metadata = { ...metadata, [key]: key.toLowerCase().includes('view') ? 17 : 'source-value' }
			const saved = await update(row.id, { metadata })
			expect(saved.contentEditedAt, `Only ${key} changed`).toBe(row.contentEditedAt)
		}
	})

	it('advances for all meaningful authoring fields and rejects timestamp spoofing', async () => {
		let row = await create()
		const changes: Record<string, unknown>[] = [
			{ markdown: 'Changed body' },
			{ metadata: { title: 'Changed title' } },
			{ metadata: { title: 'Changed title', tags: ['new topic'] } },
			{
				metadata: {
					title: 'Changed title',
					tags: ['new topic'],
					translations: { fr: { body: 'Nouveau texte' } },
				},
			},
			{ slug: `changed-${randomUUID()}` },
			{ status: 'published' },
			{ locale: 'fr' },
			{ publishedAt: '2020-04-05T10:00:00.000Z' },
			{ createdAt: '2020-04-04T10:00:00.000Z' },
		]
		for (const change of changes) {
			const previous = timestamp(row)
			await delay(5)
			row = await update(row.id, { ...change, contentEditedAt: '2099-01-01T00:00:00.000Z' })
			expect(
				timestamp(row),
				`Meaningful change: ${Object.keys(change).join(', ')}`,
			).toBeGreaterThan(previous)
			expect(timestamp(row)).toBeLessThanOrEqual(Date.now() + 1000)
		}
	})

	it('ignores direct synchronization bookkeeping while retaining legacy updatedAt semantics', async () => {
		const row = await imported()
		await app.db
			.update(content)
			.set({
				externalSnapshot: { status: 'draft', markdown: '', metadata: { title: 'Source snapshot' } },
				updatedAt: new Date('2099-01-01T00:00:00.000Z'),
				version: 12,
			})
			.where(eq(content.id, row.id))
		const reread = await read(row.id)
		expect(reread.contentEditedAt).toBeNull()
		expect(Date.parse(reread.updatedAt)).toBe(Date.parse('2099-01-01T00:00:00.000Z'))
		const response = await app.inject({
			method: 'GET',
			url: `/api/v1/content?collectionId=${collectionId}&updatedFrom=2098-01-01T00%3A00%3A00.000Z`,
			headers,
		})
		expect(response.statusCode).toBe(200)
		expect(response.json<{ data: ContentResponse[] }>().data.map((entry) => entry.id)).toContain(
			row.id,
		)
	})

	it('sorts known dates in both directions with unknown last and filters by meaningful dates', async () => {
		const unknown = await imported()
		const first = await create()
		await delay(5)
		const second = await create()
		expect(timestamp(second)).toBeGreaterThan(timestamp(first))
		for (const direction of ['asc', 'desc']) {
			const response = await app.inject({
				method: 'GET',
				url: `/api/v1/content?collectionId=${collectionId}&sortBy=contentEditedAt&sortOrder=${direction}&limit=100`,
				headers,
			})
			expect(response.statusCode).toBe(200)
			const records = response.json<{ data: ContentResponse[] }>().data
			const firstIndex = records.findIndex((entry) => entry.id === first.id)
			const secondIndex = records.findIndex((entry) => entry.id === second.id)
			const unknownIndex = records.findIndex((entry) => entry.id === unknown.id)
			expect(firstIndex).toBeGreaterThanOrEqual(0)
			expect(secondIndex).toBeGreaterThanOrEqual(0)
			expect(unknownIndex).toBeGreaterThan(firstIndex)
			expect(unknownIndex).toBeGreaterThan(secondIndex)
			if (direction === 'asc') expect(secondIndex).toBeGreaterThan(firstIndex)
			else expect(firstIndex).toBeGreaterThan(secondIndex)
			expect(records.find((entry) => entry.id === first.id)?.contentEditedAt).toBe(
				first.contentEditedAt,
			)
		}
		const boundary = encodeURIComponent(second.contentEditedAt ?? '')
		const filtered = await app.inject({
			method: 'GET',
			url: `/api/v1/content?collectionId=${collectionId}&editedFrom=${boundary}&editedTo=${boundary}`,
			headers,
		})
		expect(filtered.statusCode).toBe(200)
		const ids = filtered.json<{ data: ContentResponse[] }>().data.map((entry) => entry.id)
		expect(ids).toContain(second.id)
		expect(ids).not.toContain(first.id)
		expect(ids).not.toContain(unknown.id)
	})
})
