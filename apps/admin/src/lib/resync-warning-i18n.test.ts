import { createInstance } from 'i18next'
import { describe, expect, it } from 'vitest'
import enCommon from '../locales/en/common.json'
import ukCommon from '../locales/uk/common.json'

/**
 * The re-sync drop dialog is assembled from interpolated, pluralized keys, so a
 * typo'd path or a missing plural form shows up as a raw key string in a modal
 * the user only sees when they are about to lose fields. Resolve the strings for
 * real, in both languages, rather than trusting the JSON.
 */
const translator = (lng: string) => {
	const instance = createInstance()
	instance.init({
		lng,
		resources: { en: { common: enCommon }, uk: { common: ukCommon } },
		// No fallback: a key missing from Ukrainian must fail here, not silently
		// resolve to the English string.
		fallbackLng: false,
		ns: ['common'],
		defaultNS: 'common',
		interpolation: { escapeValue: false },
	})
	return instance.t.bind(instance)
}

describe.each(['en', 'uk'])('re-sync drop dialog (%s)', (lng) => {
	const t = translator(lng)
	const resolves = (key: string, value: string) => value !== key && value.trim().length > 0

	it('has a title, a confirm label and the "configured" tag', () => {
		for (const key of [
			'settings.database.resyncDropTitle',
			'settings.database.resyncDropConfirm',
			'settings.database.fieldConfigured',
		]) {
			expect(resolves(key, t(key))).toBe(true)
		}
	})

	it('renders the message for singular and plural counts with the detail spliced in', () => {
		for (const count of [1, 2, 5]) {
			const key = 'settings.database.resyncDropMessage'
			const message = t(key, { count, detail: 'Articles — legacyNotes (configured)' })
			expect(resolves(key, message)).toBe(true)
			expect(message).toContain(String(count))
			expect(message).toContain('Articles — legacyNotes (configured)')
		}
	})
})
