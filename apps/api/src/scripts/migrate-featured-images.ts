/**
 * One-off data migration: pull existing article `featuredImage` URLs into managed
 * media storage and rewrite the value to the new `media` row id.
 *
 * Scope: internal collections only (external/media-source collections are skipped).
 * Idempotent — safe to re-run. Flags: --dry-run, --batch-size=N (default 50).
 *
 * Recommended: back up the database before running.
 *
 *   DATABASE_URL=... tsx src/scripts/migrate-featured-images.ts --dry-run
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { CollectionField } from '@innolope/config'
import { collections, content, createDb, media } from '@innolope/db'
import { and, eq } from 'drizzle-orm'
import { getImageDimensions } from '../lib/image.js'
import { createMediaAdapter, mediaAdapterName } from '../plugins/media.js'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const EXT_BY_MIME: Record<string, string> = {
	'image/jpeg': 'jpg',
	'image/png': 'png',
	'image/webp': 'webp',
	'image/gif': 'gif',
	'image/avif': 'avif',
}

const dryRun = process.argv.includes('--dry-run')
const batchSizeArg = process.argv.find((a) => a.startsWith('--batch-size='))
const batchSize = batchSizeArg ? Math.max(1, Number(batchSizeArg.split('=')[1]) || 50) : 50

function resolveAlt(title: unknown): string | null {
	if (typeof title === 'string') return title || null
	if (title && typeof title === 'object') {
		const obj = title as Record<string, unknown>
		const v = obj.en ?? Object.values(obj)[0]
		return typeof v === 'string' ? v || null : null
	}
	return null
}

function filenameFromUrl(url: string, mime: string): string {
	let base = 'image'
	try {
		const seg = new URL(url).pathname.split('/').filter(Boolean).pop()
		if (seg) base = decodeURIComponent(seg)
	} catch {
		// keep fallback
	}
	if (!/\.[a-z0-9]{2,5}$/i.test(base)) {
		base = `${base}.${EXT_BY_MIME[mime] || 'jpg'}`
	}
	return base
}

async function fetchImage(
	url: string,
): Promise<{ buffer: Buffer; mimeType: string } | { error: string }> {
	const controller = new AbortController()
	const timer = setTimeout(() => controller.abort(), 20_000)
	try {
		const res = await fetch(url, { signal: controller.signal, redirect: 'follow' })
		if (!res.ok) return { error: `HTTP ${res.status}` }
		const mimeType = (res.headers.get('content-type') || '').split(';')[0].trim()
		if (!mimeType.startsWith('image/')) return { error: `non-image content-type: ${mimeType}` }
		const buffer = Buffer.from(await res.arrayBuffer())
		return { buffer, mimeType }
	} catch (err) {
		return { error: err instanceof Error ? err.message : 'fetch failed' }
	} finally {
		clearTimeout(timer)
	}
}

async function migrate(databaseUrl: string) {
	const db = createDb(databaseUrl)
	const adapter = await createMediaAdapter()
	const adapterName = mediaAdapterName()
	const uploadDir = process.env.UPLOAD_DIR || './uploads'

	const stats = { migrated: 0, deduped: 0, skipped: 0, failed: 0 }
	const failures: string[] = []

	const allCollections = await db.select().from(collections)
	const targetCollections = allCollections.filter(
		(c) =>
			(c.source ?? 'internal') === 'internal' &&
			(c.fields || []).some((f) => f.name === 'featuredImage'),
	)

	console.log(
		`${dryRun ? '[DRY RUN] ' : ''}Found ${targetCollections.length} internal collection(s) with a featuredImage field.`,
	)

	for (const col of targetCollections) {
		console.log(`\n# Collection "${col.name}" (project ${col.projectId})`)

		// Ensure the project has a media collection (relation target).
		const [existingMedia] = await db
			.select()
			.from(collections)
			.where(and(eq(collections.name, 'media'), eq(collections.projectId, col.projectId)))
			.limit(1)
		if (!existingMedia) {
			console.log('  - media collection missing — creating it')
			if (!dryRun) {
				await db.insert(collections).values({
					projectId: col.projectId,
					name: 'media',
					label: 'Media',
					description: 'Uploaded images and files',
					source: 'media',
					accessMode: 'read-write',
					fields: [
						{ name: 'url', type: 'text' },
						{ name: 'filename', type: 'text' },
						{ name: 'alt', type: 'text' },
						{ name: 'type', type: 'text' },
						{ name: 'mimeType', type: 'text' },
						{ name: 'size', type: 'number' },
						{ name: 'width', type: 'number' },
						{ name: 'height', type: 'number' },
					],
				})
			}
		}

		// Convert the featuredImage field definition to a media relation.
		const featuredField = (col.fields || []).find((f) => f.name === 'featuredImage')
		if (featuredField && featuredField.type !== 'relation') {
			console.log('  - converting featuredImage field: text -> relation(media)')
			if (!dryRun) {
				const nextFields: CollectionField[] = (col.fields || []).map((f) =>
					f.name === 'featuredImage' ? { ...f, type: 'relation' as const, relationTo: 'media' } : f,
				)
				await db.update(collections).set({ fields: nextFields }).where(eq(collections.id, col.id))
			}
		}

		// Preload this project's media ids so existing references are recognised.
		const mediaIds = new Set(
			(await db.select({ id: media.id }).from(media).where(eq(media.projectId, col.projectId))).map(
				(m) => m.id,
			),
		)
		// Dedup: source url -> media id (one media row per distinct source image).
		const urlCache = new Map<string, string>()

		let offset = 0
		for (;;) {
			const rows = await db
				.select()
				.from(content)
				.where(eq(content.collectionId, col.id))
				.limit(batchSize)
				.offset(offset)
			if (rows.length === 0) break
			offset += rows.length

			for (const row of rows) {
				const meta = (row.metadata as Record<string, unknown>) || {}
				const value = meta.featuredImage
				if (typeof value !== 'string' || !value.trim()) {
					stats.skipped++
					continue
				}
				const ref = value.trim()

				// Already a media id — nothing to do.
				if (UUID_RE.test(ref) && mediaIds.has(ref)) {
					stats.skipped++
					continue
				}

				// Seen this exact source url already — reuse the media row.
				const cacheKey = ref
				if (urlCache.has(cacheKey)) {
					const mediaId = urlCache.get(cacheKey) as string
					if (!dryRun) {
						await db
							.update(content)
							.set({ metadata: { ...meta, featuredImage: mediaId } })
							.where(eq(content.id, row.id))
					}
					stats.deduped++
					continue
				}

				const isRemote = /^https?:\/\//i.test(ref)
				const isLocal = ref.startsWith('/uploads/')
				if (!isRemote && !isLocal) {
					console.log(`  ? "${row.slug}": unrecognised featuredImage value — left untouched`)
					stats.skipped++
					continue
				}

				let mediaId: string
				try {
					if (isRemote) {
						const fetched = await fetchImage(ref)
						if ('error' in fetched) {
							throw new Error(fetched.error)
						}
						const filename = filenameFromUrl(ref, fetched.mimeType)
						const dims = getImageDimensions(fetched.buffer)
						if (dryRun) {
							console.log(`  + "${row.slug}": would upload ${ref} (${fetched.buffer.length}b)`)
							stats.migrated++
							continue
						}
						const uploaded = await adapter.upload(fetched.buffer, filename, fetched.mimeType)
						const [created] = await db
							.insert(media)
							.values({
								projectId: col.projectId,
								type: 'image',
								filename: uploaded.filename,
								mimeType: fetched.mimeType,
								size: uploaded.size,
								url: uploaded.url,
								adapter: adapterName,
								externalId: uploaded.id,
								alt: resolveAlt(meta.title),
								metadata: dims ? { width: dims.width, height: dims.height } : {},
							})
							.returning()
						mediaId = created.id
					} else {
						// Local /uploads path — reference the existing file, don't re-upload.
						const [existing] = await db
							.select()
							.from(media)
							.where(and(eq(media.projectId, col.projectId), eq(media.url, ref)))
							.limit(1)
						if (existing) {
							mediaId = existing.id
						} else {
							const storedName = ref.replace(/^\/uploads\//, '')
							const diskPath = join(uploadDir, storedName)
							let size = 0
							let dims: { width: number; height: number } | null = null
							if (existsSync(diskPath)) {
								const buf = readFileSync(diskPath)
								size = buf.length
								dims = getImageDimensions(buf)
							} else {
								console.log(`  ! "${row.slug}": local file ${diskPath} not found — row size=0`)
							}
							if (dryRun) {
								console.log(`  + "${row.slug}": would create media row for ${ref}`)
								stats.migrated++
								continue
							}
							const ext = storedName.split('.').pop()?.toLowerCase() || ''
							const mimeType =
								Object.entries(EXT_BY_MIME).find(([, e]) => e === ext)?.[0] ||
								'application/octet-stream'
							const [created] = await db
								.insert(media)
								.values({
									projectId: col.projectId,
									type: 'image',
									filename: storedName,
									mimeType,
									size,
									url: ref,
									adapter: 'local',
									externalId: storedName.replace(/\.[^.]+$/, ''),
									alt: resolveAlt(meta.title),
									metadata: dims ? { width: dims.width, height: dims.height } : {},
								})
								.returning()
							mediaId = created.id
						}
					}
				} catch (err) {
					const msg = err instanceof Error ? err.message : 'unknown error'
					console.log(`  x "${row.slug}": failed — ${msg}`)
					failures.push(`${col.name}/${row.slug}: ${ref} — ${msg}`)
					stats.failed++
					continue
				}

				mediaIds.add(mediaId)
				urlCache.set(cacheKey, mediaId)
				await db
					.update(content)
					.set({ metadata: { ...meta, featuredImage: mediaId } })
					.where(eq(content.id, row.id))
				console.log(`  + "${row.slug}": featuredImage -> media ${mediaId}`)
				stats.migrated++
			}
		}
	}

	console.log(
		`\n${dryRun ? '[DRY RUN] ' : ''}Done. migrated=${stats.migrated} deduped=${stats.deduped} skipped=${stats.skipped} failed=${stats.failed}`,
	)
	if (failures.length > 0) {
		console.log('\nFailures (left untouched — fix manually):')
		for (const f of failures) console.log(`  - ${f}`)
	}
}

const url = process.env.DATABASE_URL
if (!url) {
	console.error('DATABASE_URL not set')
	process.exit(1)
}
migrate(url)
	.catch((err) => {
		console.error(err)
		process.exit(1)
	})
	.finally(() => process.exit(0))
