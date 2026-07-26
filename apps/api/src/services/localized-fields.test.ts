import type { CollectionField } from '@innolope/config'
import { describe, expect, it } from 'vitest'
import {
	applyLocalizedWrite,
	findLocalizedBodyField,
	isLocaleKeyedObject,
	isLocaleMap,
} from './localized-fields.js'

const localizedArticle: CollectionField[] = [
	{ name: 'title', type: 'text', localized: true },
	{ name: 'content', type: 'text', localized: true },
	{ name: 'category', type: 'text' },
]

const plainArticle: CollectionField[] = [
	{ name: 'title', type: 'text' },
	{ name: 'content', type: 'text' },
]

describe('isLocaleMap', () => {
	it('accepts a map of locale codes to strings', () => {
		expect(isLocaleMap({ en: 'Hello', uk: 'Привіт' })).toBe(true)
	})

	it('accepts a project locale that is not a standard ISO code', () => {
		expect(isLocaleMap({ en: 'a', ua: 'b' }, ['en', 'ua'])).toBe(true)
	})

	it('rejects a structured object whose keys are not locales', () => {
		expect(isLocaleMap({ platform: 'linkedin', url: 'https://example.com' })).toBe(false)
	})

	it('rejects a map with non-string values', () => {
		expect(isLocaleMap({ en: { root: {} } })).toBe(false)
	})

	it('rejects empty objects, arrays and primitives', () => {
		expect(isLocaleMap({})).toBe(false)
		expect(isLocaleMap(['en'])).toBe(false)
		expect(isLocaleMap('en')).toBe(false)
		expect(isLocaleMap(null)).toBe(false)
	})
})

describe('findLocalizedBodyField', () => {
	it('finds the body field when it is translatable', () => {
		expect(findLocalizedBodyField(localizedArticle)).toBe('content')
	})

	it('returns null when the body field is not translatable', () => {
		expect(findLocalizedBodyField(plainArticle)).toBeNull()
	})

	it('stops at the first body-named field, like buildExternalData does', () => {
		// `content` wins over `body`, so a localized `body` must not be picked up —
		// the markdown goes into `content`, and folding it into `body` would write
		// the prose to a field nothing reads.
		const fields: CollectionField[] = [
			{ name: 'content', type: 'text' },
			{ name: 'body', type: 'text', localized: true },
		]
		expect(findLocalizedBodyField(fields)).toBeNull()
	})
})

describe('applyLocalizedWrite', () => {
	it('leaves metadata untouched when no field is translatable', () => {
		const metadata = { title: 'Hello' }
		const result = applyLocalizedWrite(
			plainArticle,
			{ metadata, markdown: 'Body text' },
			{ locale: 'en' },
		)
		expect(result).toBe(metadata)
	})

	it('files a bare string under the record locale', () => {
		const result = applyLocalizedWrite(
			localizedArticle,
			{ metadata: { title: 'Привіт' } },
			{ locale: 'uk' },
		)
		expect(result).toEqual({ title: { uk: 'Привіт' } })
	})

	it('keeps the other translations when writing one language', () => {
		const result = applyLocalizedWrite(
			localizedArticle,
			{ metadata: { title: 'Updated English' } },
			{ locale: 'en', existing: { title: { en: 'Old English', uk: 'Українська' } } },
		)
		expect(result).toEqual({ title: { en: 'Updated English', uk: 'Українська' } })
	})

	it('merges an explicit partial locale map instead of replacing the whole map', () => {
		const result = applyLocalizedWrite(
			localizedArticle,
			{ metadata: { title: { uk: 'Нова назва' } } },
			{ locale: 'en', existing: { title: { en: 'English title', uk: 'Стара назва' } } },
		)
		expect(result).toEqual({ title: { en: 'English title', uk: 'Нова назва' } })
	})

	it('deletes one translation when its slot is null, keeping the rest', () => {
		const result = applyLocalizedWrite(
			localizedArticle,
			{ metadata: { title: { uk: null } } },
			{ locale: 'en', existing: { title: { en: 'English title', uk: 'Стара назва' } } },
		)
		expect(result).toEqual({ title: { en: 'English title' } })
	})

	it('folds the whole field to null when deleting its last translation', () => {
		const result = applyLocalizedWrite(
			localizedArticle,
			{ metadata: { title: { en: null } } },
			{ locale: 'en', existing: { title: { en: 'English title' } } },
		)
		expect(result).toEqual({ title: null })
	})

	it('folds the markdown body into the localized body field', () => {
		const result = applyLocalizedWrite(
			localizedArticle,
			{ metadata: { title: 'Hi' }, markdown: 'The English body.' },
			{ locale: 'en', existing: { content: { uk: 'Український текст.' } } },
		)
		expect(result).toEqual({
			title: { en: 'Hi' },
			content: { en: 'The English body.', uk: 'Український текст.' },
		})
	})

	it('lets an explicit body in metadata win over the markdown', () => {
		const result = applyLocalizedWrite(
			localizedArticle,
			{
				metadata: { content: { en: 'Authored map', uk: 'Мапа' } },
				markdown: 'flattened preview copy',
			},
			{ locale: 'en' },
		)
		expect(result).toEqual({ content: { en: 'Authored map', uk: 'Мапа' } })
	})

	it('does not touch fields the write does not carry', () => {
		const result = applyLocalizedWrite(
			localizedArticle,
			{ metadata: { category: 'news' } },
			{ locale: 'en', existing: { title: { en: 'Kept', uk: 'Збережено' } } },
		)
		expect(result).toEqual({ category: 'news' })
	})

	it('passes non-text values through for the validator to judge', () => {
		const result = applyLocalizedWrite(
			localizedArticle,
			{ metadata: { title: 42 } },
			{ locale: 'en' },
		)
		expect(result).toEqual({ title: 42 })
	})

	it('handles a metadata-free write that only carries a body', () => {
		const result = applyLocalizedWrite(
			localizedArticle,
			{ markdown: 'Just the body.' },
			{ locale: 'uk' },
		)
		expect(result).toEqual({ content: { uk: 'Just the body.' } })
	})
})

describe('isLocaleKeyedObject', () => {
	it('accepts locale-keyed values regardless of value shape', () => {
		expect(isLocaleKeyedObject({ en: ['a'], uk: ['б'] })).toBe(true)
		expect(isLocaleKeyedObject({ en: { title: 'x' } })).toBe(true)
		expect(isLocaleKeyedObject({ ua: 'b' }, ['en', 'ua'])).toBe(true)
	})

	it('rejects objects with any non-locale key, empties, arrays and primitives', () => {
		expect(isLocaleKeyedObject({ en: 'a', platform: 'linkedin' })).toBe(false)
		expect(isLocaleKeyedObject({})).toBe(false)
		expect(isLocaleKeyedObject(['en'])).toBe(false)
		expect(isLocaleKeyedObject('en')).toBe(false)
		expect(isLocaleKeyedObject(null)).toBe(false)
	})
})

describe('applyLocalizedWrite — localized array fields', () => {
	const localizedTags: CollectionField[] = [{ name: 'tags', type: 'array', localized: true }]

	it('folds a bare array under the row locale, keeping other languages', () => {
		const out = applyLocalizedWrite(
			localizedTags,
			{ metadata: { tags: ['design', 'education'] } },
			{ locale: 'ua', existing: { tags: { en: ['old'] } } },
		)
		expect(out).toEqual({ tags: { en: ['old'], ua: ['design', 'education'] } })
	})

	it('merges a partial per-language array map without dropping the other language', () => {
		const out = applyLocalizedWrite(
			localizedTags,
			{ metadata: { tags: { ua: ['освіта'] } } },
			{ locale: 'en', existing: { tags: { en: ['design'] } } },
		)
		expect(out).toEqual({ tags: { en: ['design'], ua: ['освіта'] } })
	})
})
