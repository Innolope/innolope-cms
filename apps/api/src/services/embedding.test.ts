import { describe, expect, it } from 'vitest'
import { chunkText } from './embedding.js'

describe('chunkText', () => {
	it('returns an empty array for empty or whitespace-only input', () => {
		expect(chunkText('')).toEqual([])
		expect(chunkText('   \n   ')).toEqual([])
	})

	it('returns a single trimmed chunk for short text', () => {
		expect(chunkText('  hello world  ')).toEqual(['hello world'])
	})

	it('splits into multiple chunks when blocks exceed the max size', () => {
		const chunks = chunkText('aaaa\n\nbbbb', 4)
		expect(chunks).toEqual(['aaaa', 'bbbb'])
	})

	it('keeps small adjacent paragraphs together', () => {
		expect(chunkText('para one\n\npara two')).toEqual(['para one\n\npara two'])
	})
})
