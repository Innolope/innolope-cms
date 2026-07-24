/**
 * Migration of platform-hosted media into the user's own Cloudflare account.
 *
 * Offered after "Connect Cloudflare": images uploaded before the connection
 * live in the shared cloud (Innolope) account. Each candidate is copied into
 * the user's account (originals fetched via the Images blob API, falling back
 * to the delivery URL), the media row is repointed, and every reference to the
 * old URL in the project's content — markdown, rendered html, metadata — is
 * rewritten, with external read-write collections pushed so the customer's
 * site follows. Old copies stay in the platform account as a safety net.
 *
 * One in-process job per project; progress is polled by the settings card.
 */
import { collections, content, media, projects } from '@innolope/db'
import { and, eq, isNull, or, sql } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { isCloudMode } from '../lib/cloud-mode.js'
import { resolveMediaAdapter } from '../plugins/media.js'
import { buildExternalData, updateExternalDb } from './external-content.js'

export interface MigrationProgress {
	status: 'running' | 'done' | 'error'
	total: number
	processed: number
	migrated: number
	failed: Array<{ id: string; filename: string; error: string }>
	startedAt: string
	error?: string
}

const jobs = new Map<string, MigrationProgress>()

export function migrationProgress(projectId: string): MigrationProgress | null {
	return jobs.get(projectId) ?? null
}

function platformRowsWhere(projectId: string) {
	const envHash = process.env.CLOUDFLARE_IMAGES_ACCOUNT_HASH
	return and(
		eq(media.projectId, projectId),
		eq(media.adapter, 'cloudflare'),
		or(
			eq(media.origin, 'platform'),
			// Legacy rows: origin unset but the URL carries the platform hash.
			envHash && isCloudMode()
				? and(isNull(media.origin), sql`${media.url} LIKE ${`%/${envHash}/%`}`)
				: sql`false`,
		),
	)
}

/** How many media rows would move if the user accepts the migration. */
export async function countMigratableMedia(
	app: FastifyInstance,
	projectId: string,
): Promise<number> {
	const [{ count }] = await app.db
		.select({ count: sql<number>`count(*)` })
		.from(media)
		.where(platformRowsWhere(projectId))
	return Number(count)
}

/** Fetch the original bytes of a platform-account image (blob API, URL fallback). */
async function fetchOriginal(externalId: string | null, url: string): Promise<Buffer | null> {
	const accountId = process.env.CLOUDFLARE_ACCOUNT_ID
	const token = process.env.CLOUDFLARE_API_TOKEN
	if (externalId && accountId && token) {
		try {
			const res = await fetch(
				`https://api.cloudflare.com/client/v4/accounts/${accountId}/images/v1/${externalId}/blob`,
				{ headers: { Authorization: `Bearer ${token}` } },
			)
			if (res.ok) return Buffer.from(await res.arrayBuffer())
		} catch {
			// fall through to the delivery URL
		}
	}
	try {
		const res = await fetch(url)
		if (res.ok) return Buffer.from(await res.arrayBuffer())
	} catch {
		// unreachable original
	}
	return null
}

const escapeLike = (value: string) => value.replace(/([\\%_])/g, '\\$1')

/** Rewrite every reference to `oldUrl` in the project's content; push external rows. */
async function rewriteReferences(
	app: FastifyInstance,
	projectId: string,
	oldUrl: string,
	newUrl: string,
): Promise<void> {
	const needle = `%${escapeLike(oldUrl)}%`
	const affected = await app.db
		.select()
		.from(content)
		.where(
			and(
				eq(content.projectId, projectId),
				sql`(${content.markdown} LIKE ${needle} OR ${content.html} LIKE ${needle} OR ${content.metadata}::text LIKE ${needle})`,
			),
		)
	if (affected.length === 0) return

	const colCache = new Map<string, typeof collections.$inferSelect | null>()
	for (const row of affected) {
		const markdown = row.markdown.split(oldUrl).join(newUrl)
		const html = row.html.split(oldUrl).join(newUrl)
		// Exact-string rewrite via JSON text keeps every nested shape intact.
		const metadata = JSON.parse(
			JSON.stringify(row.metadata ?? {})
				.split(JSON.stringify(oldUrl).slice(1, -1))
				.join(JSON.stringify(newUrl).slice(1, -1)),
		) as Record<string, unknown>

		await app.db
			.update(content)
			.set({ markdown, html, metadata, updatedAt: new Date() })
			.where(eq(content.id, row.id))

		// Push the rewrite to the customer's database for external read-write rows,
		// so their site follows without waiting for the next manual save.
		if (!row.externalId) continue
		let col = colCache.get(row.collectionId)
		if (col === undefined) {
			const [loaded] = await app.db
				.select()
				.from(collections)
				.where(eq(collections.id, row.collectionId))
				.limit(1)
			col = loaded ?? null
			colCache.set(row.collectionId, col)
		}
		if (!col || col.source !== 'external' || col.accessMode === 'read-only' || !col.externalTable) {
			continue
		}
		try {
			await updateExternalDb(
				app,
				projectId,
				col,
				row.externalId,
				buildExternalData(col, { metadata, markdown, updatedAt: new Date() }),
			)
		} catch (err) {
			app.log.warn(
				{ err, contentId: row.id },
				'Cloudflare migration: external push failed for rewritten content',
			)
		}
	}
}

/**
 * Start the migration for a project. Returns false when one is already
 * running. The job runs detached; poll `migrationProgress`.
 */
export async function startMigration(app: FastifyInstance, projectId: string): Promise<boolean> {
	const existing = jobs.get(projectId)
	if (existing?.status === 'running') return false

	const [project] = await app.db.select().from(projects).where(eq(projects.id, projectId)).limit(1)
	if (!project) throw new Error('Project not found')
	const resolved = await resolveMediaAdapter(project.settings ?? undefined, {
		app,
		projectId,
	})
	if (resolved.origin !== 'project') {
		throw new Error('Connect your own Cloudflare account before migrating')
	}

	const rows = await app.db.select().from(media).where(platformRowsWhere(projectId))
	const progress: MigrationProgress = {
		status: 'running',
		total: rows.length,
		processed: 0,
		migrated: 0,
		failed: [],
		startedAt: new Date().toISOString(),
	}
	jobs.set(projectId, progress)

	void (async () => {
		try {
			for (const row of rows) {
				try {
					const bytes = await fetchOriginal(row.externalId, row.url)
					if (!bytes) throw new Error('Could not fetch the original file')
					const result = await resolved.adapter.upload(bytes, row.filename, row.mimeType)
					await app.db
						.update(media)
						.set({ url: result.url, externalId: result.id, origin: 'project' })
						.where(eq(media.id, row.id))
					await rewriteReferences(app, projectId, row.url, result.url)
					progress.migrated++
				} catch (err) {
					progress.failed.push({
						id: row.id,
						filename: row.filename,
						error: err instanceof Error ? err.message : 'Migration failed',
					})
				} finally {
					progress.processed++
				}
			}
			progress.status = 'done'
		} catch (err) {
			progress.status = 'error'
			progress.error = err instanceof Error ? err.message : 'Migration failed'
			app.log.error({ err, projectId }, 'Cloudflare media migration crashed')
		}
	})()

	return true
}
