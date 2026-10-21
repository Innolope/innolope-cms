import type { SourceSchema } from '@innolope/db'
import { ObjectId } from 'mongodb'
import { describe, expect, it } from 'vitest'
import { histogramPaths, sealSourceSchema } from '../adapters/source-schema.js'
import {
	buildCollectionFields,
	mergeFieldCustomizations,
	mongoShapesFromSchema,
	refineFieldsFromSamples,
} from './collection-schema.js'
import {
	diffSourceSchemas,
	fieldsFromSourceSchema,
	markMixedFieldsOpaque,
} from './external-schema.js'

const sqlColumn = (name: string, nativeType: string, extra: Record<string, unknown> = {}) => ({
	name,
	nativeType,
	nullable: true,
	hasDefault: false,
	isIdentity: false,
	isGenerated: false,
	isPrimaryKey: false,
	...extra,
})

const pg = (columns: ReturnType<typeof sqlColumn>[]): SourceSchema =>
	sealSourceSchema({ dialect: 'postgresql', table: 't', primaryKey: ['id'], columns })

const mongo = (docs: Array<Record<string, unknown>>): SourceSchema =>
	sealSourceSchema({
		dialect: 'mongodb',
		table: 'c',
		primaryKey: ['_id'],
		paths: histogramPaths(docs),
	})

describe('buildCollectionFields with a recorded source schema', () => {
	it('turns a native enum into a dropdown and tinyint(1) into a checkbox', () => {
		const schema = pg([
			sqlColumn('mood', 'USER-DEFINED', { udtName: 'mood', enumValues: ['happy', 'sad'] }),
			sqlColumn('active', 'tinyint', { udtName: 'tinyint(1)' }),
		])
		const fields = buildCollectionFields(
			[
				{ name: 'mood', type: 'USER-DEFINED' },
				{ name: 'active', type: 'tinyint' },
			],
			{ sourceSchema: schema },
		)
		expect(fields.map((f) => [f.name, f.type, f.options])).toEqual([
			['mood', 'enum', ['happy', 'sad']],
			['active', 'boolean', undefined],
		])
	})

	it('makes a generated column read-only', () => {
		const schema = pg([sqlColumn('total', 'numeric', { isGenerated: true })])
		const [field] = buildCollectionFields([{ name: 'total', type: 'numeric' }], {
			sourceSchema: schema,
		})
		expect(field.ui?.readOnly).toBe(true)
	})

	it('marks a MongoDB field with mixed types opaque', () => {
		const schema = mongo([{ price: '5' }, { price: 5 }])
		const [field] = buildCollectionFields([{ name: 'price', type: 'text' }], {
			sourceSchema: schema,
		})
		expect(field.ui?.opaque).toBe(true)
	})
})

describe('fieldsFromSourceSchema for MongoDB', () => {
	const schema = mongo([
		{
			title: { en: 'Hello', uk: 'Привіт' },
			author: new ObjectId(),
			tags: [new ObjectId()],
			links: [{ platform: 'x', url: 'https://x.example' }],
			views: 3,
		},
	])

	it('reads types, locale maps and row shapes off the histogram', () => {
		const { fields } = fieldsFromSourceSchema([], schema)
		const byName = new Map(fields.map((f) => [f.name, f]))
		expect(byName.get('title')).toMatchObject({ type: 'text', localized: true })
		expect(byName.get('author')?.type).toBe('relation')
		expect(byName.get('tags')).toMatchObject({ type: 'relation', relationIsArray: true })
		expect(byName.get('views')?.type).toBe('number')
		expect(byName.get('links')?.ui?.subFields?.map((sf) => sf.name)).toEqual(['platform', 'url'])
	})

	it('keeps relation targets and recorded row shapes the sample cannot re-derive', () => {
		const previous = [
			{ name: 'author', type: 'relation' as const, relationTo: 'authors' },
			{
				name: 'links',
				type: 'array' as const,
				label: 'Social links',
				ui: {
					subFields: [
						{ name: 'platform', type: 'enum' as const, options: ['x', 'linkedin'] },
						{ name: 'url', type: 'text' as const },
					],
				},
			},
		]
		const { fields } = fieldsFromSourceSchema(previous, schema)
		const byName = new Map(fields.map((f) => [f.name, f]))
		expect(byName.get('author')?.relationTo).toBe('authors')
		expect(byName.get('links')?.label).toBe('Social links')
		expect(byName.get('links')?.ui?.subFields?.[0].options).toEqual(['x', 'linkedin'])
	})

	it('finds no locale map in an object of non-locale keys', () => {
		expect(
			mongoShapesFromSchema(mongo([{ seo: { title: 'T', description: 'D' } }])).localizedFields
				.size,
		).toBe(0)
	})
})

describe('diffSourceSchemas', () => {
	it('reports added, removed and changed columns', () => {
		const before = pg([sqlColumn('a', 'text'), sqlColumn('b', 'integer')])
		const after = pg([sqlColumn('a', 'text', { nullable: false }), sqlColumn('c', 'text')])
		expect(diffSourceSchemas(before, after)).toEqual({
			added: ['c'],
			removed: ['b'],
			changed: ['a'],
		})
	})

	it('reports a MongoDB field that started holding another type', () => {
		expect(diffSourceSchemas(mongo([{ a: 'x' }]), mongo([{ a: 'x' }, { a: 1 }]))).toEqual({
			added: [],
			removed: [],
			changed: ['a'],
		})
	})
})

describe('markMixedFieldsOpaque', () => {
	it('marks only the mixed top-level fields', () => {
		const fields = markMixedFieldsOpaque(
			[
				{ name: 'price', type: 'text' },
				{ name: 'title', type: 'text' },
			],
			mongo([
				{ price: '5', title: 'a' },
				{ price: 5, title: 'b' },
			]),
		)
		expect(fields.map((f) => [f.name, f.ui?.opaque ?? false])).toEqual([
			['price', true],
			['title', false],
		])
	})
})

describe('refineFieldsFromSamples', () => {
	it('types a JSON column holding arrays as an array and detects row presets', () => {
		const [links] = refineFieldsFromSamples(
			[{ name: 'links', type: 'object' }],
			[
				{ links: [{ platform: 'x', url: 'https://x.com/a' }] },
				{ links: [{ platform: 'github', url: 'https://github.com/a' }] },
			],
		)
		expect(links).toMatchObject({
			type: 'array',
			ui: { preset: 'social-link', presetKeys: { platform: 'platform', url: 'url' } },
		})
	})

	it('only ever makes an image of a text field', () => {
		const fields = refineFieldsFromSamples(
			[
				{ name: 'cover', type: 'text' },
				{ name: 'title', type: 'text' },
			],
			[
				{ cover: 'https://cdn.example.com/a.jpg', title: 'A' },
				{ cover: 'https://cdn.example.com/b.png', title: 'B' },
			],
		)
		expect(fields.map((f) => f.ui?.preset)).toEqual(['image', undefined])
	})

	it('leaves a preset an admin confirmed alone', () => {
		const [field] = refineFieldsFromSamples(
			[{ name: 'price', type: 'object', ui: { preset: 'key-value', presetConfirmed: true } }],
			[{ price: { amount: 1, currency: 'USD' } }],
		)
		expect(field.ui?.preset).toBe('key-value')
	})
})

describe('mergeFieldCustomizations and presets', () => {
	it('keeps a confirmed preset over a new detection', () => {
		const { fields } = mergeFieldCustomizations(
			[{ name: 'meta', type: 'object', ui: { preset: 'seo', presetConfirmed: true } }],
			[
				{
					name: 'meta',
					type: 'object',
					ui: { preset: 'link', presetKeys: { label: 'title', url: 'href' } },
				},
			],
		)
		expect(fields[0].ui?.preset).toBe('seo')
		expect(fields[0].ui?.presetKeys).toBeUndefined()
	})

	it('keeps an earlier preset when this sample found none', () => {
		const { fields } = mergeFieldCustomizations(
			[{ name: 'price', type: 'object', ui: { preset: 'money' } }],
			[{ name: 'price', type: 'object' }],
		)
		expect(fields[0].ui?.preset).toBe('money')
	})
})
