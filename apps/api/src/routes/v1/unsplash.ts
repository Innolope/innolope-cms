import type { FastifyInstance } from 'fastify'

const UNSPLASH_API = 'https://api.unsplash.com'

interface UnsplashPhoto {
	id: string
	urls: { raw: string; full: string; regular: string; small: string; thumb: string }
	alt_description: string | null
	description: string | null
	width: number
	height: number
	color: string
	user: { name: string; username: string; links: { html: string } }
	links: { download_location: string }
}

export async function unsplashRoutes(app: FastifyInstance) {
	const getAccessKey = () =>
		process.env.UNSPLASH_ACCESS_KEY || null

	// Check if Unsplash is configured
	app.get('/status', { preHandler: [app.requireProject('viewer')] }, async () => {
		return { enabled: !!getAccessKey() }
	})

	// Search photos
	app.get('/search', { preHandler: [app.requireProject('viewer')] }, async (request, reply) => {
		const accessKey = getAccessKey()
		if (!accessKey) {
			return reply.status(503).send({ error: 'Unsplash not configured' })
		}

		const { q, page = 1, per_page = 20 } = request.query as {
			q: string
			page?: number
			per_page?: number
		}

		if (!q || !q.trim()) {
			return reply.status(400).send({ error: 'Query parameter "q" is required' })
		}

		const params = new URLSearchParams({
			query: q,
			page: String(page),
			per_page: String(Math.min(Number(per_page), 30)),
		})

		const res = await fetch(`${UNSPLASH_API}/search/photos?${params}`, {
			headers: {
				Authorization: `Client-ID ${accessKey}`,
				'Accept-Version': 'v1',
			},
		})

		if (!res.ok) {
			const err = await res.json().catch(() => ({}))
			return reply.status(res.status).send({
				error: `Unsplash API error: ${(err as { errors?: string[] }).errors?.[0] || res.statusText}`,
			})
		}

		const data = (await res.json()) as {
			total: number
			total_pages: number
			results: UnsplashPhoto[]
		}

		return {
			total: data.total,
			totalPages: data.total_pages,
			page: Number(page),
			results: data.results.map(normalizePhoto),
		}
	})

	// Track download (required by Unsplash API guidelines)
	app.post<{ Params: { id: string } }>(
		'/download/:id',
		{ preHandler: [app.requireProject('viewer')] },
		async (request, reply) => {
			const accessKey = getAccessKey()
			if (!accessKey) {
				return reply.status(503).send({ error: 'Unsplash not configured' })
			}

			// Fetch the photo to get download_location
			const photoRes = await fetch(`${UNSPLASH_API}/photos/${request.params.id}`, {
				headers: {
					Authorization: `Client-ID ${accessKey}`,
					'Accept-Version': 'v1',
				},
			})

			if (!photoRes.ok) {
				return reply.status(photoRes.status).send({ error: 'Photo not found' })
			}

			const photo = (await photoRes.json()) as UnsplashPhoto

			// Trigger download tracking (required by Unsplash)
			await fetch(photo.links.download_location, {
				headers: { Authorization: `Client-ID ${accessKey}` },
			}).catch(() => {})

			return { tracked: true, id: request.params.id }
		},
	)
}

function normalizePhoto(photo: UnsplashPhoto) {
	return {
		id: photo.id,
		url: photo.urls.regular,
		thumbUrl: photo.urls.small,
		fullUrl: photo.urls.full,
		width: photo.width,
		height: photo.height,
		color: photo.color,
		alt: photo.alt_description || photo.description || '',
		author: photo.user.name,
		authorUsername: photo.user.username,
		authorUrl: photo.user.links.html,
		unsplashUrl: `https://unsplash.com/photos/${photo.id}`,
	}
}
