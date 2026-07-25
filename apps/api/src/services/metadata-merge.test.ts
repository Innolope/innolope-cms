import { describe, expect, it } from 'vitest'
import { mergeMetadataUpdate } from './metadata-merge.js'

describe('mergeMetadataUpdate', () => {
	it('returns undefined when the update carries no metadata (stored blob untouched)', () => {
		expect(mergeMetadataUpdate({ title: 'Kept' }, undefined)).toBeUndefined()
	})

	it('keeps fields the caller did not send', () => {
		expect(
			mergeMetadataUpdate({ title: 'Old', tags: ['a'], excerpt: 'Kept' }, { title: 'New' }),
		).toEqual({ title: 'New', tags: ['a'], excerpt: 'Kept' })
	})

	it('overwrites fields the caller did send, including empty strings', () => {
		expect(mergeMetadataUpdate({ title: 'Old', excerpt: 'Old too' }, { excerpt: '' })).toEqual({
			title: 'Old',
			excerpt: '',
		})
	})

	it('deletes a key when the caller sends null', () => {
		expect(mergeMetadataUpdate({ title: 'Old', draftNote: 'temp' }, { draftNote: null })).toEqual({
			title: 'Old',
		})
	})

	it('treats a missing current blob as empty', () => {
		expect(mergeMetadataUpdate(null, { title: 'New' })).toEqual({ title: 'New' })
		expect(mergeMetadataUpdate(undefined, {})).toEqual({})
	})

	it('does not mutate the inputs', () => {
		const current = { title: 'Old', gone: 1 }
		const incoming = { title: 'New', gone: null }
		mergeMetadataUpdate(current, incoming)
		expect(current).toEqual({ title: 'Old', gone: 1 })
		expect(incoming).toEqual({ title: 'New', gone: null })
	})
})
