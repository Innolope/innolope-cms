export interface InnolopeConfig {
	name: string
	locales: string[]
	defaultLocale: string
	media: {
		adapter: 'cloudflare' | 'local' | 's3'
		maxUploadSize: number
		allowedMimeTypes: string[]
		imageVariants: Record<string, { width: number; height?: number; fit?: string }>
	}
	auth: {
		sessionMaxAge: number
		apiKeyMaxAge: number | null
	}
}

export const defaultConfig: InnolopeConfig = {
	name: 'Innolope CMS',
	locales: ['en'],
	defaultLocale: 'en',
	media: {
		adapter: 'local',
		maxUploadSize: 50 * 1024 * 1024, // 50MB
		allowedMimeTypes: [
			'image/jpeg',
			'image/png',
			'image/webp',
			'image/gif',
			'image/svg+xml',
			'video/mp4',
			'video/webm',
			'application/pdf',
		],
		imageVariants: {
			thumbnail: { width: 300, height: 300, fit: 'cover' },
			small: { width: 600 },
			medium: { width: 900 },
			large: { width: 1200 },
		},
	},
	auth: {
		sessionMaxAge: 7 * 24 * 60 * 60, // 7 days
		apiKeyMaxAge: null, // no expiry by default
	},
}
