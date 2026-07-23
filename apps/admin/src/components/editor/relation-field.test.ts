import { describe, expect, it } from 'vitest'
import { pickUrlField } from './relation-field'

const text = (name: string) => ({ name, type: 'text' })

describe('pickUrlField', () => {
	it('prefers the import wizard’s recorded media path column', () => {
		// Regression: `blog-media` stores its file in `fullPath`, which no name
		// heuristic matched, so the featured-image field rendered as an empty gap.
		expect(
			pickUrlField({
				fields: [text('fullPath'), text('filename'), text('alt')],
				mediaPathColumn: 'fullPath',
			}),
		).toBe('fullPath')
	})

	it('ignores a recorded column the collection does not actually expose', () => {
		expect(pickUrlField({ fields: [text('imageUrl')], mediaPathColumn: 'goneColumn' })).toBe(
			'imageUrl',
		)
	})

	it('falls back to the name heuristic when no media storage is configured', () => {
		expect(pickUrlField({ fields: [text('fullPath'), text('alt')] })).toBe('fullPath')
		expect(pickUrlField({ fields: [text('filename')] })).toBe('filename')
		expect(pickUrlField({ fields: [text('thumbnailUrl')] })).toBe('thumbnailUrl')
	})

	it('accepts a field named exactly url/src/href', () => {
		expect(pickUrlField({ fields: [text('title'), text('url')] })).toBe('url')
	})

	it('does not mistake a website link for an image', () => {
		expect(pickUrlField({ fields: [text('courseUrl'), text('name')] })).toBeUndefined()
	})

	it('returns undefined when nothing looks like a file column', () => {
		expect(pickUrlField({ fields: [text('name'), text('bio')] })).toBeUndefined()
	})
})
