import { describe, expect, it, vi } from 'vitest'

vi.mock('./i18n', () => ({
	default: { language: 'en', t: (key: string) => key },
}))

const { absoluteDate, isFuture, relativeTime } = await import('./relative-time')

describe('relativeTime', () => {
	it('reports very recent times as "just now"', () => {
		expect(relativeTime(Date.now())).toBe('common.time.justNow')
	})

	it('formats past times in the largest fitting unit', () => {
		expect(relativeTime(Date.now() - 2 * 60 * 60 * 1000)).toMatch(/hour/)
	})

	it('formats future times', () => {
		expect(relativeTime(Date.now() + 3 * 24 * 60 * 60 * 1000)).toMatch(/day/)
	})
})

describe('isFuture', () => {
	it('is true only for moments ahead of now', () => {
		expect(isFuture(Date.now() + 60_000)).toBe(true)
		expect(isFuture(Date.now() - 60_000)).toBe(false)
	})

	it('accepts ISO strings and Date objects', () => {
		expect(isFuture(new Date(Date.now() + 86_400_000).toISOString())).toBe(true)
		expect(isFuture(new Date('2001-01-01'))).toBe(false)
	})

	it('treats empty, unparseable and non-date values as not scheduled', () => {
		expect(isFuture(null)).toBe(false)
		expect(isFuture(undefined)).toBe(false)
		expect(isFuture('')).toBe(false)
		expect(isFuture('not a date')).toBe(false)
		expect(isFuture({ en: '2099-01-01' })).toBe(false)
		expect(isFuture(new Date('nope'))).toBe(false)
	})
})

describe('absoluteDate', () => {
	it('renders a locale string containing the year', () => {
		expect(absoluteDate(new Date('2031-05-15T10:00:00Z'))).toContain('2031')
	})
})
