import type { collections } from '@innolope/db'
import { describe, expect, it } from 'vitest'
import { decodeImageData, detectMediaFields, INLINE_MAX_BYTES } from './media-ingest-policy.js'

describe('media review policy regressions', () => {
	it('reserves an overridden alt field before inferring the filename', () => {
		const collection = {
			fields: ['path', 'name', 'filename'].map((name) => ({ name, type: 'text' })),
		} as typeof collections.$inferSelect
		expect(
			detectMediaFields(collection, { adapter: 'r2', pathColumn: 'path' }, { alt: 'name' }),
		).toMatchObject({ path: 'path', filename: 'filename', alt: 'name' })
	})
	it('accepts wrapped base64 and normalizes the image/jpg data URI alias', () => {
		const bytes = Buffer.from('a sample image payload')
		const encoded = bytes.toString('base64').replace(/(.{8})/g, '$1\r\n')
		expect(decodeImageData(encoded).buffer).toEqual(bytes)
		expect(decodeImageData(`data:image/jpg;base64,${encoded}`)).toEqual({
			buffer: bytes,
			declared: 'image/jpeg',
		})
	})
	it('still rejects invalid wrapped input and enforces the decoded limit', () => {
		expect(() => decodeImageData('YWJj\n!!!!')).toThrow(/base64 -w0/)
		const encoded = Buffer.alloc(INLINE_MAX_BYTES + 1)
			.toString('base64')
			.replace(/(.{76})/g, '$1\n')
		expect(() => decodeImageData(encoded)).toThrow(/create_media_upload/)
	})
})
