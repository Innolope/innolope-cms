import { content, projects } from '@innolope/db'
import type { FastifyInstance } from 'fastify'
import { eq, sql } from 'drizzle-orm'

export async function localeRoutes(app: FastifyInstance) {
	// Get available locales (viewer+, project-scoped)
	app.get('/', { preHandler: [app.requireProject('viewer')] }, async (request) => {
		const pid = request.project!.id

		// Get project settings for configured locales
		const [project] = await app.db.select().from(projects).where(eq(projects.id, pid)).limit(1)
		const settings = (project?.settings as { locales?: string[]; defaultLocale?: string }) || {}
		const configLocales = settings.locales || ['en']

		const usedLocales = await app.db
			.selectDistinct({ locale: content.locale })
			.from(content)
			.where(eq(content.projectId, pid))

		const allLocales = new Set([...configLocales, ...usedLocales.map((r) => r.locale)])

		return {
			configured: configLocales,
			defaultLocale: settings.defaultLocale || configLocales[0] || 'en',
			available: Array.from(allLocales),
		}
	})

	// Get content translations for a slug (viewer+, project-scoped)
	app.get<{ Params: { slug: string } }>(
		'/translations/:slug',
		{ preHandler: [app.requireProject('viewer')] },
		async (request) => {
			const items = await app.db
				.select()
				.from(content)
				.where(sql`${content.projectId} = ${request.project!.id} AND ${content.slug} = ${request.params.slug}`)

			const translations: Record<string, { id: string; locale: string; status: string; updatedAt: string }> = {}
			for (const item of items) {
				translations[item.locale] = { id: item.id, locale: item.locale, status: item.status, updatedAt: item.updatedAt.toISOString() }
			}

			return translations
		},
	)

	// Translation coverage (viewer+, project-scoped)
	app.get('/coverage', { preHandler: [app.requireProject('viewer')] }, async (request) => {
		return app.db
			.select({
				locale: content.locale,
				total: sql<number>`count(*)`,
				published: sql<number>`count(*) filter (where ${content.status} = 'published')`,
				draft: sql<number>`count(*) filter (where ${content.status} = 'draft')`,
			})
			.from(content)
			.where(eq(content.projectId, request.project!.id))
			.groupBy(content.locale)
	})
}
