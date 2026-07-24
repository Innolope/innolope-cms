import { describe, expect, it } from 'vitest'
import { detectLocaleScriptMismatch } from './content-validation.js'

const UK_TEXT =
	'Це стаття про приготування борщу. Борщ — традиційна українська страва, яку готують з буряка, капусти та інших овочів.'
const EN_TEXT =
	'This is an article about cooking borscht, the traditional Ukrainian dish made with beets, cabbage and other vegetables.'

describe('detectLocaleScriptMismatch', () => {
	it('warns when Cyrillic text is filed under an "en" locale and "uk" is configured', () => {
		const warning = detectLocaleScriptMismatch(UK_TEXT, 'en', ['en', 'uk'])
		expect(warning).toContain('Cyrillic')
		expect(warning).toContain('"uk"')
	})

	it('warns in the opposite direction (English text under "uk")', () => {
		const warning = detectLocaleScriptMismatch(EN_TEXT, 'uk', ['en', 'uk'])
		expect(warning).toContain('Latin')
		expect(warning).toContain('"en"')
	})

	it('stays silent when the locale matches the script', () => {
		expect(detectLocaleScriptMismatch(UK_TEXT, 'uk', ['en', 'uk'])).toBeNull()
		expect(detectLocaleScriptMismatch(EN_TEXT, 'en', ['en', 'uk'])).toBeNull()
	})

	it('stays silent when no configured locale matches the detected script', () => {
		// Project only has "en" — Cyrillic content may be intentional; nothing to suggest.
		expect(detectLocaleScriptMismatch(UK_TEXT, 'en', ['en'])).toBeNull()
	})

	it('stays silent on short or mixed-language text', () => {
		expect(detectLocaleScriptMismatch('Привіт', 'en', ['en', 'uk'])).toBeNull()
		expect(detectLocaleScriptMismatch(`${UK_TEXT} ${EN_TEXT}`, 'en', ['en', 'uk'])).toBeNull()
	})

	it('handles region-qualified locales', () => {
		expect(detectLocaleScriptMismatch(UK_TEXT, 'en-US', ['en-US', 'uk-UA'])).toContain('"uk-UA"')
	})

	it('treats the informal "ua" code as Cyrillic (Klekit configures en+ua)', () => {
		expect(detectLocaleScriptMismatch(UK_TEXT, 'en', ['en', 'ua'])).toContain('"ua"')
		expect(detectLocaleScriptMismatch(UK_TEXT, 'ua', ['en', 'ua'])).toBeNull()
	})
})
