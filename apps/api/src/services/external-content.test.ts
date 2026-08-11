import type { collections } from '@innolope/db'
import { describe, expect, it } from 'vitest'
import {
	buildExternalData,
	mergeExternalTimestamps,
	stripUnmappedSystemColumns,
} from './external-content.js'

type Collection = typeof collections.$inferSelect

const makeCol = (fields: Array<{ name: string; type: string }>): Collection =>
	({ fields }) as unknown as Collection

describe('buildExternalData', () => {
	it('always carries the slug when provided, even if the collection maps no slug field', () => {
		// Regression: an introspected Mongo collection without a sampled `slug`
		// field used to drop the slug entirely, so a non-sparse unique `slug_1`
		// index collided on `null` from the second insert onward.
		const col = makeCol([{ name: 'title', type: 'text' }])
		const data = buildExternalData(col, { slug: 'my-recipe', metadata: { title: 'My Recipe' } })
		expect(data.slug).toBe('my-recipe')
		expect(data.title).toBe('My Recipe')
	})

	it('omits slug when none was provided', () => {
		const col = makeCol([{ name: 'title', type: 'text' }])
		const data = buildExternalData(col, { metadata: { title: 'No Slug' } })
		expect('slug' in data).toBe(false)
	})

	it('passes all metadata through for a collection introspected while empty', () => {
		const col = makeCol([])
		const data = buildExternalData(col, { slug: 's', metadata: { anything: 1 } })
		expect(data).toMatchObject({ slug: 's', anything: 1 })
	})

	it('drops metadata keys the collection does not map (non-empty schema)', () => {
		const col = makeCol([{ name: 'title', type: 'text' }])
		const data = buildExternalData(col, { metadata: { title: 'T', rogue: true } })
		expect('rogue' in data).toBe(false)
	})

	it('lets a user-supplied createdAt beat the server fallback', () => {
		// Timestamps are editable now, so backdating a post from the editor must
		// reach the external row instead of being overwritten by "now".
		const col = makeCol([
			{ name: 'title', type: 'text' },
			{ name: 'createdAt', type: 'date' },
		])
		const data = buildExternalData(col, {
			metadata: { title: 'T', createdAt: '2020-01-02T03:04:05.000Z' },
			createdAt: new Date('2026-07-23T00:00:00.000Z'),
		})
		expect((data.createdAt as Date).toISOString()).toBe('2020-01-02T03:04:05.000Z')
	})

	it('stamps the fallback timestamp when the user supplied none', () => {
		const col = makeCol([{ name: 'createdAt', type: 'date' }])
		const data = buildExternalData(col, {
			metadata: {},
			createdAt: new Date('2026-07-23T00:00:00.000Z'),
		})
		expect((data.createdAt as Date).toISOString()).toBe('2026-07-23T00:00:00.000Z')
	})

	it('carries status even when the collection declares no status field', () => {
		// Without this a draft in an imported collection stays fully visible to the
		// site, because the source row never learns it was unpublished.
		const col = makeCol([{ name: 'title', type: 'text' }])
		const data = buildExternalData(col, { metadata: { title: 'T' }, status: 'draft' })
		expect(data.status).toBe('draft')
	})

	it('carries publishedAt as a real date when the collection declares no such field', () => {
		const col = makeCol([{ name: 'title', type: 'text' }])
		const data = buildExternalData(col, {
			metadata: { title: 'T' },
			status: 'scheduled',
			publishedAt: '2026-08-01T09:00:00.000Z',
		})
		expect((data.publishedAt as Date).toISOString()).toBe('2026-08-01T09:00:00.000Z')
	})

	it('keeps a text-typed timestamp column a string', () => {
		// Mongo collections written by an ORM store createdAt as an ISO string. Writing
		// a Date into the same column leaves it holding both BSON types, and BSON sorts
		// every String before every Date — silently reordering the feed.
		const col = makeCol([{ name: 'createdAt', type: 'text' }])
		const data = buildExternalData(col, {
			metadata: {},
			createdAt: new Date('2026-07-23T00:00:00.000Z'),
		})
		expect(data.createdAt).toBe('2026-07-23T00:00:00.000Z')
	})

	it('does not invent createdAt/updatedAt for a collection that maps neither', () => {
		const col = makeCol([{ name: 'title', type: 'text' }])
		const data = buildExternalData(col, {
			metadata: { title: 'T' },
			createdAt: new Date(),
			updatedAt: new Date(),
		})
		expect('createdAt' in data).toBe(false)
		expect('updatedAt' in data).toBe(false)
	})
})

describe('mergeExternalTimestamps', () => {
	const timestampFields = [
		{ name: 'createdAt', type: 'date' },
		{ name: 'updatedAt', type: 'date' },
	]

	it('folds the stamped timestamps back into the cached metadata as ISO strings', () => {
		// Without this the CMS cache keeps only what the client sent, so the editor
		// renders a blank createdAt for every record the CMS created itself.
		const merged = mergeExternalTimestamps(
			{ title: 'T' },
			{ title: 'T', createdAt: new Date('2026-07-23T10:00:00.000Z') },
			timestampFields,
		)
		expect(merged).toEqual({ title: 'T', createdAt: '2026-07-23T10:00:00.000Z' })
	})

	it('leaves metadata untouched when the external row maps no timestamps', () => {
		expect(mergeExternalTimestamps({ title: 'T' }, { title: 'T' }, timestampFields)).toEqual({
			title: 'T',
		})
	})

	it('tolerates undefined metadata', () => {
		expect(
			mergeExternalTimestamps(
				undefined,
				{ updatedAt: '2026-01-01T00:00:00.000Z' },
				timestampFields,
			),
		).toEqual({ updatedAt: '2026-01-01T00:00:00.000Z' })
	})

	it('does not cache a publishedAt the collection never declared', () => {
		// `publishedAt` now travels to schemaless targets whether or not the schema
		// knows about it. Caching it for a SQL target that stripped it on the way out
		// would make every later sync-preview report the row as changed.
		const merged = mergeExternalTimestamps(
			{ title: 'T' },
			{ title: 'T', publishedAt: new Date('2026-07-23T10:00:00.000Z') },
			[{ name: 'title', type: 'text' }],
		)
		expect('publishedAt' in merged).toBe(false)
	})
})

describe('stripUnmappedSystemColumns', () => {
	const data = { slug: 'my-recipe', title: 'My Recipe' }

	it('keeps slug for MongoDB regardless of the mapped fields', () => {
		const col = makeCol([{ name: 'title', type: 'text' }])
		expect(stripUnmappedSystemColumns('mongodb', col, data)).toEqual(data)
	})

	it('drops slug for SQL targets without a slug column', () => {
		const col = makeCol([{ name: 'title', type: 'text' }])
		expect(stripUnmappedSystemColumns('postgresql', col, data)).toEqual({ title: 'My Recipe' })
	})

	it('keeps slug for SQL targets that map a slug column', () => {
		const col = makeCol([
			{ name: 'title', type: 'text' },
			{ name: 'slug', type: 'text' },
		])
		expect(stripUnmappedSystemColumns('mysql', col, data)).toEqual(data)
	})

	it('is a no-op when data has no slug', () => {
		const col = makeCol([{ name: 'title', type: 'text' }])
		expect(stripUnmappedSystemColumns('postgresql', col, { title: 'x' })).toEqual({ title: 'x' })
	})

	it('keeps status and publishedAt for MongoDB with no such fields declared', () => {
		const col = makeCol([{ name: 'title', type: 'text' }])
		const lifecycle = { title: 'T', status: 'draft', publishedAt: new Date() }
		expect(stripUnmappedSystemColumns('mongodb', col, lifecycle)).toEqual(lifecycle)
	})

	it('drops status and publishedAt for SQL targets without those columns', () => {
		const col = makeCol([{ name: 'title', type: 'text' }])
		expect(
			stripUnmappedSystemColumns('postgresql', col, {
				title: 'T',
				status: 'draft',
				publishedAt: new Date(),
			}),
		).toEqual({ title: 'T' })
	})

	it('keeps status and publishedAt for SQL targets that map them', () => {
		const col = makeCol([
			{ name: 'title', type: 'text' },
			{ name: 'status', type: 'text' },
			{ name: 'publishedAt', type: 'date' },
		])
		const lifecycle = { title: 'T', status: 'draft', publishedAt: new Date() }
		expect(stripUnmappedSystemColumns('postgresql', col, lifecycle)).toEqual(lifecycle)
	})

	it('can strip a payload down to nothing, which the write path must not send', () => {
		// This is the shape a status sync to a status-less SQL collection produces.
		// Mongo rejects `{ $set: {} }` and SQL has no valid empty UPDATE, so
		// insert/updateExternalDb bail out instead of issuing the statement.
		const col = makeCol([{ name: 'title', type: 'text' }])
		expect(stripUnmappedSystemColumns('postgresql', col, { status: 'draft' })).toEqual({})
	})
})
