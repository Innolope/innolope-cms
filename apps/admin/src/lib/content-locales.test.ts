import { describe, expect, it } from 'vitest'
import { CONTENT_LOCALES, localeLabel } from './content-locales'

describe('localeLabel', () => {
	it('renders a human-readable name with the code in parentheses', () => {
		expect(localeLabel('en')).toBe('English (en)')
		expect(localeLabel('fr')).toBe('French (fr)')
	})

	it('localizes the name to the UI language when provided', () => {
		expect(localeLabel('en', 'fr')).toBe('anglais (en)')
	})

	it('falls back to the raw code for structurally invalid input', () => {
		expect(localeLabel('123')).toBe('123')
	})
})

describe('CONTENT_LOCALES', () => {
	it('contains the app default locales and has no duplicates', () => {
		expect(CONTENT_LOCALES).toContain('en')
		expect(CONTENT_LOCALES).toContain('uk')
		expect(new Set(CONTENT_LOCALES).size).toBe(CONTENT_LOCALES.length)
	})
})
