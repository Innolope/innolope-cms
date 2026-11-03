import { describe, expect, it } from 'vitest'
import {
	isLocaleMap,
	readEditableTitle,
	resolveLocalizedValue,
	titleMetadataPatch,
} from './locale-value'

describe('isLocaleMap', () => {
	it('recognizes a map keyed by configured locales', () => {
		expect(isLocaleMap({ en: 'a', uk: 'b' }, ['en', 'uk'])).toBe(true)
	})

	it('recognizes known ISO codes even when not in project locales', () => {
		expect(isLocaleMap({ ua: 'Привіт' }, [])).toBe(true)
	})

	it('accepts a configured locale that is not a standard ISO code', () => {
		expect(isLocaleMap({ en: 'a', custom: 'b' }, ['en', 'custom'])).toBe(true)
	})

	it('rejects structured objects whose keys are not locales', () => {
		expect(isLocaleMap({ platform: 'linkedin', url: 'https://x' }, [])).toBe(false)
	})

	it('rejects when any value is not a string', () => {
		expect(isLocaleMap({ en: 42 }, ['en'])).toBe(false)
	})

	it('rejects unknown short codes that are not configured', () => {
		expect(isLocaleMap({ en: 'a', xx: 'b' }, ['en'])).toBe(false)
	})

	it('rejects arrays, empty objects, and non-objects', () => {
		expect(isLocaleMap(['en'], ['en'])).toBe(false)
		expect(isLocaleMap({}, ['en'])).toBe(false)
		expect(isLocaleMap(null, ['en'])).toBe(false)
		expect(isLocaleMap('en', ['en'])).toBe(false)
	})
})

describe('resolveLocalizedValue', () => {
	it('returns trimmed plain strings, null for blank', () => {
		expect(resolveLocalizedValue('  hi  ')).toBe('hi')
		expect(resolveLocalizedValue('')).toBeNull()
	})

	it('prefers the default locale, then en, then first non-empty', () => {
		expect(resolveLocalizedValue({ en: 'E', uk: 'U' }, { defaultLocale: 'uk' })).toBe('U')
		expect(resolveLocalizedValue({ en: 'E', uk: 'U' })).toBe('E')
		expect(resolveLocalizedValue({ fr: 'F' })).toBe('F')
	})

	it('skips blank locale entries', () => {
		expect(resolveLocalizedValue({ en: '   ' })).toBeNull()
		expect(resolveLocalizedValue({ en: '   ', fr: 'F' })).toBe('F')
	})

	it('returns null for null, numbers, and arrays', () => {
		expect(resolveLocalizedValue(null)).toBeNull()
		expect(resolveLocalizedValue(42)).toBeNull()
		expect(resolveLocalizedValue(['a'])).toBeNull()
	})
})

describe('editing a title in one plain input', () => {
	it('shows the row language of a localized title and leaves it out of the save when untouched', () => {
		const source = readEditableTitle({ en: 'Hello', uk: 'Привіт' }, 'uk')
		expect(source.shown).toBe('Привіт')
		expect(titleMetadataPatch(source, 'Привіт')).toEqual({})
	})

	it('writes an edit into the row language and keeps the other languages', () => {
		const source = readEditableTitle({ en: 'Hello', uk: 'Привіт' }, 'uk')
		expect(titleMetadataPatch(source, 'Вітаю')).toEqual({ title: { en: 'Hello', uk: 'Вітаю' } })
	})

	it('falls back to another language for display when the row language has none', () => {
		const source = readEditableTitle({ en: 'Hello' }, 'uk')
		expect(source.shown).toBe('Hello')
		expect(titleMetadataPatch(source, 'Hello')).toEqual({})
		expect(titleMetadataPatch(source, 'Привіт')).toEqual({ title: { en: 'Hello', uk: 'Привіт' } })
	})

	it.each([
		['a plain title', 'Hello', 'Hello'],
		['no title yet', undefined, ''],
		['a value that is not text', 42, ''],
	])('saves %s as plain text, as before', (_case, raw, shown) => {
		const source = readEditableTitle(raw, 'en')
		expect(source.shown).toBe(shown)
		expect(titleMetadataPatch(source, 'New')).toEqual({ title: 'New' })
	})
})
