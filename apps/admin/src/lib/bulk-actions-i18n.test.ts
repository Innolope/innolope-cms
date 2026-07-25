import { createInstance } from 'i18next'
import { describe, expect, it } from 'vitest'
import enCommon from '../locales/en/common.json'
import ukCommon from '../locales/uk/common.json'

/**
 * The bulk bar is built entirely from interpolated, pluralized keys, and the
 * riskiest one — the delete confirmation — is the single place a user is told
 * how many records are about to disappear. A missing plural form there would
 * render a raw key instead of a count, so resolve every string for real in both
 * languages.
 */
const translator = (lng: string) => {
	const instance = createInstance()
	instance.init({
		lng,
		resources: { en: { common: enCommon }, uk: { common: ukCommon } },
		// No fallback: a key missing from Ukrainian must fail here rather than
		// silently resolving to English.
		fallbackLng: false,
		ns: ['common'],
		defaultNS: 'common',
		interpolation: { escapeValue: false },
	})
	return instance.t.bind(instance)
}

/** Every non-pluralized label the bar renders. */
const FLAT_KEYS = [
	'selectAllMatching',
	'selectPage',
	'selectRow',
	'clear',
	'publish',
	'unpublish',
	'archive',
	'submitForReview',
	'setField',
	'delete',
	'deleteConfirm',
	'partial',
	'failed',
	'overLimit',
	'setFieldTitle',
	'setFieldNoFields',
	'setFieldValuePlaceholder',
	'setFieldApply',
]

/** Keys that take a `count` and must have a form for every plural category. */
const COUNTED_KEYS = ['selected', 'deleteTitle', 'deleteMessage', 'done', 'setFieldMessage']

describe.each(['en', 'uk'])('bulk actions bar (%s)', (lng) => {
	const t = translator(lng)
	const resolves = (key: string, value: string) => value !== key && value.trim().length > 0

	it('resolves every label', () => {
		for (const name of FLAT_KEYS) {
			const key = `collections.bulk.${name}`
			expect(resolves(key, t(key, { count: 3, max: 500 }))).toBe(true)
		}
	})

	it('resolves counted strings across plural categories', () => {
		// 1 / 2 / 5 cover Ukrainian's one, few and many — the categories a
		// naive en-style two-form translation would miss.
		for (const name of COUNTED_KEYS) {
			for (const count of [1, 2, 5]) {
				const key = `collections.bulk.${name}`
				const value = t(key, { count })
				expect(resolves(key, value)).toBe(true)
				expect(value).toContain(String(count))
			}
		}
	})

	it('spells out that a bulk delete also hits the external database', () => {
		// The one warning a user must not miss: this is not just a CMS-side removal.
		const message = t('collections.bulk.deleteMessage', { count: 3 })
		expect(message.length).toBeGreaterThan(40)
		expect(/external|зовнішн/i.test(message)).toBe(true)
	})

	it('reports partial failures with both counts and a reason', () => {
		const message = t('collections.bulk.partial', {
			succeeded: 4,
			failed: 2,
			reason: 'Collection is read-only: media',
		})
		expect(message).toContain('4')
		expect(message).toContain('2')
		expect(message).toContain('Collection is read-only: media')
	})
})
