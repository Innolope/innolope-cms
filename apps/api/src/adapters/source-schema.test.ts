import { Decimal128, Long, ObjectId } from 'mongodb'
import { describe, expect, it } from 'vitest'
import { externalIdFromRow, keyValuesFromId } from './external-db.js'
import {
	bsonTypeOf,
	hashSourceShape,
	histogramPaths,
	parseMysqlEnumValues,
	sealSourceSchema,
	soleType,
} from './source-schema.js'

describe('bsonTypeOf', () => {
	it('names the driver types the codec cares about', () => {
		expect(bsonTypeOf(new ObjectId())).toBe('objectId')
		expect(bsonTypeOf(new Date())).toBe('date')
		expect(bsonTypeOf(Decimal128.fromString('1'))).toBe('decimal128')
		expect(bsonTypeOf(Long.fromNumber(1))).toBe('long')
		expect(bsonTypeOf(1.5)).toBe('number')
		expect(bsonTypeOf({})).toBe('object')
		expect(bsonTypeOf([])).toBe('array')
		expect(bsonTypeOf(null)).toBe('null')
	})
})

describe('histogramPaths', () => {
	const paths = histogramPaths([
		{ _id: 1, title: 'A', items: [{ productId: new ObjectId() }, { productId: new ObjectId() }] },
		{ _id: 2, title: 5, items: [] },
		{ _id: 3, extra: null },
	])
	const byPath = new Map(paths.map((path) => [path.path, path]))

	it('records nested paths and array elements', () => {
		expect(soleType(byPath.get('items[].productId'))).toBe('objectId')
		expect(byPath.get('items[]')?.types).toEqual({ object: 1 })
	})

	it('counts a type once per document, so long arrays do not outweigh others', () => {
		expect(byPath.get('items[].productId')?.types.objectId).toBe(1)
	})

	it('marks mixed and nullable paths', () => {
		expect(byPath.get('title')?.mixed).toBe(true)
		expect(byPath.get('title')?.nullable).toBe(true)
		expect(byPath.get('extra')?.nullable).toBe(true)
		expect(soleType(byPath.get('title'))).toBeNull()
	})
})

describe('hashSourceShape', () => {
	it('ignores sample counts and scan times', () => {
		const a = sealSourceSchema({
			dialect: 'mongodb',
			table: 't',
			primaryKey: ['_id'],
			paths: histogramPaths([{ a: 'x' }]),
			sampled: 1,
		})
		const b = sealSourceSchema({
			dialect: 'mongodb',
			table: 't',
			primaryKey: ['_id'],
			paths: histogramPaths([{ a: 'x' }, { a: 'y' }]),
			sampled: 2,
		})
		expect(a.hash).toBe(b.hash)
	})

	it('changes when a column changes', () => {
		const base = { dialect: 'postgresql' as const, table: 't', primaryKey: ['id'] }
		const column = {
			name: 'a',
			nativeType: 'text',
			nullable: true,
			hasDefault: false,
			isIdentity: false,
			isGenerated: false,
			isPrimaryKey: false,
		}
		expect(hashSourceShape({ ...base, columns: [column] })).not.toBe(
			hashSourceShape({ ...base, columns: [{ ...column, nullable: false }] }),
		)
	})
})

describe('parseMysqlEnumValues', () => {
	it('reads labels, including escaped quotes', () => {
		expect(parseMysqlEnumValues("enum('a','it''s','c')")).toEqual(['a', "it's", 'c'])
		expect(parseMysqlEnumValues('varchar(10)')).toBeUndefined()
	})
})

describe('composite external ids', () => {
	it('round-trips a composite key through the external id', () => {
		const id = externalIdFromRow({ tenant: 'acme', slug: 'hello', title: 'x' }, ['tenant', 'slug'])
		expect(id).toBe('["acme","hello"]')
		expect(keyValuesFromId(id, ['tenant', 'slug'])).toEqual(['acme', 'hello'])
	})

	it('keeps a single key as its plain value', () => {
		expect(externalIdFromRow({ id: 7 }, ['id'])).toBe('7')
		expect(keyValuesFromId('7', ['id'])).toEqual(['7'])
	})

	it('rejects an id that does not match the key', () => {
		expect(() => keyValuesFromId('7', ['a', 'b'])).toThrow()
	})
})
