import { createHash, randomUUID } from 'node:crypto'
import { collections, content, media, projects } from '@innolope/db'
import { eq } from 'drizzle-orm'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { createExternalDbAdapter } from '../adapters/external-db.js'
import { checkCollectionAccess } from '../lib/collection-access.js'
import { getImageDimensions } from '../lib/image.js'
import {
	dedupeFilename,
	isDuplicateKeyError,
	uploadToImportedStorage,
} from '../lib/media-upload.js'
import { requestSource } from '../lib/request-source.js'
import { getUser } from '../plugins/auth.js'
import { MediaConfigError, resolveMediaAdapter } from '../plugins/media.js'
import { getProject } from '../plugins/project.js'
import { CloudflareReconnectError } from './cloudflare-oauth.js'
import { buildExternalData, fetchLiveExternalRecord } from './external-content.js'
import { externalDocToContentItem } from './markdown-cache.js'
import { mediaDelivery } from './media-delivery.js'
import {
	detectMediaFields,
	type IngestTarget,
	imageFilename,
	ingestError,
	resolveUploadTarget,
	sniffImage,
} from './media-ingest-policy.js'
import { ingestOnce } from './media-ledger.js'
import { publicBaseUrl } from './oauth-metadata.js'
import { syncState } from './sync-state.js'

export interface IngestResult {
	[key: string]: unknown
	id: string
	externalId: string | null
	filename: string
	fullPath: string
	deliveryUrl: string
	deliveryVerified: boolean
	width: number | null
	height: number | null
	bytes: number
	mimeType: string
	sha256: string
	duplicate: boolean
	target: { kind: 'library' | 'collection'; collectionId?: string; collectionName?: string }
	warnings?: string[]
}
export async function uploadContext(app: FastifyInstance, request: FastifyRequest) {
	const pid = getProject(request).id
	const [[project], cols] = await Promise.all([
		app.db.select().from(projects).where(eq(projects.id, pid)).limit(1),
		app.db.select().from(collections).where(eq(collections.projectId, pid)),
	])
	if (!project) throw ingestError('Project not found', 404)
	const resolved = resolveUploadTarget(project, cols, {
		role: request.projectRole,
		licensed: app.license.hasFeature('media-integrations'),
	})
	if (resolved.target?.kind === 'library') resolved.target.baseUrl = publicBaseUrl(request)
	if (resolved.target?.kind === 'collection') {
		const access = await checkCollectionAccess(request, resolved.target.collection.id, 'write')
		if (!access.ok) {
			resolved.info.canUpload = false
			resolved.info.problem = access.error
		}
	}
	return { project, ...resolved }
}

/** The two existing provider/write pipelines; admin callers keep their original rows and no dedupe. */
export async function storeMediaBuffer(
	app: FastifyInstance,
	request: FastifyRequest,
	input: { buffer: Buffer; filename: string; mimeType: string; alt?: string },
	target: IngestTarget,
	agent = false,
) {
	const pid = getProject(request).id
	const dims = getImageDimensions(input.buffer)
	const uploadOptions = agent ? { signal: AbortSignal.timeout(90_000) } : undefined
	if (target.kind === 'library') {
		const [project] = await app.db.select().from(projects).where(eq(projects.id, pid)).limit(1)
		let resolved: Awaited<ReturnType<typeof resolveMediaAdapter>>
		let uploaded: Awaited<ReturnType<typeof app.media.upload>>
		try {
			resolved = await resolveMediaAdapter(project?.settings, { projectId: pid, app })
			uploaded = await resolved.adapter.upload(
				input.buffer,
				input.filename,
				input.mimeType,
				uploadOptions,
			)
		} catch (err) {
			if (err instanceof MediaConfigError || err instanceof CloudflareReconnectError)
				throw ingestError(err.message)
			// Agents need the provider's reason; the admin route keeps its old generic 5xx.
			if (agent && err instanceof Error)
				throw ingestError(err.message, (err as { statusCode?: number }).statusCode ?? 502)
			throw err
		}
		const type = input.mimeType.startsWith('image/')
			? 'image'
			: input.mimeType.startsWith('video/')
				? 'video'
				: 'file'
		const [created] = await app.db
			.insert(media)
			.values({
				projectId: pid,
				type,
				filename: uploaded.filename,
				mimeType: input.mimeType,
				size: uploaded.size,
				url: uploaded.url,
				adapter: resolved.adapterName,
				origin: resolved.origin,
				externalId: uploaded.id,
				metadata: type === 'image' && dims ? dims : {},
				createdBy: getUser(request).id,
				...(input.alt !== undefined && { alt: input.alt }),
			})
			.returning()
		app.events.emit({
			type: 'media:uploaded',
			data: { id: created.id, filename: created.filename, type, projectId: pid },
			timestamp: new Date().toISOString(),
		})
		return { record: created, filename: created.filename, fullPath: created.url, externalId: null }
	}
	const col = target.collection
	let uploaded: { key: string }
	try {
		uploaded = await uploadToImportedStorage(
			target.entry,
			input.buffer,
			input.filename,
			input.mimeType,
			uploadOptions,
		)
	} catch (err) {
		throw ingestError(
			err instanceof Error ? err.message : 'Upload failed',
			(err as { statusCode?: number }).statusCode ?? 502,
		)
	}
	const fields = agent ? target.fields : detectMediaFields(col, target.entry)
	let rowData: Record<string, unknown> = { [fields.path ?? target.entry.pathColumn]: uploaded.key }
	for (const [key, value] of Object.entries({
		filename: input.filename,
		mimeType: input.mimeType,
		size: input.buffer.length,
		width: dims?.width,
		height: dims?.height,
		...(agent ? { alt: input.alt } : {}),
	})) {
		const column = fields[key as keyof typeof fields]
		if (column && value !== undefined) rowData[column] = value
	}
	if (agent)
		rowData = buildExternalData(col, {
			metadata: rowData,
			createdAt: new Date(),
			updatedAt: new Date(),
		})
	const [project] = await app.db.select().from(projects).where(eq(projects.id, pid)).limit(1)
	const ext = (
		project?.settings as unknown as {
			externalDb?: { type: string; connectionString: string; database?: string }
		}
	)?.externalDb
	if (!ext)
		throw ingestError(
			'Provider upload succeeded but external database is not configured; uploaded object may need cleanup.',
			502,
		)
	const adapter = createExternalDbAdapter(ext)
	let externalId: string | undefined
	try {
		await adapter.connect()
		let inserted: Awaited<ReturnType<typeof adapter.insert>>
		try {
			inserted = await adapter.insert(col.externalTable ?? '', rowData)
		} catch (err) {
			if (!isDuplicateKeyError(err)) throw err
			for (const [key, value] of Object.entries(rowData)) {
				if (
					typeof value === 'string' &&
					(key === fields.filename ||
						/(^|_)(filename|name)($|_)/i.test(key.replace(/([a-z0-9])([A-Z])/g, '$1_$2')))
				)
					rowData[key] = dedupeFilename(value)
			}
			try {
				inserted = await adapter.insert(col.externalTable ?? '', rowData)
			} catch (retryErr) {
				if (isDuplicateKeyError(retryErr))
					throw ingestError(
						'A file with this name already exists in this library. Pick the existing file instead of re-uploading, or rename the file.',
						409,
					)
				throw retryErr
			}
		}
		externalId = inserted?._id
	} catch (err) {
		if (!agent) throw err
		if (err instanceof Error && 'statusCode' in err) throw err
		throw ingestError(
			'Provider upload succeeded but external row insert failed; uploaded object may need cleanup. Check the external database before retrying.',
			502,
		)
	} finally {
		await adapter.disconnect()
	}
	const base =
		input.filename
			.toLowerCase()
			.replace(/\.[^.]+$/, '')
			.replace(/[^a-z0-9]+/g, '-')
			.replace(/^-+|-+$/g, '')
			.slice(0, 60) || 'media'
	let created: typeof content.$inferSelect
	try {
		;[created] = await app.db
			.insert(content)
			.values({
				projectId: pid,
				slug: `${base}-${randomUUID().slice(0, 8)}`,
				collectionId: col.id,
				metadata: rowData,
				markdown: '',
				html: '',
				locale: 'en',
				status: 'published',
				createdBy: getUser(request).id,
				updatedSource: requestSource(request),
				...(agent &&
					externalId && {
						externalSnapshot: syncState(
							externalDocToContentItem({ _id: externalId, ...rowData }, col),
						),
					}),
				...(externalId && { externalId }),
			})
			.returning()
	} catch (err) {
		if (!agent) throw err
		throw ingestError(
			`Provider upload and external row insert succeeded (${externalId ?? 'unknown id'}), but caching failed; reconcile the external record before retrying.`,
			502,
		)
	}
	app.events.emit({
		type: 'media:uploaded',
		data: {
			id: created.id,
			filename: String(rowData[fields.filename ?? ''] ?? input.filename),
			type: 'image',
			projectId: pid,
		},
		timestamp: new Date().toISOString(),
	})
	return {
		record: created,
		filename: String(rowData[fields.filename ?? ''] ?? input.filename),
		fullPath: uploaded.key,
		externalId: externalId ?? null,
	}
}
export async function ingestMedia(
	app: FastifyInstance,
	request: FastifyRequest,
	input: { buffer: Buffer; filename?: string; mimeType?: string; alt?: string; force?: boolean },
	context?: Awaited<ReturnType<typeof uploadContext>>,
) {
	const ctx = context ?? (await uploadContext(app, request))
	if (!ctx.info.canUpload || !ctx.target)
		throw ingestError(
			ctx.info.problem ?? 'No usable upload target',
			ctx.target && !ctx.info.canUpload ? 403 : 400,
		)
	if (input.buffer.length > ctx.info.maxBytes)
		throw ingestError(`Image is too large; maximum ${ctx.info.maxBytes} bytes.`)
	const detected = sniffImage(input.buffer, input.mimeType)
	const filename = imageFilename(detected.mimeType, input.filename)
	const sha256 = createHash('sha256').update(input.buffer).digest('hex')
	const target = ctx.target
	const result = await ingestOnce(
		app.db,
		getProject(request).id,
		target.kind === 'library' ? 'library' : `collection:${target.collection.id}`,
		sha256,
		async () => {
			const stored = await storeMediaBuffer(
				app,
				request,
				{ ...input, filename, mimeType: detected.mimeType },
				target,
				true,
			)
			return {
				id: stored.record.id,
				externalId: stored.externalId,
				filename: stored.filename,
				fullPath: stored.fullPath,
				...(await mediaDelivery(stored.fullPath, target)),
				width: detected.width,
				height: detected.height,
				bytes: input.buffer.length,
				mimeType: detected.mimeType,
				sha256,
				duplicate: false,
				target:
					target.kind === 'library'
						? { kind: 'library' }
						: {
								kind: 'collection',
								collectionId: target.collection.id,
								collectionName: target.collection.name,
							},
			}
		},
		input.force,
		target.kind === 'collection'
			? async (row) =>
					!!row.result?.externalId &&
					!!(await fetchLiveExternalRecord(
						app,
						getProject(request).id,
						target.collection.id,
						row.result.externalId,
					))
			: undefined,
	)
	// Human receipts store raw paths without network work on the admin request.
	// Refresh delivery on replay, including private signed URLs and changed variants.
	if (result.duplicate) return { ...result, ...(await mediaDelivery(result.fullPath, target)) }
	return result
}
/** Human uploads publish receipts after writing, without a lookup or dedupe. */
export async function recordAdminUpload(
	app: FastifyInstance,
	request: FastifyRequest,
	input: { buffer: Buffer; filename: string; mimeType: string },
	target: IngestTarget,
) {
	const stored = await storeMediaBuffer(app, request, input, target)
	const dimensions = getImageDimensions(input.buffer)
	const sha256 = createHash('sha256').update(input.buffer).digest('hex')
	const result: IngestResult = {
		id: stored.record.id,
		externalId: stored.externalId,
		filename: stored.filename,
		fullPath: stored.fullPath,
		deliveryUrl: stored.fullPath,
		deliveryVerified: false,
		width: dimensions?.width ?? null,
		height: dimensions?.height ?? null,
		bytes: input.buffer.length,
		mimeType: input.mimeType,
		sha256,
		duplicate: false,
		target:
			target.kind === 'library'
				? { kind: 'library' }
				: {
						kind: 'collection',
						collectionId: target.collection.id,
						collectionName: target.collection.name,
					},
	}
	await ingestOnce(
		app.db,
		getProject(request).id,
		target.kind === 'library' ? 'library' : `collection:${target.collection.id}`,
		sha256,
		async () => result,
		true,
	)
	return stored.record
}
