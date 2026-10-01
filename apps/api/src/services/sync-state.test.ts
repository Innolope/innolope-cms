import { ObjectId } from 'mongodb'
import { describe, expect, it } from 'vitest'
import { mergeSyncState, type SyncState, stableValue } from './sync-state.js'

const state = (metadata: Record<string, unknown>, markdown = ''): SyncState => ({
	status: 'published',
	markdown,
	metadata,
})

describe('three-way external sync', () => {
	it('applies incoming-only edits without conflicts', () => {
		const baseline = state({ title: 'Course', views: 154 })
		expect(mergeSyncState(baseline, baseline, state({ title: 'Course', views: 176 }))).toEqual({
			state: state({ title: 'Course', views: 176 }),
			conflicts: [],
		})
	})
	it('merges different fields and preserves local-only edits', () => {
		const baseline = state({ title: 'Course', views: 154 })
		expect(
			mergeSyncState(
				baseline,
				state({ title: 'Edited title', views: 154 }),
				state({ title: 'Course', views: 176 }),
			),
		).toEqual({ state: state({ title: 'Edited title', views: 176 }), conflicts: [] })
	})
	it('merges independently edited translations', () => {
		const baseline = state({ title: { en: 'Course', uk: 'Курс' } })
		expect(
			mergeSyncState(
				baseline,
				state({ title: { en: 'New course', uk: 'Курс' } }),
				state({ title: { en: 'Course', uk: 'Новий курс' } }),
			).state.metadata.title,
		).toEqual({ en: 'New course', uk: 'Новий курс' })
	})
	it('does not conflict on the derived preview when different body translations change', () => {
		const base = state(
			{ content: { en: 'Old English body', uk: 'Старий текст' } },
			'Old English body',
		)
		const local = state(
			{ content: { en: 'Updated English body', uk: 'Старий текст' } },
			'Updated English body',
		)
		const incoming = state(
			{ content: { en: 'Old English body', uk: 'Новий український текст статті' } },
			'Новий український текст статті',
		)
		const result = mergeSyncState(base, local, incoming)
		expect(result.conflicts).toEqual([])
		expect(result.state.metadata.content).toEqual({
			en: 'Updated English body',
			uk: 'Новий український текст статті',
		})
		expect(result.state.markdown).toBe('Новий український текст статті')
	})
	it('requires a choice for overlapping edits while merging other updates', () => {
		const baseline = state({ title: 'Course', views: 154 })
		const local = state({ title: 'CMS title', views: 154 })
		const incoming = state({ title: 'External title', views: 176 })
		expect(mergeSyncState(baseline, local, incoming).conflicts).toEqual(['metadata.title'])
		expect(mergeSyncState(baseline, local, incoming, 'local').state).toEqual(
			state({ title: 'CMS title', views: 176 }),
		)
		expect(mergeSyncState(baseline, local, incoming, 'external').state).toEqual(incoming)
	})
	it('recognizes a deletion versus a simultaneous edit', () => {
		expect(
			mergeSyncState(state({ title: 'Course' }), state({ title: 'CMS' }), state({})).conflicts,
		).toEqual(['metadata.title'])
	})
	it('treats matching edits as already resolved', () => {
		expect(
			mergeSyncState(state({ title: 'Course' }), state({ title: 'Same' }), state({ title: 'Same' }))
				.conflicts,
		).toEqual([])
	})
	it('compares nested arrays and objects without dropping their keys', () => {
		expect(stableValue({ relation: [{ id: 'a', label: 'old' }] })).not.toBe(
			stableValue({ relation: [{ id: 'a', label: 'new' }] }),
		)
		expect(stableValue({ a: { x: 1, y: 2 } })).toBe(stableValue({ a: { y: 2, x: 1 } }))
	})
	it('compares BSON relation ids and source dates to their cached JSON values', () => {
		const id = new ObjectId('68aed5b4e90f118d825271ba')
		expect(stableValue(id)).toBe(stableValue(id.toHexString()))
		expect(stableValue({ refs: [id], updatedAt: new Date('2026-10-01T08:00:00Z') })).toBe(
			stableValue({ refs: [id.toHexString()], updatedAt: '2026-10-01T08:00:00.000Z' }),
		)
	})
	it('distinguishes missing, empty and null values', () => {
		expect(stableValue(undefined)).not.toBe(stableValue(''))
		expect(stableValue(null)).not.toBe(stableValue(''))
	})
})
