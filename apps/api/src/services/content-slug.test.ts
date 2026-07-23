import { contentInputSchema } from '@innolope/config'
import { describe, expect, it } from 'vitest'

/**
 * Slug shape contract: both "-" and "_" are valid separators. Imported
 * datasets use snake_case slugs, and the MCP slugifier preserves caller
 * intent instead of rewriting snake_case to kebab-case — the API must
 * accept what the slugifier now lets through.
 */
describe('contentInputSchema slug', () => {
	const parse = (slug: string) =>
		contentInputSchema.safeParse({
			slug,
			collectionId: 'f4746f04-a48c-4726-a2c2-b3b7c9ed0f5c',
			markdown: '',
		})

	it.each([
		'roast_lamb_with_laver_sauce',
		'kebab-case-slug',
		'mixed_case-slug',
		'a',
		'a1_b2-c3',
	])('accepts %s', (slug) => {
		expect(parse(slug).success).toBe(true)
	})

	it.each([
		'Upper_Case',
		'double__underscore',
		'trailing-',
		'_leading',
		'space slug',
		'sn__ake--',
	])('rejects %s', (slug) => {
		expect(parse(slug).success).toBe(false)
	})
})
