import { type IndexNowSettings, projects } from '@innolope/db'
import { eq, sql } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { validatePublicUrl } from '../../adapters/connection-guard.js'
import { getProject } from '../../plugins/project.js'
import {
	generateIndexNowKey,
	keyFilePath,
	keyLocationFor,
	validateIndexNowKey,
	verifyKeyFile,
} from '../../services/indexnow.js'
import {
	getIndexNowStatus,
	indexNowHosts,
	queueCollectionUrls,
	readIndexNowSettings,
} from '../../services/indexnow-queue.js'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const settingsInput = z
	.object({
		enabled: z.boolean().optional(),
		key: z.string().trim().optional(),
		keyLocation: z.string().trim().nullable().optional(),
		regenerateKey: z.boolean().optional(),
	})
	.strict()

async function loadSettings(app: FastifyInstance, projectId: string) {
	const [project] = await app.db
		.select({ settings: projects.settings })
		.from(projects)
		.where(eq(projects.id, projectId))
		.limit(1)
	return readIndexNowSettings(project?.settings)
}

/**
 * IndexNow for the project's site (project-scoped). Settings live in
 * `projects.settings.indexNow` and are written only here; the per-collection
 * public URL template lives in the collection's settings.
 */
export async function indexNowRoutes(app: FastifyInstance) {
	// Settings, per-collection queue state and recent submissions (viewer+).
	app.get('/', { preHandler: [app.requireProject('viewer')] }, async (request) =>
		getIndexNowStatus(app, getProject(request).id),
	)

	// Change settings (admin+). A key is generated whenever the project has none.
	app.put('/', { preHandler: [app.requireProject('admin')] }, async (request, reply) => {
		const body = settingsInput.parse(request.body ?? {})
		const projectId = getProject(request).id
		const current = await loadSettings(app, projectId)

		let key = current?.key ?? null
		if (body.key) {
			const problem = validateIndexNowKey(body.key)
			if (problem) return reply.status(400).send({ error: problem })
			key = body.key
		}
		if (body.regenerateKey || !key) key = generateIndexNowKey()

		let keyLocation = current?.keyLocation ?? null
		if (body.keyLocation !== undefined) {
			keyLocation = body.keyLocation || null
		} else if (keyLocation && current && current.key !== key) {
			// A key file named after the old key follows the new key.
			const location = new URL(keyLocation)
			const oldName = `/${current.key}.txt`
			if (location.pathname.endsWith(oldName)) {
				location.pathname = `${location.pathname.slice(0, -oldName.length)}/${key}.txt`
				keyLocation = location.toString()
			}
		}
		if (keyLocation) {
			let parsed: URL | null = null
			try {
				parsed = new URL(keyLocation)
			} catch {
				parsed = null
			}
			if (!parsed || (parsed.protocol !== 'https:' && parsed.protocol !== 'http:')) {
				return reply.status(400).send({
					error:
						'The key location must be an absolute URL on your site, e.g. https://example.com/<key>.txt.',
				})
			}
			const blocked = await validatePublicUrl(keyLocation)
			if (blocked) return reply.status(400).send({ error: `Key location: ${blocked}` })
		}

		const next: IndexNowSettings = {
			enabled: body.enabled ?? current?.enabled ?? false,
			key,
			keyLocation,
		}
		// Merge into the stored settings in SQL: a concurrent save of other project
		// settings must not be undone by this one, nor this one by it.
		await app.db
			.update(projects)
			.set({
				settings: sql`${projects.settings} || jsonb_build_object('indexNow', ${JSON.stringify(next)}::jsonb)`,
				updatedAt: new Date(),
			})
			.where(eq(projects.id, projectId))
		return getIndexNowStatus(app, projectId)
	})

	// The key-file contract for site builders (viewer+, so a read-only API key
	// works): write `keyFile.content` to `keyFile.path` on the site.
	app.get('/key', { preHandler: [app.requireProject('viewer')] }, async (request) => {
		const projectId = getProject(request).id
		const settings = await loadSettings(app, projectId)
		if (!settings) {
			return { enabled: false, key: null, keyLocation: null, keyFile: null, hosts: [] }
		}
		const hosts = await indexNowHosts(app, projectId, settings)
		return {
			enabled: settings.enabled,
			key: settings.key,
			keyLocation: settings.keyLocation ?? null,
			keyFile: { path: keyFilePath(settings), content: settings.key },
			hosts: hosts.map((host) => ({ host, keyLocation: keyLocationFor(settings, host) })),
		}
	})

	// Fetch the key file on every host, as a search engine would (admin+).
	app.post('/verify', { preHandler: [app.requireProject('admin')] }, async (request, reply) => {
		const projectId = getProject(request).id
		const settings = await loadSettings(app, projectId)
		if (!settings) {
			return reply
				.status(400)
				.send({ error: 'There is no IndexNow key yet. Save the settings first.' })
		}
		const hosts = await indexNowHosts(app, projectId, settings)
		const results = []
		for (const host of hosts) {
			const keyLocation = keyLocationFor(settings, host)
			const blocked = await validatePublicUrl(keyLocation)
			const check = blocked
				? { ok: false, statusCode: null, message: blocked }
				: await verifyKeyFile(keyLocation, settings.key)
			results.push({ host, keyLocation, ...check })
		}
		return { results }
	})

	// Queue every published record of a collection (admin+): for the first
	// submission after enabling IndexNow, or after the site's URLs changed.
	app.post<{ Params: { id: string } }>(
		'/collections/:id/resubmit',
		{ preHandler: [app.requireProject('admin')] },
		async (request, reply) => {
			if (!UUID.test(request.params.id)) {
				return reply.status(404).send({ error: 'Collection not found' })
			}
			const result = await queueCollectionUrls(
				app,
				getProject(request).id,
				request.params.id,
				'resubmit',
			)
			if (!result.ok) return reply.status(result.status).send({ error: result.error })
			return { queued: result.queued, skipped: result.skipped }
		},
	)
}
