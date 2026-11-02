import { randomUUID } from 'node:crypto'
import {
	collections,
	content,
	externalSyncState,
	projectMembers,
	projects,
	users,
} from '@innolope/db'
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createJwt } from '../plugins/auth.js'
import { buildTestApp, hasTestDb } from '../test/harness.js'

describe.skipIf(!hasTestDb)('editor improvements: independent HTTP acceptance', () => {
	let app: Awaited<ReturnType<typeof buildTestApp>>
	let userId = ''
	let strangerId = ''
	let projectId = ''
	let otherProjectId = ''
	let collectionId = ''
	let otherCollectionId = ''
	let foreignCollectionId = ''
	let conflictId = ''
	let legacyId = ''
	let headers: Record<string, string>
	let strangerHeaders: Record<string, string>
	const token = 'acceptance-current-token'
	const longCms = `${'unchanged paragraph\n'.repeat(400)}CMS terminal edit`
	const longExternal = `${'unchanged paragraph\n'.repeat(400)}External terminal edit`
	const unique = randomUUID()

	beforeAll(async () => {
		app = await buildTestApp()
		const [owner, stranger] = await app.db
			.insert(users)
			.values([
				{ email: `editor-owner-${unique}@example.test`, name: 'Editor owner', role: 'editor' },
				{ email: `editor-stranger-${unique}@example.test`, name: 'Stranger', role: 'editor' },
			])
			.returning()
		if (!owner || !stranger) throw new Error('Acceptance users were not created')
		userId = owner.id
		strangerId = stranger.id
		const [project, foreign] = await app.db
			.insert(projects)
			.values([
				{ name: 'Editor acceptance', slug: `editor-${unique}`, ownerId: owner.id },
				{ name: 'Foreign acceptance', slug: `foreign-${unique}`, ownerId: stranger.id },
			])
			.returning()
		if (!project || !foreign) throw new Error('Acceptance projects were not created')
		projectId = project.id
		otherProjectId = foreign.id
		await app.db.insert(projectMembers).values([
			{ projectId, userId, role: 'owner' },
			{ projectId: otherProjectId, userId: strangerId, role: 'owner' },
		])
		const [main, adjacent, foreignCollection] = await app.db
			.insert(collections)
			.values([
				{ projectId, name: `main-${unique}`, label: 'Main', fields: [] },
				{ projectId, name: `adjacent-${unique}`, label: 'Adjacent', fields: [] },
				{ projectId: otherProjectId, name: `foreign-${unique}`, label: 'Foreign', fields: [] },
			])
			.returning()
		if (!main || !adjacent || !foreignCollection) throw new Error('Acceptance collections missing')
		collectionId = main.id
		otherCollectionId = adjacent.id
		foreignCollectionId = foreignCollection.id
		const [current, legacy] = await app.db
			.insert(content)
			.values([
				{
					projectId,
					collectionId,
					slug: `current-${unique}`,
					markdown: longCms,
					metadata: {
						tags: ['  Alpha  ', 'alphabet', 'ALPHABET', 'a%b literal', 'a_b literal', '😀😀😀 tag'],
					},
				},
				{
					projectId,
					collectionId,
					slug: `legacy-${unique}`,
					markdown: 'legacy',
					metadata: { tags: ['Alpha', ' axb decoy '] },
				},
				{
					projectId,
					collectionId,
					slug: `malformed-${unique}`,
					markdown: '',
					metadata: { tags: { unexpected: 'Alpha leaked object' } },
				},
				{
					projectId,
					collectionId,
					slug: `mixed-${unique}`,
					markdown: '',
					metadata: { tags: [null, 42, { label: 'Alpha leaked object' }, 'Alpha valid', ''] },
				},
				{
					projectId,
					collectionId: otherCollectionId,
					slug: `adjacent-${unique}`,
					markdown: '',
					metadata: { tags: ['Alpha adjacent secret'] },
				},
				{
					projectId: otherProjectId,
					collectionId: foreignCollectionId,
					slug: `foreign-${unique}`,
					markdown: '',
					metadata: { tags: ['Alpha foreign secret'] },
				},
				{
					projectId,
					collectionId,
					slug: `bounded-${unique}`,
					markdown: '',
					metadata: {
						tags: Array.from(
							{ length: 24 },
							(_, index) => `limit-tag-${String(index).padStart(2, '0')}`,
						),
					},
				},
			])
			.returning()
		if (!current || !legacy) throw new Error('Acceptance content missing')
		conflictId = current.id
		legacyId = legacy.id
		await app.db.insert(externalSyncState).values({
			collectionId,
			conflicts: [
				{
					contentId: conflictId,
					externalId: `external-${unique}`,
					slug: current.slug,
					metadata: {},
					token,
					categories: ['content'],
					fullComparison: true,
					local: { markdown: longCms, metadata: { title: 'CMS' }, status: 'draft' },
					external: {
						markdown: longExternal,
						metadata: { title: 'External' },
						status: 'published',
					},
				},
				{
					contentId: legacyId,
					externalId: `legacy-${unique}`,
					slug: legacy.slug,
					metadata: {},
					token: 'legacy-token',
					categories: ['content'],
					local: { markdown: 'truncated preview', metadata: {}, status: 'draft' },
					external: { markdown: 'other truncated preview', metadata: {}, status: 'draft' },
				},
			],
		})
		headers = {
			authorization: `Bearer ${await createJwt({ id: owner.id, email: owner.email, name: owner.name, role: 'editor' })}`,
			'x-project-id': projectId,
		}
		strangerHeaders = {
			authorization: `Bearer ${await createJwt({ id: stranger.id, email: stranger.email, name: stranger.name, role: 'editor' })}`,
			'x-project-id': otherProjectId,
		}
	})

	afterAll(async () => {
		if (!app) return
		for (const id of [projectId, otherProjectId]) {
			if (id) await app.db.delete(projects).where(eq(projects.id, id))
		}
		for (const id of [userId, strangerId]) {
			if (id) await app.db.delete(users).where(eq(users.id, id))
		}
		await app.close()
	})

	const suggestionsUrl = (query: string, id = collectionId) =>
		`/api/v1/collections/${id}/tag-suggestions?q=${encodeURIComponent(query)}`
	const detailsUrl = (requestedToken: string, id = conflictId) =>
		`/api/v1/collections/${collectionId}/sync-conflicts/${id}?token=${encodeURIComponent(requestedToken)}`

	it('returns complete stored comparison including edits far beyond the preview', async () => {
		const response = await app.inject({ method: 'GET', url: detailsUrl(token), headers })
		expect(response.statusCode).toBe(200)
		// The contract permits an envelope, but never a shortened body.
		const serialized = JSON.stringify(response.json())
		expect(serialized).toContain(JSON.stringify(longCms).slice(1, -1))
		expect(serialized).toContain(JSON.stringify(longExternal).slice(1, -1))
	})

	it('rejects a stale choice token and identifies legacy incomplete comparisons', async () => {
		const stale = await app.inject({ method: 'GET', url: detailsUrl('stale-token'), headers })
		expect(stale.statusCode).toBe(409)
		expect(JSON.stringify(stale.json())).not.toContain('CMS terminal edit')
		const legacy = await app.inject({
			method: 'GET',
			url: detailsUrl('legacy-token', legacyId),
			headers,
		})
		expect(legacy.statusCode).toBe(409)
		expect(JSON.stringify(legacy.json())).toContain('SYNC_DETAILS_PENDING')
	})

	it('denies unauthenticated and cross-project conflict reads', async () => {
		const anonymous = await app.inject({ method: 'GET', url: detailsUrl(token) })
		expect(anonymous.statusCode).toBe(401)
		const foreign = await app.inject({
			method: 'GET',
			url: detailsUrl(token),
			headers: strangerHeaders,
		})
		expect([403, 404]).toContain(foreign.statusCode)
		expect(JSON.stringify(foreign.json())).not.toContain('CMS terminal edit')
	})

	it('normalizes queries and tags, safely ignores malformed data, and stays within the collection', async () => {
		const response = await app.inject({ method: 'GET', url: suggestionsUrl('  ALP  '), headers })
		expect(response.statusCode).toBe(200)
		const values = response.json<{ suggestions: string[] }>().suggestions
		expect(values).toContain('Alpha')
		expect(values).toContain('Alpha valid')
		expect(values.some((value) => value.toLowerCase() === 'alphabet')).toBe(true)
		expect(values.every((value) => typeof value === 'string' && value === value.trim())).toBe(true)
		expect(values).not.toContain('Alpha adjacent secret')
		expect(values).not.toContain('Alpha foreign secret')
		expect(values).not.toContain('Alpha leaked object')
	})

	it('treats SQL wildcard characters literally', async () => {
		for (const [query, expected] of [
			['a%b', 'a%b literal'],
			['a_b', 'a_b literal'],
		]) {
			const response = await app.inject({ method: 'GET', url: suggestionsUrl(query), headers })
			expect(response.statusCode).toBe(200)
			expect(response.json()).toEqual({ suggestions: [expected] })
		}
	})

	it('counts Unicode codepoints after trimming and bounds query length', async () => {
		for (const query of ['', '  ab  ', '😀😀']) {
			const response = await app.inject({ method: 'GET', url: suggestionsUrl(query), headers })
			expect(response.statusCode).toBe(200)
			expect(response.json()).toEqual({ suggestions: [] })
		}
		const unicode = await app.inject({ method: 'GET', url: suggestionsUrl('😀😀😀'), headers })
		expect(unicode.statusCode).toBe(200)
		expect(unicode.json()).toEqual({ suggestions: ['😀😀😀 tag'] })
		const overLimit = await app.inject({
			method: 'GET',
			url: suggestionsUrl('x'.repeat(121)),
			headers,
		})
		expect(overLimit.statusCode).toBe(400)
	})

	it('returns a deterministic maximum of ten suggestions', async () => {
		const first = await app.inject({ method: 'GET', url: suggestionsUrl('limit-tag'), headers })
		const second = await app.inject({ method: 'GET', url: suggestionsUrl('limit-tag'), headers })
		expect(first.statusCode).toBe(200)
		expect(second.statusCode).toBe(200)
		expect(first.json<{ suggestions: string[] }>().suggestions).toHaveLength(10)
		expect(second.json()).toEqual(first.json())
	})

	it('denies unauthenticated and cross-project tag discovery', async () => {
		const anonymous = await app.inject({ method: 'GET', url: suggestionsUrl('Alpha') })
		expect(anonymous.statusCode).toBe(401)
		const foreign = await app.inject({
			method: 'GET',
			url: suggestionsUrl('Alpha', foreignCollectionId),
			headers,
		})
		expect([403, 404]).toContain(foreign.statusCode)
		expect(JSON.stringify(foreign.json())).not.toContain('Alpha foreign secret')
	})
})
