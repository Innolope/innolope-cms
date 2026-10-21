import type { SourceSchema } from '@innolope/db'
import * as bson from 'mongodb'
import { BSON, Decimal128, Long, ObjectId } from 'mongodb'
import { describe, expect, it } from 'vitest'
import {
	decodeMongoValue,
	encodeMongoPatch,
	encodeMongoValue,
	encodeSqlValues,
	preflightMongo,
	preflightSql,
} from './codec.js'
import { histogramPaths, sealSourceSchema } from './source-schema.js'

/** What the cache stores: the decoded document after a JSON round trip. */
const cacheCopy = (doc: Record<string, unknown>) =>
	JSON.parse(JSON.stringify(decodeMongoValue(doc))) as Record<string, unknown>

/** Byte-level equality — the strongest statement that BSON types survived. */
const sameBson = (a: Record<string, unknown>, b: Record<string, unknown>) =>
	Buffer.from(BSON.serialize(a)).equals(Buffer.from(BSON.serialize(b)))

describe('decodeMongoValue', () => {
	it('keeps a Long that fits as a number and one that does not as its digits', () => {
		expect(decodeMongoValue(Long.fromNumber(42))).toBe(42)
		expect(decodeMongoValue(Long.fromString('9007199254740993'))).toBe('9007199254740993')
	})

	it('turns Decimal128 into its exact decimal string, at any depth', () => {
		expect(decodeMongoValue({ price: { amount: Decimal128.fromString('19.990') } })).toEqual({
			price: { amount: '19.990' },
		})
	})
})

describe('the round-trip invariant', () => {
	const zoo = (): Record<string, unknown> => ({
		title: 'Zoo',
		author: new ObjectId(),
		publishedAt: new Date('2026-01-02T03:04:05.000Z'),
		price: Decimal128.fromString('1234567890.123456789'),
		views: Long.fromString('9007199254740993'),
		small: Long.fromNumber(7),
		score: 4.5,
		items: [
			{ productId: new ObjectId(), qty: 2, addedAt: new Date('2025-05-05T00:00:00.000Z') },
			{ productId: new ObjectId(), qty: 1, addedAt: new Date('2025-06-06T00:00:00.000Z') },
		],
		seo: { image: { ref: new ObjectId(), alt: 'A' } },
		title_i18n: { en: 'Hello', uk: 'Привіт' },
		empty: null,
	})

	it('restores every BSON type from the cache copy when the row is the template', () => {
		const doc = zoo()
		const encoded = encodeMongoPatch(bson, cacheCopy(doc), { existing: doc })
		// `small` was promoted to a number on read; the template restores the Long.
		expect(sameBson(encoded, doc)).toBe(true)
	})

	it('restores nested ObjectIds and Dates on insert from the recorded histogram', () => {
		const sample = zoo()
		const schema = sealSourceSchema({
			dialect: 'mongodb',
			table: 'zoo',
			primaryKey: ['_id'],
			paths: histogramPaths([sample]),
		})
		const encoded = encodeMongoPatch(bson, cacheCopy(sample), { schema }) as {
			items: Array<{ productId: unknown; addedAt: unknown }>
			seo: { image: { ref: unknown } }
			price: unknown
			views: unknown
		}
		expect(encoded.items[0].productId).toBeInstanceOf(ObjectId)
		expect(encoded.items[1].addedAt).toBeInstanceOf(Date)
		expect(encoded.seo.image.ref).toBeInstanceOf(ObjectId)
		expect(encoded.price).toBeInstanceOf(Decimal128)
		expect(encoded.views).toBeInstanceOf(Long)
	})

	it('encodes a dotted patch path against the value at that path', () => {
		const doc = zoo()
		const ref = (doc.seo as { image: { ref: ObjectId } }).image.ref
		const encoded = encodeMongoPatch(
			bson,
			{ 'seo.image.ref': ref.toHexString(), items: cacheCopy(doc).items },
			{ existing: doc },
		)
		expect(encoded['seo.image.ref']).toEqual(ref)
		expect((encoded.items as Array<{ productId: unknown }>)[1].productId).toBeInstanceOf(ObjectId)
	})

	it('writes an opaque field exactly as given', () => {
		const doc = { blob: new ObjectId() }
		const encoded = encodeMongoPatch(
			bson,
			{ blob: 'not-a-hex-but-raw' },
			{
				existing: doc,
				raw: new Set(['blob']),
			},
		)
		expect(encoded.blob).toBe('not-a-hex-but-raw')
	})

	it('turns the legacy { $numberDecimal } cache shape back into Decimal128', () => {
		const value = encodeMongoValue(
			bson,
			{ $numberDecimal: '2.50' },
			{ path: 'p', types: new Map() },
		)
		expect(value).toBeInstanceOf(Decimal128)
	})

	it('leaves a value that does not fit the expected type alone', () => {
		expect(
			encodeMongoValue(bson, 'not an id', {
				template: new ObjectId(),
				path: 'a',
				types: new Map(),
			}),
		).toBe('not an id')
	})
})

const pgSchema = (columns: SourceSchema['columns']): SourceSchema =>
	sealSourceSchema({ dialect: 'postgresql', table: 't', primaryKey: ['id'], columns })

const column = (
	name: string,
	nativeType: string,
	extra: Partial<NonNullable<SourceSchema['columns']>[number]> = {},
) => ({
	name,
	nativeType,
	nullable: true,
	hasDefault: false,
	isIdentity: false,
	isGenerated: false,
	isPrimaryKey: false,
	...extra,
})

describe('encodeSqlValues', () => {
	it('sends exact numerics as their digits', () => {
		const schema = pgSchema([
			column('n', 'numeric', { udtName: 'numeric' }),
			column('b', 'bigint', { udtName: 'int8' }),
		])
		expect(encodeSqlValues({ n: 0.1, b: 42 }, schema)).toEqual({ n: '0.1', b: '42' })
	})

	it('treats an empty string as NULL for a non-text column only', () => {
		const schema = pgSchema([column('when', 'timestamp with time zone'), column('note', 'text')])
		expect(encodeSqlValues({ when: '', note: '' }, schema)).toEqual({ when: null, note: '' })
	})

	it('leaves JSON to postgres-js but serialises it for MySQL', () => {
		const pg = pgSchema([column('meta', 'jsonb')])
		expect(encodeSqlValues({ meta: ['a'] }, pg)).toEqual({ meta: ['a'] })
		const mysql = sealSourceSchema({
			dialect: 'mysql',
			table: 't',
			primaryKey: ['id'],
			columns: [column('meta', 'json')],
		})
		expect(encodeSqlValues({ meta: { a: 1 } }, mysql)).toEqual({ meta: '{"a":1}' })
	})

	it('writes a boolean into tinyint(1) as 0/1', () => {
		const mysql = sealSourceSchema({
			dialect: 'mysql',
			table: 't',
			primaryKey: ['id'],
			columns: [column('active', 'tinyint', { udtName: 'tinyint(1)' })],
		})
		expect(encodeSqlValues({ active: true }, mysql)).toEqual({ active: 1 })
	})
})

describe('preflightSql', () => {
	const schema = pgSchema([
		column('id', 'integer', {
			nullable: false,
			hasDefault: true,
			isIdentity: true,
			isPrimaryKey: true,
		}),
		column('title', 'text', { nullable: false }),
		column('views', 'integer', { nullable: false, hasDefault: true }),
		column('mood', 'USER-DEFINED', { enumValues: ['happy', 'sad'] }),
		column('code', 'character varying', { maxLength: 3 }),
		column('total', 'numeric', { isGenerated: true }),
	])

	it('requires a NOT NULL column without a default on insert', () => {
		const { issues } = preflightSql({ views: 1 }, schema, { mode: 'insert' })
		expect(issues.map((issue) => [issue.field, issue.reason])).toEqual([['title', 'required']])
	})

	it('lets a column default fill a NULL on insert, but not on update', () => {
		expect(preflightSql({ title: 'T', views: null }, schema, { mode: 'insert' }).issues).toEqual([])
		expect(
			preflightSql({ views: null }, schema, { mode: 'update' }).issues.map((i) => i.reason),
		).toEqual(['required'])
	})

	it('checks enum membership and length', () => {
		const { issues } = preflightSql({ mood: 'angry', code: 'ABCD' }, schema, { mode: 'update' })
		expect(issues.map((issue) => issue.reason)).toEqual(['enum', 'tooLong'])
	})

	it('drops keys that are not columns and generated columns', () => {
		const { values, issues } = preflightSql({ title: 'T', status: 'draft', total: 5 }, schema, {
			mode: 'update',
		})
		expect(issues).toEqual([])
		expect(values).toEqual({ title: 'T' })
	})
})

describe('preflightMongo', () => {
	const schema = sealSourceSchema({
		dialect: 'mongodb',
		table: 'c',
		primaryKey: ['_id'],
		paths: histogramPaths([
			{ price: '5' },
			{ price: 5 },
			{ nested: { a: 'x' } },
			{ nested: { a: 1 } },
		]),
	})

	it('refuses a write to a top-level field with mixed types', () => {
		expect(preflightMongo({ price: 6 }, schema, { opaque: new Set() }).map((i) => i.field)).toEqual(
			['price'],
		)
	})

	it('allows it once the field is opaque', () => {
		expect(preflightMongo({ price: 6 }, schema, { opaque: new Set(['price']) })).toEqual([])
	})

	it('does not refuse mixed types below the top level', () => {
		expect(preflightMongo({ 'nested.a': 2 }, schema, { opaque: new Set() })).toEqual([])
	})
})
