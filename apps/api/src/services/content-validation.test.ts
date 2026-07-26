import type { CollectionField } from '@innolope/config'
import { describe, expect, it } from 'vitest'
import { collectFieldWarnings, validateContentMetadata } from './content-validation.js'

const fields: CollectionField[] = [
	{ name: 'title', type: 'text', required: true },
	{ name: 'servings', type: 'number' },
	{ name: 'vegan', type: 'boolean' },
	{ name: 'publishedOn', type: 'date' },
	{ name: 'difficulty', type: 'enum', options: ['easy', 'medium', 'hard'] },
	{ name: 'tags', type: 'array' },
]

describe('validateContentMetadata', () => {
	it('passes a well-formed item', () => {
		const errors = validateContentMetadata(
			fields,
			{ title: 'Rarebit', servings: 2, vegan: false, difficulty: 'easy', tags: ['welsh'] },
			{ enforceRequired: true },
		)
		expect(errors).toEqual([])
	})

	it('does not require missing required fields for drafts', () => {
		const errors = validateContentMetadata(fields, { servings: 2 }, { enforceRequired: false })
		expect(errors).toEqual([])
	})

	it('flags missing required fields when publishing', () => {
		const errors = validateContentMetadata(fields, { servings: 2 }, { enforceRequired: true })
		expect(errors).toHaveLength(1)
		expect(errors[0].field).toBe('title')
	})

	it('ignores unknown extra keys', () => {
		const errors = validateContentMetadata(
			fields,
			{ title: 'X', somethingElse: 'ok', anotherKey: 42 },
			{ enforceRequired: true },
		)
		expect(errors).toEqual([])
	})

	it('is lenient about numeric strings and parseable dates', () => {
		const errors = validateContentMetadata(
			fields,
			{ title: 'X', servings: '4', publishedOn: '2026-01-01' },
			{ enforceRequired: true },
		)
		expect(errors).toEqual([])
	})

	it('flags clear type mismatches and bad enum values', () => {
		const errors = validateContentMetadata(
			fields,
			{ title: 'X', servings: 'lots', difficulty: 'trivial', tags: 'welsh' },
			{ enforceRequired: true },
		)
		const badFields = errors.map((e) => e.field).sort()
		expect(badFields).toEqual(['difficulty', 'servings', 'tags'])
	})

	it('rejects arrays and structured objects on text fields', () => {
		const errors = validateContentMetadata(
			fields,
			{ title: { blocks: [{ type: 'h1' }] } },
			{ enforceRequired: false },
		)
		expect(errors).toHaveLength(1)
		expect(errors[0].field).toBe('title')
		expect(errors[0].message).toContain('[object Object]')

		const arrayErrors = validateContentMetadata(
			fields,
			{ title: ['one', 'two'] },
			{ enforceRequired: false },
		)
		expect(arrayErrors.map((e) => e.field)).toEqual(['title'])
	})

	it('accepts locale maps on text fields, localized or not (imported data has them unflagged)', () => {
		const localized: CollectionField[] = [{ name: 'title', type: 'text', localized: true }]
		expect(
			validateContentMetadata(
				localized,
				{ title: { en: 'Hello', uk: 'Привіт' } },
				{ enforceRequired: false },
			),
		).toEqual([])
		expect(
			validateContentMetadata(fields, { title: { en: 'Hello' } }, { enforceRequired: false }),
		).toEqual([])
	})

	it('type-checks only updatedKeys, but still enforces required on the merged view', () => {
		// A legacy structured object stored in `title` must not block an update
		// that only touches `servings`...
		const merged = { title: { blocks: [] }, servings: 3 }
		expect(
			validateContentMetadata(fields, merged, {
				enforceRequired: false,
				updatedKeys: ['servings'],
			}),
		).toEqual([])
		// ...while the same write DOES get its own fields checked...
		expect(
			validateContentMetadata(
				fields,
				{ ...merged, servings: 'lots' },
				{ enforceRequired: false, updatedKeys: ['servings'] },
			),
		).toHaveLength(1)
		// ...and required-to-publish still looks at the whole merged record.
		expect(
			validateContentMetadata(
				fields,
				{ servings: 3 },
				{
					enforceRequired: true,
					updatedKeys: ['servings'],
				},
			).map((e) => e.field),
		).toEqual(['title'])
	})
})

describe('collectFieldWarnings', () => {
	it('warns when a locale map lands on a non-translatable text field', () => {
		const warnings = collectFieldWarnings(fields, { title: { en: 'Hello', uk: 'Привіт' } })
		expect(warnings).toHaveLength(1)
		expect(warnings[0]).toContain('not marked translatable')
	})

	it('stays quiet for plain strings, localized fields, and untouched fields', () => {
		const localized: CollectionField[] = [{ name: 'title', type: 'text', localized: true }]
		expect(collectFieldWarnings(fields, { title: 'Hello' })).toEqual([])
		expect(collectFieldWarnings(localized, { title: { en: 'Hello' } })).toEqual([])
		expect(collectFieldWarnings(fields, { servings: 2 })).toEqual([])
		expect(collectFieldWarnings(fields, undefined)).toEqual([])
	})
})

describe('locale-format checks (active when opts.locales is set)', () => {
	const locales = ['en', 'ua']

	it('rejects metadata wrapped per record ({ en: { title... } })', () => {
		const errors = validateContentMetadata(
			fields,
			{ en: { title: 'Hello', tags: ['a'] }, ua: { title: 'Привіт' } },
			{ enforceRequired: false, locales },
		)
		expect(errors.map((e) => e.field).sort()).toEqual(['en', 'ua'])
		expect(errors[0].message).toContain('per-field')
	})

	it('rejects record wrapping under a known but unconfigured code', () => {
		const errors = validateContentMetadata(
			fields,
			{ uk: { title: 'Привіт' } },
			{ enforceRequired: false, locales },
		)
		expect(errors.map((e) => e.field)).toEqual(['uk'])
	})

	it('rejects locale-map keys that are not configured project locales', () => {
		const errors = validateContentMetadata(
			fields,
			{ title: { en: 'Hello', uk: 'Привіт' } },
			{ enforceRequired: false, locales },
		)
		expect(errors).toHaveLength(1)
		expect(errors[0].field).toBe('title')
		expect(errors[0].message).toContain('"uk"')
		expect(errors[0].message).toContain('en, ua')
	})

	it('accepts configured-locale maps, including per-language arrays for tags', () => {
		const errors = validateContentMetadata(
			fields,
			{ title: { en: 'Hello', ua: 'Привіт' }, tags: { en: ['design'], ua: ['дизайн'] } },
			{ enforceRequired: false, locales },
		)
		expect(errors).toEqual([])
	})

	it('leaves structured objects whose keys merely resemble locale codes alone', () => {
		// "id" (Indonesian) and "no" (Norwegian) are recognized codes, but the
		// values are not translations and no configured locale appears.
		const withStats: CollectionField[] = [...fields, { name: 'stats', type: 'object' }]
		const errors = validateContentMetadata(
			withStats,
			{ title: 'X', stats: { id: 5, no: 3 } },
			{ enforceRequired: false, locales },
		)
		expect(errors).toEqual([])
	})

	it('checks only touched keys on updates, and stays off without opts.locales', () => {
		expect(
			validateContentMetadata(
				fields,
				{ title: { en: 'x', uk: 'y' }, servings: 2 },
				{ enforceRequired: false, locales, updatedKeys: ['servings'] },
			),
		).toEqual([])
		expect(
			validateContentMetadata(fields, { title: { en: 'x', uk: 'y' } }, { enforceRequired: false }),
		).toEqual([])
	})
})

describe('collectFieldWarnings — per-language arrays', () => {
	it('warns when per-language arrays land on a non-translatable array field', () => {
		const warnings = collectFieldWarnings(fields, { tags: { en: ['design'], ua: ['дизайн'] } })
		expect(warnings).toHaveLength(1)
		expect(warnings[0]).toContain('not marked translatable')
	})

	it('stays quiet when the array field is localized or holds a plain array', () => {
		const localizedTags: CollectionField[] = [{ name: 'tags', type: 'array', localized: true }]
		expect(collectFieldWarnings(localizedTags, { tags: { en: ['a'] } })).toEqual([])
		expect(collectFieldWarnings(fields, { tags: ['a', 'b'] })).toEqual([])
	})
})
