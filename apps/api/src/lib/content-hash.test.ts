import { describe, expect, it } from 'vitest'
import { contentHash } from './content-hash.js'

const base = {
	id: 'record-a',
	projectId: 'project-a',
	collectionId: 'collection-a',
	slug: 'hello',
	status: 'draft',
	markdown: 'Привіт 🌍',
	locale: 'uk',
	version: 3,
	createdAt: new Date('2026-01-01T00:00:00.000Z'),
	updatedAt: new Date('2026-02-01T00:00:00.000Z'),
	publishedAt: null,
	externalId: null,
	metadata: { title: { uk: 'Привіт', en: 'Hello' }, list: [1, null, true, { z: 2, a: 'é' }] },
}

describe('content hash invariants', () => {
	it('agrees between database Dates and JSON response timestamps', () => {
		expect(contentHash(base)).toBe(contentHash(JSON.parse(JSON.stringify(base))))
	})
	it.each(Object.keys(base))('changes when stored authoring field %s changes', (key) => {
		expect(contentHash({ ...base, [key]: key === 'version' ? 4 : 'different' })).not.toBe(
			contentHash(base),
		)
	})
	it('ignores derived representations and sync bookkeeping', () => {
		expect(
			contentHash({
				...base,
				html: '<p>derived</p>',
				contentHash: 'client-value',
				externalSnapshot: { markdown: 'source' },
			}),
		).toBe(contentHash(base))
	})
	it('preserves array order and Unicode distinctions', () => {
		expect(contentHash({ ...base, metadata: { value: [1, 2] } })).not.toBe(
			contentHash({ ...base, metadata: { value: [2, 1] } }),
		)
		expect(contentHash({ ...base, markdown: 'é' })).not.toBe(
			contentHash({ ...base, markdown: 'e\u0301' }),
		)
	})
	it('is invariant to nested key order for 500 generated JSON records (seed 19317)', () => {
		let seed = 19317
		const random = () => {
			seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
			return seed
		}
		const generate = (depth: number): unknown => {
			const value = random()
			if (depth === 0) return [null, true, value / 100, `text-${value}-🌍`, false][value % 5]
			if (value % 3 === 0) return Array.from({ length: value % 5 }, () => generate(depth - 1))
			return Object.fromEntries(
				Array.from({ length: value % 7 }, (_, index) => [
					`key-${index}-${random()}`,
					generate(depth - 1),
				]),
			)
		}
		const reverseKeys = (value: unknown): unknown => {
			if (Array.isArray(value)) return value.map(reverseKeys)
			if (value && typeof value === 'object')
				return Object.fromEntries(
					Object.entries(value)
						.reverse()
						.map(([key, entry]) => [key, reverseKeys(entry)]),
				)
			return value
		}
		for (let index = 0; index < 500; index++) {
			const metadata = generate(4)
			expect(contentHash({ ...base, metadata })).toBe(
				contentHash({ ...base, metadata: reverseKeys(metadata) }),
			)
		}
	})
	it('canonicalizes hostile JSON keys without dropping or executing them', () => {
		const metadata = JSON.parse('{"__proto__":{"polluted":true},"constructor":{"x":1},"a":2}')
		expect(contentHash({ ...base, metadata })).toBe(
			contentHash({ ...base, metadata: { a: 2, ...metadata } }),
		)
		expect(contentHash({ ...base, metadata })).not.toBe(
			contentHash({ ...base, metadata: { a: 2 } }),
		)
	})
})
