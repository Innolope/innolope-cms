import { describe, expect, it } from 'vitest'
import { fieldLabel, humanizeFieldName } from './field-label'

describe('humanizeFieldName', () => {
	it('splits camelCase into title case', () => {
		expect(humanizeFieldName('postImage')).toBe('Post Image')
		expect(humanizeFieldName('metaDescription')).toBe('Meta Description')
	})

	it('keeps small words lowercase after the first word', () => {
		expect(humanizeFieldName('createdAt')).toBe('Created at')
		expect(humanizeFieldName('updatedAt')).toBe('Updated at')
		expect(humanizeFieldName('published_at')).toBe('Published at')
		expect(humanizeFieldName('numberOfViews')).toBe('Number of Views')
	})

	it('uppercases known acronyms', () => {
		expect(humanizeFieldName('imageUrl')).toBe('Image URL')
		expect(humanizeFieldName('SEOTitle')).toBe('SEO Title')
		expect(humanizeFieldName('externalId')).toBe('External ID')
	})

	it('handles snake_case, kebab-case and single words', () => {
		expect(humanizeFieldName('meta_description')).toBe('Meta Description')
		expect(humanizeFieldName('cover-image')).toBe('Cover Image')
		expect(humanizeFieldName('slug')).toBe('Slug')
	})

	it('leaves human-authored labels alone', () => {
		expect(humanizeFieldName('Author bio')).toBe('Author bio')
		expect(humanizeFieldName('  ')).toBe('')
	})
})

describe('fieldLabel', () => {
	it('prefers an explicit label', () => {
		expect(fieldLabel({ name: 'postImage', label: 'Hero shot' })).toBe('Hero shot')
	})

	it('humanizes an identifier-shaped label too', () => {
		expect(fieldLabel({ name: 'postImage', label: 'post_image' })).toBe('Post Image')
	})

	it('falls back to the field name', () => {
		expect(fieldLabel({ name: 'createdAt' })).toBe('Created at')
		expect(fieldLabel({ name: 'postImage', label: '   ' })).toBe('Post Image')
	})
})
