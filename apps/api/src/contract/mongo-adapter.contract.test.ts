import { randomUUID } from 'node:crypto'
import * as bson from 'mongodb'
import { BSON, Decimal128, Long, ObjectId } from 'mongodb'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { encodeMongoPatch, preflightMongo } from '../adapters/codec.js'
import { createExternalDbAdapter, type ExternalDbAdapter } from '../adapters/external-db.js'
import { soleType } from '../adapters/source-schema.js'
import { diffExternalPayload, isEmptyPatch } from '../services/external-patch.js'

/**
 * The adapter contract for MongoDB, run against a real server.
 *
 *   CONTRACT_MONGO_URL=mongodb://localhost:27017 vitest run src/contract
 *
 * Skipped when the URL is unset; CI provides a service container. The guarantee
 * under test: for every document `d` read from the source, `encode(decode(d), d)`
 * equals `d` at the BSON level, a save that changes nothing produces an empty
 * patch, and an edit touches only what it changed.
 */

const url = process.env.CONTRACT_MONGO_URL
const database = `contract_${randomUUID().slice(0, 8)}`
const ZOO = 'zoo'
const EMPTY = 'empty'

/** What the cache stores for a read document. */
const cacheCopy = (doc: Record<string, unknown>) => {
	const { _id, ...rest } = JSON.parse(JSON.stringify(doc)) as Record<string, unknown>
	return rest
}

const withoutId = (doc: Record<string, unknown> | null) => {
	const { _id, ...rest } = doc ?? {}
	return rest
}

const sameBson = (a: Record<string, unknown>, b: Record<string, unknown>) =>
	Buffer.from(BSON.serialize(a)).equals(Buffer.from(BSON.serialize(b)))

describe.skipIf(!url)('MongoDB adapter contract', { timeout: 30_000 }, () => {
	let client: bson.MongoClient
	let adapter: ExternalDbAdapter
	const zoo = () => client.db(database).collection(ZOO)
	/** The stored document exactly as BSON, Longs included. */
	const raw = (id: unknown) => zoo().findOne({ _id: id } as never, { promoteLongs: false })

	const first = {
		_id: new ObjectId(),
		title: 'Zoo',
		author: new ObjectId(),
		items: [
			{ productId: new ObjectId(), qty: 2, addedAt: new Date('2025-05-05T00:00:00.000Z') },
			{ productId: new ObjectId(), qty: 1, addedAt: new Date('2025-06-06T00:00:00.000Z') },
		],
		publishedAt: new Date('2026-01-02T03:04:05.678Z'),
		price: Decimal128.fromString('1234567890.123456789'),
		views: Long.fromString('9007199254740993'),
		small: Long.fromNumber(7),
		mixed: 'a string here',
		title_i18n: { en: 'Hello', uk: 'Привіт' },
	}
	const second = {
		_id: new ObjectId(),
		title: 'Second',
		author: new ObjectId(),
		items: [{ productId: new ObjectId(), qty: 3, addedAt: new Date('2025-07-07T00:00:00.000Z') }],
		publishedAt: new Date('2026-02-02T00:00:00.000Z'),
		price: Decimal128.fromString('2.50'),
		views: Long.fromNumber(10),
		small: Long.fromNumber(8),
		mixed: { an: 'object here' },
		title_i18n: { en: 'Two', uk: 'Два' },
	}

	beforeAll(async () => {
		client = new bson.MongoClient(url as string)
		await client.connect()
		await zoo().insertMany([first, second])
		await client.db(database).createCollection(EMPTY)
		adapter = createExternalDbAdapter({
			type: 'mongodb',
			connectionString: url as string,
			database,
		})
		await adapter.connect()
	})

	afterAll(async () => {
		await adapter?.disconnect()
		await client?.db(database).dropDatabase()
		await client?.close()
	})

	it('describes nested paths, array elements and mixed fields', async () => {
		const schema = await adapter.describeTable(ZOO)
		const byPath = new Map((schema.paths ?? []).map((path) => [path.path, path]))
		expect(soleType(byPath.get('items[].productId'))).toBe('objectId')
		expect(soleType(byPath.get('items[].addedAt'))).toBe('date')
		expect(soleType(byPath.get('price'))).toBe('decimal128')
		expect(soleType(byPath.get('views'))).toBe('long')
		expect(byPath.get('mixed')?.mixed).toBe(true)
		expect(preflightMongo({ mixed: 'x' }, schema, { opaque: new Set() })).toHaveLength(1)
	})

	it('decodes exact values: Decimal128 and a big Long as strings, a small Long as a number', async () => {
		const doc = await adapter.findById(ZOO, first._id.toHexString())
		expect(doc?.price).toBe('1234567890.123456789')
		expect(doc?.views).toBe('9007199254740993')
		expect(doc?.small).toBe(7)
	})

	it('round-trips every document through the cache at the BSON level', async () => {
		for (const original of [first, second]) {
			const read = await adapter.findById(ZOO, original._id.toHexString())
			const stored = await raw(original._id)
			const encoded = encodeMongoPatch(bson, cacheCopy(read ?? { _id: '' }), {
				existing: stored,
			})
			expect(sameBson(encoded, withoutId(stored))).toBe(true)
		}
	})

	it('produces an empty patch for a save that changes nothing', async () => {
		for (const doc of await adapter.findAll(ZOO)) {
			const copy = cacheCopy(doc)
			expect(isEmptyPatch(diffExternalPayload(copy, copy, { nested: true }))).toBe(true)
		}
	})

	it('changes one scalar and leaves every other BSON value alone', async () => {
		const schema = await adapter.describeTable(ZOO)
		const before = await raw(first._id)
		const copy = cacheCopy((await adapter.findById(ZOO, first._id.toHexString())) ?? { _id: '' })
		const patch = diffExternalPayload({ ...copy, title: 'Edited' }, copy, { nested: true })
		expect(patch).toEqual({ set: { title: 'Edited' }, unset: [] })
		await adapter.update(ZOO, first._id.toHexString(), patch.set, { schema })
		expect(
			sameBson(withoutId(await raw(first._id)), { ...withoutId(before), title: 'Edited' }),
		).toBe(true)
	})

	it('rewrites an array from the cache copy with its nested ObjectIds and Dates intact', async () => {
		const schema = await adapter.describeTable(ZOO)
		const copy = cacheCopy((await adapter.findById(ZOO, first._id.toHexString())) ?? { _id: '' })
		const items = (copy.items as Array<Record<string, unknown>>).map((item, index) =>
			index === 0 ? { ...item, qty: 5 } : item,
		)
		const patch = diffExternalPayload({ ...copy, items }, copy, { nested: true })
		await adapter.update(ZOO, first._id.toHexString(), patch.set, { schema })
		const after = (await raw(first._id)) as unknown as typeof first
		expect(after.items[0].qty).toBe(5)
		expect(after.items[0].productId).toBeInstanceOf(ObjectId)
		expect(after.items[1].addedAt).toBeInstanceOf(Date)
		expect(after.items[1].productId.equals(first.items[1].productId)).toBe(true)
	})

	it('patches one language of a locale map by path', async () => {
		const copy = cacheCopy((await adapter.findById(ZOO, first._id.toHexString())) ?? { _id: '' })
		const patch = diffExternalPayload({ ...copy, title_i18n: { en: 'Hello', uk: 'Вітаю' } }, copy, {
			nested: true,
		})
		expect(patch.set).toEqual({ 'title_i18n.uk': 'Вітаю' })
		await adapter.update(ZOO, first._id.toHexString(), patch.set)
		expect((await raw(first._id))?.title_i18n).toEqual({ en: 'Hello', uk: 'Вітаю' })
	})

	it('inserts an editor payload with native types restored from the histogram', async () => {
		const schema = await adapter.describeTable(ZOO)
		const inserted = await adapter.insert(
			ZOO,
			{
				title: 'From the editor',
				author: new ObjectId().toHexString(),
				items: [
					{ productId: new ObjectId().toHexString(), qty: 1, addedAt: '2026-03-03T00:00:00.000Z' },
				],
				price: '9.99',
			},
			{ schema },
		)
		const stored = (await raw(new ObjectId(inserted._id))) as unknown as typeof first
		expect(stored.author).toBeInstanceOf(ObjectId)
		expect(stored.items[0].productId).toBeInstanceOf(ObjectId)
		expect(stored.items[0].addedAt).toBeInstanceOf(Date)
		expect(stored.price).toBeInstanceOf(Decimal128)
	})

	it('handles an empty collection', async () => {
		const schema = await adapter.describeTable(EMPTY)
		expect(schema.paths).toEqual([])
		const inserted = await adapter.insert(EMPTY, { title: 'First ever' }, { schema })
		expect((await adapter.findAll(EMPTY)).map((doc) => doc._id)).toEqual([inserted._id])
	})
})
