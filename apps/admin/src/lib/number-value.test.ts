import { describe, expect, it } from 'vitest'
import { toNumberValue } from './number-value'

describe('toNumberValue', () => {
	it('emits ordinary numbers as numbers', () => {
		expect(toNumberValue('42')).toBe(42)
		expect(toNumberValue('19.99')).toBe(19.99)
		expect(toNumberValue('1.0')).toBe(1)
		expect(toNumberValue('-0.5')).toBe(-0.5)
	})

	it('keeps digits a float would round as an exact string', () => {
		expect(toNumberValue('9007199254740993')).toBe('9007199254740993')
		expect(toNumberValue('12345678901234.123456')).toBe('12345678901234.123456')
	})
})
