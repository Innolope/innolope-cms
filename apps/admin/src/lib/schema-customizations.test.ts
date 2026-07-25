import type { CollectionField } from '@innolope/config'
import { describe, expect, it } from 'vitest'
import { detectDroppedFields } from './schema-customizations'

/** What the import wizard produces for a plain detected column. */
const detected = (name: string, type: CollectionField['type'] = 'text'): CollectionField => ({
	name,
	type,
	required: false,
	localized: false,
})

describe('detectDroppedFields', () => {
	it('reports nothing when every field still has a column', () => {
		const fields = [detected('title'), detected('publishedAt', 'date')]
		expect(detectDroppedFields(fields, ['title', 'publishedAt'])).toEqual([])
	})

	it('reports a field the source no longer has', () => {
		const fields = [detected('title'), detected('legacyNotes')]
		expect(detectDroppedFields(fields, ['title'])).toEqual([
			{ name: 'legacyNotes', configured: false },
		])
	})

	it('marks a dropped field that carried schema-editor settings', () => {
		const fields: CollectionField[] = [
			{ ...detected('legacyNotes'), label: 'Legacy notes', ui: { widget: 'textarea' } },
			{ ...detected('oldFlag', 'boolean'), required: true },
		]
		expect(detectDroppedFields(fields, [])).toEqual([
			{ name: 'legacyNotes', configured: true },
			{ name: 'oldFlag', configured: true },
		])
	})

	it('does not count machine-detected enum options or array sub-fields as configuration', () => {
		// Enum options come from the import worker's detection pass, and subFields
		// from array-shape detection — neither is someone's hand-made edit.
		const fields: CollectionField[] = [
			{ ...detected('status', 'enum'), options: ['draft', 'published'] },
			{
				...detected('socialLinks', 'array'),
				ui: { subFields: [{ name: 'platform', type: 'text' }] },
			},
		]
		expect(detectDroppedFields(fields, [])).toEqual([
			{ name: 'status', configured: false },
			{ name: 'socialLinks', configured: false },
		])
	})

	it('does not count the wizard-applied read-only tick on __v', () => {
		const fields: CollectionField[] = [{ ...detected('__v', 'number'), ui: { readOnly: true } }]
		expect(detectDroppedFields(fields, [])).toEqual([{ name: '__v', configured: false }])
	})

	it('tolerates a collection with no fields', () => {
		expect(detectDroppedFields(undefined, ['title'])).toEqual([])
	})
})
