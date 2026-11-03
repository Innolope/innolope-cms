import { contentInputSchema, contentListSchema, contentUpdateSchema } from '@innolope/config'
import { describe, expect, it } from 'vitest'

const collectionId = '11111111-1111-4111-8111-111111111111'

describe('Zod migration: content input output contracts', () => {
	it('defaults the missing body when creating content', () => {
		const parsed = contentInputSchema.parse({ collectionId })
		expect(parsed.collectionId).toBe(collectionId)
		expect(parsed.markdown).toBe('')
		expect(Object.hasOwn(parsed, 'markdown')).toBe(true)
	})

	it('preserves explicit markdown including an intentional empty body', () => {
		for (const markdown of ['', '# Existing content\n\nBody']) {
			expect(contentInputSchema.parse({ collectionId, markdown }).markdown).toBe(markdown)
			expect(contentUpdateSchema.parse({ markdown })).toEqual({ markdown })
		}
	})

	it('accepts arbitrary metadata keys and JSON values', () => {
		const metadata = {
			'arbitrary field key': 'value',
			'': null,
			number: 17,
			falseValue: false,
			nested: { child: ['a', 3, null, { enabled: true }] },
			array: [],
		}
		expect(contentInputSchema.parse({ collectionId, metadata }).metadata).toEqual(metadata)
		expect(contentUpdateSchema.parse({ metadata })).toEqual({ metadata })
	})

	it('keeps absent fields absent in metadata-only and status-only updates', () => {
		for (const input of [{ metadata: { color: 'blue' } }, { status: 'draft' }, {}]) {
			const parsed = contentUpdateSchema.parse(input)
			expect(parsed).toEqual(input)
			expect(Object.hasOwn(parsed, 'markdown')).toBe(false)
			// This models a typical stored-record merge and detects destructive inserted defaults.
			expect({ markdown: '# Persisted body', ...parsed }.markdown).toBe('# Persisted body')
		}
	})

	it('accepts optional nullable slugs', () => {
		expect(contentInputSchema.parse({ collectionId, slug: null }).slug).toBeNull()
		expect(contentUpdateSchema.parse({ slug: null })).toEqual({ slug: null })
	})

	it('strips unknown top-level keys for create and update', () => {
		expect(contentInputSchema.parse({ collectionId, unknown: 'strip me' })).not.toHaveProperty(
			'unknown',
		)
		expect(contentUpdateSchema.parse({ unknown: 'strip me' })).toEqual({})
	})

	it.each([
		undefined,
		null,
		'content',
		[],
		{},
		{ collectionId: 'not-a-uuid' },
		{ collectionId, markdown: 12 },
		{ collectionId, markdown: null },
		{ collectionId, metadata: 'invalid' },
		{ collectionId, metadata: [] },
		{ collectionId, metadata: null },
		{ collectionId, status: 'not-a-status' },
	])('rejects invalid create input %#', (input) => {
		expect(contentInputSchema.safeParse(input).success).toBe(false)
	})

	it.each([
		undefined,
		null,
		'update',
		[],
		{ collectionId: 'not-a-uuid' },
		{ markdown: 12 },
		{ markdown: null },
		{ metadata: 'invalid' },
		{ metadata: [] },
		{ metadata: null },
		{ status: 'not-a-status' },
	])('rejects invalid update input %#', (input) => {
		expect(contentUpdateSchema.safeParse(input).success).toBe(false)
	})
})

describe('Zod migration: content list output contracts', () => {
	it('preserves the existing list defaults', () => {
		expect(contentListSchema.parse({})).toMatchObject({
			page: 1,
			limit: 25,
			depth: 1,
			sortBy: 'createdAt',
			sortOrder: 'desc',
		})
	})

	it.each([
		{ page: 1, limit: 1, depth: 0 },
		{ page: 42, limit: 100, depth: 2 },
	])('accepts inclusive pagination/depth boundaries %#', (input) => {
		expect(contentListSchema.parse(input)).toMatchObject(input)
	})

	it.each([
		{ page: 0 },
		{ page: -1 },
		{ page: 1.5 },
		{ limit: 0 },
		{ limit: 101 },
		{ limit: 1.5 },
		{ depth: -1 },
		{ depth: 3 },
		{ depth: 0.5 },
		{ page: 'not-a-number' },
		{ limit: 'not-a-number' },
		{ depth: 'not-a-number' },
		{ page: Number.NaN },
		{ limit: Number.POSITIVE_INFINITY },
	])('rejects invalid pagination/depth input %#', (input) => {
		expect(contentListSchema.safeParse(input).success).toBe(false)
	})
})
