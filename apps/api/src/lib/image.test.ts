import { describe, expect, it } from 'vitest'
import { EXTENSION_FOR_MIME, uploadRejection } from './image.js'

// 1x1 PNG
const PNG = Buffer.from(
	'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
	'base64',
)

describe('uploadRejection', () => {
	it('accepts a real image with an allowlisted type', () => {
		expect(uploadRejection('image/png', PNG)).toBeNull()
	})
	it('refuses non-image types that used to slip past the image-only check', () => {
		expect(uploadRejection('text/html', Buffer.from('<script>1</script>'))).toMatch(/Unsupported/)
		expect(uploadRejection('application/octet-stream', Buffer.from('<svg/>'))).toMatch(
			/Unsupported/,
		)
		expect(uploadRejection('image/svg+xml', Buffer.from('<svg/>'))).toMatch(/Unsupported image/)
	})
	it('refuses a declared image that does not decode', () => {
		expect(uploadRejection('image/png', Buffer.from('<svg><script/></svg>'))).toMatch(
			/not a valid PNG/,
		)
	})
	it('keeps video and pdf on the allowlist', () => {
		expect(uploadRejection('video/mp4', Buffer.alloc(4))).toBeNull()
		expect(uploadRejection('application/pdf', Buffer.alloc(4))).toBeNull()
	})
	it('derives stored extensions from the MIME type', () => {
		expect(EXTENSION_FOR_MIME['image/jpeg']).toBe('jpg')
		expect(EXTENSION_FOR_MIME['text/html']).toBeUndefined()
	})
})
