import { createInstance } from 'i18next'
import { describe, expect, it } from 'vitest'
import enCommon from '../locales/en/common.json'
import ukCommon from '../locales/uk/common.json'

/**
 * The upload modal's footer button carries the number of files about to be
 * written to the project's (possibly external) storage, and the failure toast
 * carries how many did NOT make it — strings a user must never see as raw keys
 * or without their counts. Resolve them for real in both languages, plural
 * categories included.
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

const FLAT_KEYS = ['title', 'dropHint', 'browse']

/** Keys that take a `count` and must have a form for every plural category. */
const COUNTED_KEYS = ['uploadCount', 'uploadedCount']

describe.each(['en', 'uk'])('upload modal (%s)', (lng) => {
	const t = translator(lng)
	const resolves = (key: string, value: string) => value !== key && value.trim().length > 0

	it('resolves every label', () => {
		for (const name of FLAT_KEYS) {
			const key = `mediaRoute.uploadModal.${name}`
			expect(resolves(key, t(key))).toBe(true)
		}
	})

	it('resolves counted strings across plural categories', () => {
		// 1 / 2 / 5 cover Ukrainian's one, few and many — the categories a
		// naive en-style two-form translation would miss.
		for (const name of COUNTED_KEYS) {
			for (const count of [1, 2, 5]) {
				const key = `mediaRoute.uploadModal.${name}`
				const value = t(key, { count })
				expect(resolves(key, value)).toBe(true)
				expect(value).toContain(String(count))
			}
		}
	})

	it('names the upload destination', () => {
		const value = t('mediaRoute.uploadModal.destination', { target: 'blog-media' })
		expect(value).toContain('blog-media')
	})

	it('reports partial failures with both counts', () => {
		const value = t('mediaRoute.uploadModal.partialFailed', { failed: 2, total: 5 })
		expect(value).toContain('2')
		expect(value).toContain('5')
	})
})
