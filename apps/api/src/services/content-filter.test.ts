import { describe, expect, it } from 'vitest'
import { buildContentConditions } from './content-filter.js'

const PROJECT = '11111111-1111-1111-1111-111111111111'

describe('buildContentConditions', () => {
	it('always scopes to the project', () => {
		expect(buildContentConditions({}, { projectId: PROJECT })).toHaveLength(1)
	})

	it('adds one condition per active filter', () => {
		const conditions = buildContentConditions(
			{ status: 'published', locale: 'uk', search: 'borscht' },
			{ projectId: PROJECT },
		)
		// project + status + locale + search
		expect(conditions).toHaveLength(4)
	})

	it('applies the readable-collection scope only when no collection is named', () => {
		const scoped = buildContentConditions({}, { projectId: PROJECT, scopedCollectionIds: ['a'] })
		expect(scoped).toHaveLength(2)

		// An explicit collectionId is already the narrower filter; the scope would
		// be redundant, and the list endpoint does not apply it either.
		const named = buildContentConditions(
			{ collectionId: 'a' },
			{ projectId: PROJECT, scopedCollectionIds: ['a'] },
		)
		expect(named).toHaveLength(2)
	})

	it('adds one condition per valid metadata filter', () => {
		const conditions = buildContentConditions(
			{ metadata: JSON.stringify({ author: 'ada', category: 'news' }) },
			{ projectId: PROJECT },
		)
		expect(conditions).toHaveLength(3)
	})

	it('drops metadata keys that are not plain identifiers', () => {
		// The key reaches sql.raw, so anything but an identifier must be discarded
		// rather than escaped — this is the injection boundary.
		const conditions = buildContentConditions(
			{ metadata: JSON.stringify({ "a'; drop table content; --": 'x', ok: 'y' }) },
			{ projectId: PROJECT },
		)
		expect(conditions).toHaveLength(2)
	})

	it('ignores empty metadata values rather than matching on empty string', () => {
		const conditions = buildContentConditions(
			{ metadata: JSON.stringify({ author: '', category: null, real: 'x' }) },
			{ projectId: PROJECT },
		)
		expect(conditions).toHaveLength(2)
	})

	it('survives a malformed metadata param', () => {
		expect(() =>
			buildContentConditions({ metadata: '{not json' }, { projectId: PROJECT }),
		).not.toThrow()
		expect(buildContentConditions({ metadata: '{not json' }, { projectId: PROJECT })).toHaveLength(
			1,
		)
	})

	it('adds each date bound separately', () => {
		const conditions = buildContentConditions(
			{ updatedFrom: '2026-01-01', updatedTo: '2026-02-01', publishedFrom: '2026-01-15' },
			{ projectId: PROJECT },
		)
		expect(conditions).toHaveLength(4)
	})
})
