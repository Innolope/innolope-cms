import { describe, expect, it } from 'vitest'
import { comparisonRows, comparisonText } from './sync-comparison'

describe('comparison invariants', () => {
	it.each([
		'constructor',
		'toString',
		'__proto__',
	])('treats absent %s as missing, never inherited', (key) => {
		const incoming = JSON.parse(`{"${key}":"changed"}`)
		expect(comparisonRows({}, incoming)).toEqual([
			{ path: [key], local: undefined, external: 'changed' },
		])
	})
	it('preserves primitive type changes', () => {
		expect(comparisonRows({ count: 1, flag: false }, { count: '1', flag: 'false' })).toHaveLength(2)
	})
	it('reconstructs both inputs over 300 generated Unicode edit sequences (seed9317)', () => {
		let seed = 9317
		const random = () => {
			seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
			return seed
		}
		const alphabet = ['a', 'b', ' ', '\n', 'ї', 'Ґ', '😀', '<', '>', 'é']
		for (let index = 0; index < 300; index++) {
			const a = Array.from(
				{ length: random() % 100 },
				() => alphabet[random() % alphabet.length],
			).join('')
			const b = Array.from(
				{ length: random() % 100 },
				() => alphabet[random() % alphabet.length],
			).join('')
			const { parts } = comparisonText(a, b)
			expect(
				parts
					.filter((part) => !part.added)
					.map((part) => part.value)
					.join(''),
			).toBe(a)
			expect(
				parts
					.filter((part) => !part.removed)
					.map((part) => part.value)
					.join(''),
			).toBe(b)
		}
	})
})
