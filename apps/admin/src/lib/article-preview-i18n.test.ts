import { createInstance } from 'i18next'
import { describe, expect, it } from 'vitest'
import enCommon from '../locales/en/common.json'
import ukCommon from '../locales/uk/common.json'

/**
 * A failed capture is explained by the message for its API error code. A code
 * without a translation would fall back to the server's English text in the
 * Ukrainian UI, so every code the API can return must resolve in both languages.
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

const ERROR_CODES = [
	'generic',
	'INVALID_URL',
	'BLOCKED_URL',
	'FETCH_FAILED',
	'BLOCKED_BY_SITE',
	'NOT_HTML',
	'TOO_LARGE',
	'CLIENT_RENDERED',
	'NO_ARTICLE_FOUND',
	'SELECTOR_NOT_FOUND',
]

describe.each(['en', 'uk'])('article preview strings (%s)', (lng) => {
	const t = translator(lng)

	it.each(ERROR_CODES)('explains the %s capture error', (code) => {
		const key = `editor.articlePreview.errors.${code}`
		const value = t(key)
		expect(value).not.toBe(key)
		expect(value.trim().length).toBeGreaterThan(0)
	})

	it('pluralizes the notes counter', () => {
		for (const count of [1, 2, 5, 21]) {
			const value = t('editor.articlePreview.notes', { count })
			expect(value).toContain(String(count))
			expect(value).not.toContain('editor.articlePreview')
		}
	})

	it('interpolates the capture source and time', () => {
		const value = t('editor.articlePreview.capturedFrom', {
			host: 'blog.example.com',
			time: '5m ago',
		})
		expect(value).toContain('blog.example.com')
		expect(value).toContain('5m ago')
	})
})
