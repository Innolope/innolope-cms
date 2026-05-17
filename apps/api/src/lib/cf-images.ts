/**
 * Cloudflare Images delivery URLs (`imagedelivery.net/<hash>/<id>/<variant>`) support
 * inline "flexible variant" transforms. We don't resize anything ourselves — we just
 * emit the transform URLs and let Cloudflare render the derivative on demand.
 *
 * Flexible variants must be enabled on the Cloudflare Images account for the sized
 * URLs to resolve; the original `<variant>` URL keeps working regardless.
 */

const CF_IMAGES_RE = /^(https:\/\/imagedelivery\.net\/[^/]+\/[^/]+)\/[^/?]+\/?$/

export function isCfImagesUrl(url: string): boolean {
	return CF_IMAGES_RE.test(url)
}

/** Replace the variant segment of a Cloudflare Images URL with a flexible-variant transform. */
export function cfImageUrl(url: string, transform: string): string {
	const match = url.match(CF_IMAGES_RE)
	if (!match) return url
	return `${match[1]}/${transform}`
}

/** Standard responsive renditions for a Cloudflare Images URL, or undefined if not CF Images. */
export function cfImageVariants(url: string): Record<string, string> | undefined {
	if (!isCfImagesUrl(url)) return undefined
	return {
		thumbnail: cfImageUrl(url, 'w=160,fit=scale-down,format=auto'),
		small: cfImageUrl(url, 'w=480,fit=scale-down,format=auto'),
		medium: cfImageUrl(url, 'w=1024,fit=scale-down,format=auto'),
		large: cfImageUrl(url, 'w=2048,fit=scale-down,format=auto'),
	}
}
