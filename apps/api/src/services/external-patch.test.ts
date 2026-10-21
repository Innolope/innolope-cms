import { ObjectId } from 'mongodb'
import { describe, expect, it } from 'vitest'
import {
	applyExternalPatch,
	diffExternalPayload,
	externalBaseline,
	fullPatch,
	isEmptyPatch,
	writtenValues,
} from './external-patch.js'

describe('externalBaseline', () => {
	it('puts a plain-string body back under its column', () => {
		const baseline = externalBaseline([{ name: 'content', type: 'text' }], {
			status: 'published',
			markdown: 'Body',
			metadata: { title: 'T' },
		})
		expect(baseline).toEqual({ title: 'T', content: 'Body' })
	})

	it('keeps a localized body map that the snapshot already holds in metadata', () => {
		const baseline = externalBaseline([{ name: 'content', type: 'text', localized: true }], {
			status: 'published',
			markdown: 'English',
			metadata: { content: { en: 'English', uk: 'Українська' } },
		})
		expect(baseline.content).toEqual({ en: 'English', uk: 'Українська' })
	})
})

describe('diffExternalPayload', () => {
	it('produces an empty patch for a save that changes nothing', () => {
		const baseline = { title: 'T', views: 3, tags: ['a'] }
		const patch = diffExternalPayload({ ...baseline }, baseline, { nested: true })
		expect(isEmptyPatch(patch)).toBe(true)
	})

	it('sends only the changed column', () => {
		const patch = diffExternalPayload(
			{ title: 'New', views: 3, body: 'same' },
			{ title: 'Old', views: 3, body: 'same' },
			{ nested: false },
		)
		expect(patch).toEqual({ set: { title: 'New' }, unset: [] })
	})

	it('treats a Date and its cached ISO string as the same value', () => {
		const at = new Date('2026-01-02T03:04:05.000Z')
		const patch = diffExternalPayload(
			{ publishedAt: at },
			{ publishedAt: at.toISOString() },
			{ nested: true },
		)
		expect(isEmptyPatch(patch)).toBe(true)
	})

	it('treats an ObjectId and its cached hex string as the same value', () => {
		const id = new ObjectId()
		const patch = diffExternalPayload(
			{ author: id },
			{ author: id.toHexString() },
			{ nested: true },
		)
		expect(isEmptyPatch(patch)).toBe(true)
	})

	it('patches one language of a locale map by path on MongoDB', () => {
		const patch = diffExternalPayload(
			{ title: { en: 'Hello', uk: 'Привіт!' } },
			{ title: { en: 'Hello', uk: 'Привіт' } },
			{ nested: true },
		)
		expect(patch).toEqual({ set: { 'title.uk': 'Привіт!' }, unset: [] })
	})

	it('writes the whole map on SQL, which has no path updates', () => {
		const patch = diffExternalPayload(
			{ title: { en: 'Hello', uk: 'Привіт!' } },
			{ title: { en: 'Hello', uk: 'Привіт' } },
			{ nested: false },
		)
		expect(patch.set).toEqual({ title: { en: 'Hello', uk: 'Привіт!' } })
	})

	it('leaves untouched siblings of an embedded document alone', () => {
		// The cache holds the nested id as a string; rewriting it would turn the
		// source ObjectId into a string and break the site's $lookup.
		const patch = diffExternalPayload(
			{ seo: { title: 'New', ogImage: '65a1b2c3d4e5f6a7b8c9d0e1' } },
			{ seo: { title: 'Old', ogImage: '65a1b2c3d4e5f6a7b8c9d0e1' } },
			{ nested: true },
		)
		expect(patch).toEqual({ set: { 'seo.title': 'New' }, unset: [] })
	})

	it('removes a key the editor dropped from an embedded document', () => {
		const patch = diffExternalPayload(
			{ seo: { title: 'T' } },
			{ seo: { title: 'T', description: 'D' } },
			{ nested: true },
		)
		expect(patch).toEqual({ set: {}, unset: ['seo.description'] })
	})

	it('writes the parent whole when a key cannot be addressed by path', () => {
		const patch = diffExternalPayload(
			{ price: { $numberDecimal: '2.50' } },
			{ price: { $numberDecimal: '1.50' } },
			{ nested: true },
		)
		expect(patch.set).toEqual({ price: { $numberDecimal: '2.50' } })
	})

	it('replaces arrays whole', () => {
		const patch = diffExternalPayload(
			{ items: [{ qty: 2 }] },
			{ items: [{ qty: 1 }] },
			{ nested: true },
		)
		expect(patch.set).toEqual({ items: [{ qty: 2 }] })
	})

	it('removes only top-level keys the caller explicitly removed', () => {
		// `views` is missing from the outgoing payload because the cache never had
		// it (a source default) — that is not a removal.
		const patch = diffExternalPayload(
			{ title: 'T' },
			{ title: 'T', subtitle: 'S', views: 0 },
			{ nested: true, unset: ['subtitle'] },
		)
		expect(patch).toEqual({ set: {}, unset: ['subtitle'] })
	})

	it('skips an explicit removal of a key the source does not hold', () => {
		const patch = diffExternalPayload({}, { title: 'T' }, { nested: true, unset: ['gone'] })
		expect(isEmptyPatch(patch)).toBe(true)
	})
})

describe('fullPatch', () => {
	it('writes everything and keeps explicit removals of absent keys', () => {
		expect(fullPatch({ a: 1, b: null }, ['b', 'c', 'a'])).toEqual({
			set: { a: 1, b: null },
			unset: ['b', 'c'],
		})
	})
})

describe('applyExternalPatch', () => {
	it('applies dotted paths and removals on a copy', () => {
		const doc = { _id: '1', title: { en: 'A', uk: 'Б' }, seo: { a: 1, b: 2 } }
		const out = applyExternalPatch(doc, { set: { 'title.uk': 'В' }, unset: ['seo.b'] }, true)
		expect(out).toEqual({ _id: '1', title: { en: 'A', uk: 'В' }, seo: { a: 1 } })
		expect(doc.title.uk).toBe('Б')
	})

	it('keeps BSON values by reference', () => {
		const id = new ObjectId()
		const out = applyExternalPatch({ _id: '1', ref: id }, { set: { title: 'T' }, unset: [] }, true)
		expect(out.ref).toBe(id)
	})

	it('reads a SQL removal as NULL', () => {
		const out = applyExternalPatch({ _id: '1', a: 'x' }, { set: {}, unset: ['a'] }, false)
		expect(out).toEqual({ _id: '1', a: null })
	})
})

describe('writtenValues', () => {
	it('reports top-level writes and removals only', () => {
		expect(
			writtenValues({ set: { updatedAt: 'now', 'title.en': 'x' }, unset: ['subtitle', 'seo.a'] }),
		).toEqual({ updatedAt: 'now', subtitle: null })
	})
})
