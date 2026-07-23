import type { CollectionField } from '@innolope/config'
import { describe, expect, it } from 'vitest'
import { validateContentMetadata } from './content-validation.js'

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
})
