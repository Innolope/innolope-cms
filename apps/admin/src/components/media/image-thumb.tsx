import { useState } from 'react'

/**
 * Shared image rendering for every media surface (relation pickers, the media
 * grid, the body image picker).
 *
 * Imported libraries routinely contain rows the CMS cannot render: a path shape
 * we can't resolve, an asset deleted from the provider, or a value that isn't a
 * URL at all. Left to the browser those become the broken-image glyph, which
 * reads as "the CMS is broken" rather than "this one file is missing" — so
 * anything that fails to load falls back to a neutral placeholder instead.
 */
export function ImagePlaceholderIcon({ className }: { className?: string }) {
	return (
		<svg
			className={className}
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth="1.5"
			strokeLinecap="round"
			strokeLinejoin="round"
			aria-hidden="true"
		>
			<rect x="3" y="3" width="18" height="18" rx="2" />
			<circle cx="8.5" cy="8.5" r="1.5" />
			<path d="m21 15-5-5L5 21" />
		</svg>
	)
}

/** True when a string is usable as an <img> src (absolute URL, root path, or data URI). */
export function isImageUrl(value: string): boolean {
	return /^(https?:\/\/|\/|data:image\/)/i.test(value.trim())
}

interface ImageThumbProps {
	url: string
	className: string
	alt?: string
	/** Rendered in place of the icon when the image can't be shown. */
	placeholderLabel?: string
}

export function ImageThumb({ url, className, alt = '', placeholderLabel }: ImageThumbProps) {
	// Remember *which* url failed rather than a bare boolean: a new url is then
	// retried automatically, so repointing a row at a good file clears the
	// placeholder without needing an effect to reset the flag.
	const [failedUrl, setFailedUrl] = useState<string | null>(null)

	if (url && isImageUrl(url) && failedUrl !== url) {
		return <img src={url} alt={alt} className={className} onError={() => setFailedUrl(url)} />
	}
	return (
		<div
			className={`${className} flex flex-col items-center justify-center gap-1 bg-input text-text-muted`}
			title={placeholderLabel}
		>
			<ImagePlaceholderIcon className="h-1/3 w-1/3 max-h-8 max-w-8" />
			{placeholderLabel && (
				<span className="px-1 text-[10px] leading-tight text-center truncate max-w-full">
					{placeholderLabel}
				</span>
			)}
		</div>
	)
}
