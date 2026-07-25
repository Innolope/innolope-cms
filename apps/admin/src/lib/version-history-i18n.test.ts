import { createInstance } from 'i18next'
import { describe, expect, it } from 'vitest'
import enCommon from '../locales/en/common.json'
import ukCommon from '../locales/uk/common.json'

/**
 * The version banner is the only thing telling a user that everything on screen
 * is old content. If one of its keys fails to resolve they see a raw key string
 * and may take the page for the current record, so resolve them all for real in
 * both languages.
 */
const translator = (lng: string) => {
	const instance = createInstance()
	instance.init({
		lng,
		resources: { en: { common: enCommon }, uk: { common: ukCommon } },
		fallbackLng: false,
		ns: ['common'],
		defaultNS: 'common',
		interpolation: { escapeValue: false },
	})
	return instance.t.bind(instance)
}

const FLAT_KEYS = [
	'viewingHint',
	'backToCurrent',
	'restoreThis',
	'revert',
	'reverting',
	'revertTitle',
	'revertFailed',
	'discardTitle',
	'discardMessage',
	'discardConfirm',
]

describe.each(['en', 'uk'])('version history (%s)', (lng) => {
	const t = translator(lng)
	const resolves = (key: string, value: string) => value !== key && value.trim().length > 0

	it('resolves every label', () => {
		for (const name of FLAT_KEYS) {
			const key = `versions.${name}`
			expect(resolves(key, t(key))).toBe(true)
		}
	})

	it('names both the viewed and the current version in the banner', () => {
		// Showing only one number is the failure mode that makes the banner useless:
		// "you are on v3" doesn't say whether v3 is old.
		const message = t('versions.viewingBanner', { version: 3, current: 7 })
		expect(message).toContain('3')
		expect(message).toContain('7')
	})

	it('marks the current entry in the dropdown', () => {
		const label = t('versions.currentOption', { version: 7 })
		expect(label).toContain('7')
		expect(resolves('versions.currentOption', label)).toBe(true)
	})

	it('names the version in the restore confirmation and its result', () => {
		for (const key of ['versions.revertMessage', 'versions.restored']) {
			const value = t(key, { version: 4 })
			expect(resolves(key, value)).toBe(true)
			expect(value).toContain('4')
		}
	})
})
