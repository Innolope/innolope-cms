import { imageSize } from 'image-size'

/**
 * Raster image formats accepted for upload. `image/svg+xml` is intentionally excluded —
 * inline SVG can carry scripts and is an XSS vector when served from the media domain.
 */
export const ALLOWED_IMAGE_MIME = new Set([
	'image/jpeg',
	'image/png',
	'image/webp',
	'image/gif',
	'image/avif',
])

/** True when `mime` is an `image/*` type that is NOT in the allowlist. */
export function isRejectedImageMime(mime: string): boolean {
	return mime.startsWith('image/') && !ALLOWED_IMAGE_MIME.has(mime)
}

/** Decode pixel dimensions from an image buffer, or null if it can't be parsed. */
export function getImageDimensions(buffer: Uint8Array): { width: number; height: number } | null {
	try {
		const { width, height } = imageSize(buffer)
		if (typeof width === 'number' && typeof height === 'number') return { width, height }
		return null
	} catch {
		return null
	}
}
