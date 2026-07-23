import type { collections } from '@innolope/db'
import { describe, expect, it } from 'vitest'
import { buildExternalData, stripUnmappedSlug } from './external-content.js'

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
})

describe('stripUnmappedSlug', () => {
	const data = { slug: 'my-recipe', title: 'My Recipe' }

	it('keeps slug for MongoDB regardless of the mapped fields', () => {
		const col = makeCol([{ name: 'title', type: 'text' }])
		expect(stripUnmappedSlug('mongodb', col, data)).toEqual(data)
	})

	it('drops slug for SQL targets without a slug column', () => {
		const col = makeCol([{ name: 'title', type: 'text' }])
		expect(stripUnmappedSlug('postgresql', col, data)).toEqual({ title: 'My Recipe' })
	})

	it('keeps slug for SQL targets that map a slug column', () => {
		const col = makeCol([
			{ name: 'title', type: 'text' },
			{ name: 'slug', type: 'text' },
		])
		expect(stripUnmappedSlug('mysql', col, data)).toEqual(data)
	})

	it('is a no-op when data has no slug', () => {
		const col = makeCol([{ name: 'title', type: 'text' }])
		expect(stripUnmappedSlug('postgresql', col, { title: 'x' })).toEqual({ title: 'x' })
	})
})
