import { randomUUID } from 'node:crypto'
import {
	collections,
	content,
	contentVersions,
	projectMembers,
	projects,
	users,
} from '@innolope/db'
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createJwt } from '../plugins/auth.js'
import { buildTestApp, hasTestDb } from '../test/harness.js'

const hashPattern = /^sha256:[a-f0-9]{64}$/

describe.skipIf(!hasTestDb)('agent content hash acceptance', () => {
	let app: Awaited<ReturnType<typeof buildTestApp>>
	let userId: string
	let projectId: string
	let collectionId: string
	let foreignProjectId: string
	let foreignCollectionId: string
	let token: string
	const events: unknown[] = []
	let unsubscribe: (() => void) | undefined
	const headers = (agent = true, project = projectId) => ({
		authorization: `Bearer ${token}`,
		'x-project-id': project,
		...(agent ? { 'x-innolope-client': 'mcp' } : {}),
	})
	const create = async (collection = collectionId, project = projectId) => {
		const response = await app.inject({
			method: 'POST',
			url: '/api/v1/content',
			headers: headers(true, project),
			payload: {
				collectionId: collection,
				slug: `hash-${randomUUID()}`,
				markdown: 'Original body',
				metadata: { title: 'Original' },
			},
		})
		expect(response.statusCode).toBe(201)
		return response.json()
	}
	const read = async (id: string) => {
		const response = await app.inject({
			method: 'GET',
			url: `/api/v1/content/${id}`,
			headers: headers(),
		})
		expect(response.statusCode).toBe(200)
		return response.json()
	}
	const snapshot = async (id: string) => ({
		row: await app.db.select().from(content).where(eq(content.id, id)),
		history: await app.db.select().from(contentVersions).where(eq(contentVersions.contentId, id)),
	})
	const put = (id: string, payload: Record<string, unknown>, agent = true) =>
		app.inject({
			method: 'PUT',
			url: `/api/v1/content/${id}`,
			headers: headers(agent),
			payload,
		})
	const expectCode = (
		response: { statusCode: number; json: () => unknown },
		status: number,
		code: string,
	) => {
		expect(response.statusCode).toBe(status)
		expect(JSON.stringify(response.json())).toContain(code)
	}

	beforeAll(async () => {
		app = await buildTestApp()
		const suffix = randomUUID()
		const [user] = await app.db
			.insert(users)
			.values({ email: `hash-${suffix}@example.test`, name: 'Hash acceptance', role: 'admin' })
			.returning()
		userId = user.id
		token = await createJwt({ id: user.id, email: user.email, name: user.name, role: 'admin' })
		const [project] = await app.db
			.insert(projects)
			.values({ name: 'Hash acceptance', slug: `hash-${suffix}`, ownerId: user.id })
			.returning()
		projectId = project.id
		await app.db.insert(projectMembers).values({ projectId, userId, role: 'admin' })
		const [collection] = await app.db
			.insert(collections)
			.values({
				projectId,
				name: `hash_${suffix.replaceAll('-', '')}`,
				label: 'Hash records',
				fields: [{ name: 'title', type: 'text' }],
			})
			.returning()
		collectionId = collection.id
		const [foreign] = await app.db
			.insert(projects)
			.values({ name: 'Other hash project', slug: `other-hash-${suffix}`, ownerId: user.id })
			.returning()
		foreignProjectId = foreign.id
		await app.db
			.insert(projectMembers)
			.values({ projectId: foreignProjectId, userId, role: 'admin' })
		const [foreignCollection] = await app.db
			.insert(collections)
			.values({
				projectId: foreignProjectId,
				name: `foreign_${suffix.replaceAll('-', '')}`,
				label: 'Other records',
				fields: [{ name: 'title', type: 'text' }],
			})
			.returning()
		foreignCollectionId = foreignCollection.id
		unsubscribe = app.events.subscribe((event: unknown) => {
			events.push(event)
		})
	})

	afterAll(async () => {
		unsubscribe?.()
		if (!app) return
		if (foreignProjectId) await app.db.delete(projects).where(eq(projects.id, foreignProjectId))
		if (projectId) await app.db.delete(projects).where(eq(projects.id, projectId))
		if (userId) await app.db.delete(users).where(eq(users.id, userId))
		await app.close()
	})

	it('returns stable hashes and fresh hashes after successful updates, including change then revert', async () => {
		const created = await create()
		const original = await read(created.id)
		expect(original.contentHash).toMatch(hashPattern)
		expect((await read(created.id)).contentHash).toBe(original.contentHash)
		const changed = await put(created.id, {
			expectedHash: original.contentHash,
			markdown: 'Changed body',
		})
		expect(changed.statusCode).toBe(200)
		expect(changed.json().contentHash).toMatch(hashPattern)
		expect(changed.json().contentHash).not.toBe(original.contentHash)
		const reverted = await put(created.id, {
			expectedHash: changed.json().contentHash,
			markdown: 'Original body',
		})
		expect(reverted.statusCode).toBe(200)
		expect(reverted.json().contentHash).not.toBe(original.contentHash)
		expectCode(
			await put(created.id, { expectedHash: original.contentHash, markdown: 'Replay' }),
			409,
			'CONTENT_CONFLICT',
		)
	})

	it('requires hashes on agent updates and rejects malformed hashes without stored or event effects', async () => {
		const record = await create()
		const before = await snapshot(record.id)
		const eventCount = events.length
		expectCode(await put(record.id, { markdown: 'Missing hash' }), 428, 'CONTENT_HASH_REQUIRED')
		for (const expectedHash of [
			null,
			1,
			{},
			'',
			'*',
			'sha256:abc',
			`sha256:${'A'.repeat(64)}`,
			`sha256:${'a'.repeat(65)}`,
			'x'.repeat(4096),
		]) {
			expect((await put(record.id, { expectedHash, markdown: 'Invalid hash' })).statusCode).toBe(
				400,
			)
		}
		expect(await snapshot(record.id)).toEqual(before)
		expect(events.length).toBe(eventCount)
	})

	it('enforces supplied hashes without an agent marker and preserves unguarded human edits', async () => {
		const record = await create()
		const first = await read(record.id)
		expect((await put(record.id, { markdown: 'Human change' }, false)).statusCode).toBe(200)
		expectCode(
			await put(
				record.id,
				{ expectedHash: first.contentHash, markdown: 'Stale human change' },
				false,
			),
			409,
			'CONTENT_CONFLICT',
		)
	})

	it('keeps expectedVersion checks conjunctive with a valid hash', async () => {
		const record = await read((await create()).id)
		const before = await snapshot(record.id)
		const response = await put(record.id, {
			expectedHash: record.contentHash,
			expectedVersion: -1,
			markdown: 'Version mismatch',
		})
		expect([400, 409]).toContain(response.statusCode)
		expect(await snapshot(record.id)).toEqual(before)
	})

	it.each([
		true,
		false,
	])('allows exactly one simultaneous same-hash writer (second agent=%s)', async (secondAgent) => {
		const record = await read((await create()).id)
		const before = await snapshot(record.id)
		const results = await Promise.all([
			put(record.id, { expectedHash: record.contentHash, markdown: 'Writer A' }),
			put(record.id, { expectedHash: record.contentHash, markdown: 'Writer B' }, secondAgent),
		])
		expect(results.map((result) => result.statusCode).sort()).toEqual([200, 409])
		expect((await snapshot(record.id)).history.length).toBe(before.history.length + 1)
		const winner = results.find((result) => result.statusCode === 200)
		if (!winner) throw new Error('Expected a successful simultaneous writer')
		expect((await read(record.id)).contentHash).toBe(winner.json().contentHash)
	})

	it('rejects stale bulk items atomically and dry-run does not reserve hashes', async () => {
		const first = await read((await create()).id)
		const second = await read((await create()).id)
		const items = [first, second].map((record) => ({
			id: record.id,
			expectedHash: record.contentHash,
			markdown: 'Bulk change',
		}))
		const dryRun = await app.inject({
			method: 'PUT',
			url: '/api/v1/content/bulk',
			headers: headers(),
			payload: { items, dryRun: true },
		})
		expect(dryRun.statusCode).toBe(200)
		expect(dryRun.json()).toMatchObject({ dryRun: true, valid: 2, total: 2 })
		expect((await read(first.id)).contentHash).toBe(first.contentHash)
		expect(
			(await put(second.id, { expectedHash: second.contentHash, markdown: 'Intervening write' }))
				.statusCode,
		).toBe(200)
		const before = await Promise.all([snapshot(first.id), snapshot(second.id)])
		const eventCount = events.length
		const bulk = await app.inject({
			method: 'PUT',
			url: '/api/v1/content/bulk',
			headers: headers(),
			payload: { items },
		})
		expectCode(bulk, 409, 'CONTENT_CONFLICT')
		expect(await Promise.all([snapshot(first.id), snapshot(second.id)])).toEqual(before)
		expect(events.length).toBe(eventCount)
	})

	it('requires every bulk hash and rejects duplicate IDs and oversized batches without effects', async () => {
		const record = await read((await create()).id)
		const before = await snapshot(record.id)
		const item = { id: record.id, expectedHash: record.contentHash, markdown: 'Bulk mutation' }
		const bulk = (items: unknown[]) =>
			app.inject({
				method: 'PUT',
				url: '/api/v1/content/bulk',
				headers: headers(),
				payload: { items },
			})
		expectCode(await bulk([{ id: record.id, markdown: 'No hash' }]), 428, 'CONTENT_HASH_REQUIRED')
		expect((await bulk([item, item])).statusCode).toBe(400)
		expect(
			(
				await bulk(
					Array.from({ length: 51 }, (_, index) => ({
						...item,
						id: index === 0 ? record.id : randomUUID(),
					})),
				)
			).statusCode,
		).toBe(400)
		expect(await snapshot(record.id)).toEqual(before)
	})

	it('guards publishing and deletion, and successful publish returns a fresh hash', async () => {
		const record = await read((await create()).id)
		const publish = (payload: unknown) =>
			app.inject({
				method: 'POST',
				url: `/api/v1/content/${record.id}/publish`,
				headers: headers(),
				payload,
			})
		expectCode(await publish({}), 428, 'CONTENT_HASH_REQUIRED')
		const published = await publish({ expectedHash: record.contentHash })
		expect(published.statusCode).toBe(200)
		expect(published.json().contentHash).toMatch(hashPattern)
		expect(published.json().contentHash).not.toBe(record.contentHash)
		expectCode(
			await app.inject({
				method: 'DELETE',
				url: `/api/v1/content/${record.id}`,
				headers: headers(),
			}),
			428,
			'CONTENT_HASH_REQUIRED',
		)
		expectCode(
			await app.inject({
				method: 'DELETE',
				url: `/api/v1/content/${record.id}?expectedHash=${encodeURIComponent(record.contentHash)}`,
				headers: headers(),
			}),
			409,
			'CONTENT_CONFLICT',
		)
		const deleted = await app.inject({
			method: 'DELETE',
			url: `/api/v1/content/${record.id}?expectedHash=${encodeURIComponent(published.json().contentHash)}`,
			headers: headers(),
		})
		expect([200, 204]).toContain(deleted.statusCode)
	})

	it('does not disclose a foreign-project hash or conflict details', async () => {
		const foreign = await create(foreignCollectionId, foreignProjectId)
		for (const response of [
			await app.inject({ method: 'GET', url: `/api/v1/content/${foreign.id}`, headers: headers() }),
			await put(foreign.id, {
				expectedHash: `sha256:${'0'.repeat(64)}`,
				markdown: 'Cross-project mutation',
			}),
		]) {
			expect([403, 404]).toContain(response.statusCode)
			expect(response.body).not.toMatch(/sha256:[a-f0-9]{64}/)
			expect(response.body).not.toContain('CONTENT_CONFLICT')
		}
	})
})
