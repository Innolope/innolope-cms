import type { CollectionField } from '@innolope/config'
import { describe, expect, it } from 'vitest'
import {
	buildCollectionFields,
	type DetectedColumn,
	mergeFieldCustomizations,
} from './collection-schema.js'

const column = (name: string, type = 'text'): DetectedColumn => ({ name, type })

describe('buildCollectionFields', () => {
	it('drops the columns represented elsewhere on a content row', () => {
		const fields = buildCollectionFields([
			column('_id'),
			column('id'),
			column('slug'),
			column('title'),
		])
		expect(fields.map((f) => f.name)).toEqual(['title'])
	})

	it('marks a locale-mapped column as translatable text, not an object', () => {
		const fields = buildCollectionFields([column('title', 'object'), column('views', 'number')], {
			localizedFields: new Set(['title']),
		})
		expect(fields).toEqual([
			{ name: 'title', type: 'text', required: false, localized: true },
			{ name: 'views', type: 'number', required: false, localized: false },
		])
	})

	it('marks the system __v column read-only', () => {
		const [field] = buildCollectionFields([column('__v', 'number')])
		expect(field.ui?.readOnly).toBe(true)
	})

	it('keeps lifecycle timestamps editable', () => {
		const [field] = buildCollectionFields([column('createdAt', 'date')])
		expect(field.ui?.readOnly).toBeUndefined()
	})
})

describe('mergeFieldCustomizations', () => {
	const detected: CollectionField[] = [
		{ name: 'title', type: 'text', required: false, localized: false },
		{ name: 'status', type: 'text', required: false, localized: false },
	]

	it('returns the detected schema untouched for a first import', () => {
		const { fields, unpreserved } = mergeFieldCustomizations(undefined, detected)
		expect(fields).toEqual(detected)
		expect(unpreserved).toEqual([])
	})

	it('carries labels, required ticks, defaults and widget overrides across', () => {
		const previous: CollectionField[] = [
			{
				name: 'title',
				type: 'text',
				label: 'Headline',
				required: true,
				defaultValue: 'Untitled',
				ui: { widget: 'textarea', helpText: 'Shown on the card' },
			},
		]
		const { fields, unpreserved } = mergeFieldCustomizations(previous, detected)
		expect(fields[0]).toMatchObject({
			name: 'title',
			label: 'Headline',
			required: true,
			defaultValue: 'Untitled',
			ui: { widget: 'textarea', helpText: 'Shown on the card' },
		})
		expect(unpreserved).toEqual([])
	})

	it('lets fresh detection win on type and localization', () => {
		const previous: CollectionField[] = [
			{ name: 'title', type: 'object', localized: false, label: 'Headline' },
		]
		const fresh: CollectionField[] = [
			{ name: 'title', type: 'text', required: false, localized: true },
		]
		const { fields } = mergeFieldCustomizations(previous, fresh)
		expect(fields[0]).toMatchObject({ type: 'text', localized: true, label: 'Headline' })
	})

	it('reports a type change only on a field someone configured', () => {
		const previous: CollectionField[] = [
			{ name: 'title', type: 'object', label: 'Headline' },
			// Untouched by a human: detection changing its mind here is detection
			// doing its job, and warning about it would bury the reports that matter.
			{ name: 'status', type: 'object', required: false, localized: false },
		]
		const fresh: CollectionField[] = [
			{ name: 'title', type: 'text', required: false, localized: true },
			{ name: 'status', type: 'text', required: false, localized: true },
		]
		const { unpreserved } = mergeFieldCustomizations(previous, fresh)
		expect(unpreserved).toEqual([
			{ field: 'title', kind: 'typeChanged', from: 'object', to: 'text' },
		])
	})

	it('reports a field the scan no longer sees, and drops it from the schema', () => {
		const previous: CollectionField[] = [
			{ name: 'title', type: 'text' },
			{ name: 'legacyNotes', type: 'text', label: 'Legacy' },
		]
		const { fields, unpreserved } = mergeFieldCustomizations(previous, detected)
		expect(fields.map((f) => f.name)).toEqual(['title', 'status'])
		expect(unpreserved).toEqual([{ field: 'legacyNotes', kind: 'removed' }])
	})

	it('keeps previously detected enum options until the worker re-derives them', () => {
		const previous: CollectionField[] = [
			{ name: 'status', type: 'enum', options: ['draft', 'published'] },
		]
		const { fields } = mergeFieldCustomizations(previous, detected)
		expect(fields[1].options).toEqual(['draft', 'published'])
	})

	it('prefers a freshly detected array shape over the stored one', () => {
		const previous: CollectionField[] = [
			{ name: 'links', type: 'array', ui: { subFields: [{ name: 'old', type: 'text' }] } },
		]
		const fresh: CollectionField[] = [
			{ name: 'links', type: 'array', ui: { subFields: [{ name: 'platform', type: 'text' }] } },
		]
		const { fields } = mergeFieldCustomizations(previous, fresh)
		expect(fields[0].ui?.subFields).toEqual([{ name: 'platform', type: 'text' }])
	})

	it('falls back to the stored array shape when detection found none', () => {
		// An empty sample yields no shape; the recorded one still beats dropping to
		// a generic pill widget.
		const previous: CollectionField[] = [
			{ name: 'links', type: 'array', ui: { subFields: [{ name: 'platform', type: 'text' }] } },
		]
		const fresh: CollectionField[] = [{ name: 'links', type: 'array' }]
		const { fields } = mergeFieldCustomizations(previous, fresh)
		expect(fields[0].ui?.subFields).toEqual([{ name: 'platform', type: 'text' }])
	})
})
