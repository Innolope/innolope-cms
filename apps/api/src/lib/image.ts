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

/** Video containers accepted for upload (Cloudflare Stream ingests these). */
export const ALLOWED_VIDEO_MIME = new Set(['video/mp4', 'video/webm', 'video/quicktime'])
/** Non-media documents accepted for upload. */
export const ALLOWED_DOCUMENT_MIME = new Set(['application/pdf'])

/** Extension the stored object gets — derived from the MIME type, never from the client's filename. */
export const EXTENSION_FOR_MIME: Record<string, string> = {
	'image/jpeg': 'jpg',
	'image/png': 'png',
	'image/webp': 'webp',
	'image/gif': 'gif',
	'image/avif': 'avif',
	'video/mp4': 'mp4',
	'video/webm': 'webm',
	'video/quicktime': 'mov',
	'application/pdf': 'pdf',
}

/**
 * Upload gate: the declared type must be on an allowlist (an unknown type is
 * refused, never stored as-is), and an image must actually decode as one so a
 * script-bearing document cannot masquerade as a picture.
 */
export function uploadRejection(mime: string, buffer: Uint8Array): string | null {
	if (ALLOWED_IMAGE_MIME.has(mime)) {
		return getImageDimensions(buffer)
			? null
			: `The file is not a valid ${mime.slice('image/'.length).toUpperCase()} image.`
	}
	if (mime.startsWith('image/')) {
		return `Unsupported image type: ${mime}. Use JPEG, PNG, WebP, GIF or AVIF.`
	}
	if (ALLOWED_VIDEO_MIME.has(mime) || ALLOWED_DOCUMENT_MIME.has(mime)) return null
	return `Unsupported file type: ${mime}. Upload an image (JPEG, PNG, WebP, GIF, AVIF), a video (MP4, WebM, MOV) or a PDF.`
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
