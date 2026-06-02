import { describe, expect, it, vi } from 'vitest'

vi.mock('./i18n', () => ({
	default: { language: 'en', t: (key: string) => key },
}))

const { absoluteDate, relativeTime } = await import('./relative-time')

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

describe('absoluteDate', () => {
	it('renders a locale string containing the year', () => {
		expect(absoluteDate(new Date('2031-05-15T10:00:00Z'))).toContain('2031')
	})
})
