import { describe, expect, it } from 'vitest'
import { cleanFieldProposal, sampleKeys } from './ai.js'

describe('sampleKeys', () => {
	it('collects keys from objects and from rows of arrays', () => {
		expect(sampleKeys([{ a: 1, b: 2 }, [{ c: 3 }, { a: 4 }]])).toEqual(['a', 'b', 'c'])
	})
})

describe('cleanFieldProposal', () => {
	it('keeps a known preset and mappings onto real keys only', () => {
		const proposal = cleanFieldProposal(
			{
				label: 'Price',
				helpText: 'What it costs',
				preset: 'money',
				presetKeys: { amount: 'value', currency: 'made_up' },
				summaryKey: 'value',
				subFields: [
					{ name: 'value', label: 'Amount' },
					{ name: 'ghost', label: 'Invented' },
				],
			},
			['value', 'code'],
		)
		expect(proposal).toEqual({
			label: 'Price',
			helpText: 'What it costs',
			preset: 'money',
			presetKeys: { amount: 'value' },
			summaryKey: 'value',
			subFields: [{ name: 'value', label: 'Amount' }],
		})
	})

	it('drops an unknown preset and garbage', () => {
		expect(cleanFieldProposal({ preset: 'hologram', summaryKey: 5 }, ['a'])).toEqual({
			preset: null,
			summaryKey: null,
		})
		expect(cleanFieldProposal('not an object', [])).toEqual({ preset: null, summaryKey: null })
	})
})
