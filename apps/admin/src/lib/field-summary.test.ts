import { describe, expect, it } from 'vitest'
import { humanizeKey, scalarText, shortenUrl, summarizeValue } from './field-summary'
import { isTechnicalField } from './system-fields'

describe('summarizeValue', () => {
	it('pairs the name with a shortened link', () => {
		expect(
			summarizeValue({ platform: 'LinkedIn', url: 'https://www.linkedin.com/in/someone/' }),
		).toBe('LinkedIn · linkedin.com/in/someone')
	})

	it('prefers the configured summary key', () => {
		expect(summarizeValue({ title: 'Card', icon: 'star' }, { summaryKey: 'icon' })).toBe('star')
	})

	it('falls back to naming keys when the summary key is empty', () => {
		expect(summarizeValue({ title: 'Card', icon: '' }, { summaryKey: 'icon' })).toBe('Card')
	})

	it('reads a locale map in the active language', () => {
		expect(summarizeValue({ title: { en: 'Hello', uk: 'Привіт' } }, { locale: 'uk' })).toBe(
			'Привіт',
		)
	})

	it('uses the first filled values when nothing is name-like', () => {
		expect(summarizeValue({ lat: 50.45, lng: 30.52 })).toBe('50.45 · 30.52')
	})

	it('describes an object that only holds nested objects by its first filled child', () => {
		expect(
			summarizeValue({ image: { url: 'https://example.com/a.jpg', alt: 'Portrait' }, extra: {} }),
		).toBe('Image: Portrait · example.com/a.jpg')
	})

	it('does not mistake short structural keys for a locale map', () => {
		expect(summarizeValue({ x: { url: 'https://a.example', alt: 'Alt text' } })).toBe(
			'X: Alt text · a.example',
		)
	})

	it('returns null for an empty row', () => {
		expect(summarizeValue({ platform: '', url: '' })).toBeNull()
	})

	it('truncates long summaries', () => {
		const summary = summarizeValue({ title: 'x'.repeat(200) })
		expect(summary?.length).toBe(80)
		expect(summary?.endsWith('…')).toBe(true)
	})
})

describe('helpers', () => {
	it('shortens URLs', () => {
		expect(shortenUrl('https://www.example.com/')).toBe('example.com')
	})

	it('renders booleans as marks and ignores plain objects', () => {
		expect(scalarText(true)).toBe('✓')
		expect(scalarText({ nested: { a: 1 } })).toBeNull()
	})

	it('humanizes camel and snake case keys', () => {
		expect(humanizeKey('homeworkAfterLesson')).toBe('Homework after lesson')
		expect(humanizeKey('social_links')).toBe('Social links')
	})
})

describe('isTechnicalField', () => {
	it('collects counters, lifecycle twins and opaque values', () => {
		expect(isTechnicalField({ name: '__v' })).toBe(true)
		expect(isTechnicalField({ name: 'updatedAt' })).toBe(true)
		expect(isTechnicalField({ name: 'blob', ui: { opaque: true } })).toBe(true)
		expect(isTechnicalField({ name: 'notes', ui: { section: 'technical' } })).toBe(true)
	})

	it('leaves real content alone, including a field called version', () => {
		expect(isTechnicalField({ name: 'version' })).toBe(false)
		expect(isTechnicalField({ name: 'title' })).toBe(false)
	})

	it('lets an explicit main placement or a hidden flag win', () => {
		expect(isTechnicalField({ name: '__v', ui: { section: 'main' } })).toBe(false)
		expect(isTechnicalField({ name: '__v', ui: { hidden: true } })).toBe(false)
	})
})
