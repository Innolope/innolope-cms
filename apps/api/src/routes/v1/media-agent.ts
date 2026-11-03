import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import type { Readable } from 'node:stream'
import { content, contentVersions, media, mediaUploadSessions } from '@innolope/db'
import { and, eq, inArray, lt, or } from 'drizzle-orm'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { checkCollectionAccess } from '../../lib/collection-access.js'
import { contentHash, withContentHash } from '../../lib/content-hash.js'
import { mediaItemHash } from '../../lib/media-item-hash.js'
import { requestSource } from '../../lib/request-source.js'
import { getUser } from '../../plugins/auth.js'
import { mediaMaxSize } from '../../plugins/media.js'
import { getProject } from '../../plugins/project.js'
import { fetchLiveExternalRecord, updateExternalDb } from '../../services/external-content.js'
import { cacheMissingDocs } from '../../services/markdown-cache.js'
import { ingestMedia, uploadContext } from '../../services/media-ingest.js'
import {
	AGENT_IMAGE_TYPES,
	decodeImageData,
	fetchSourceImage,
	imageFilename,
	ingestError,
} from '../../services/media-ingest-policy.js'
import { publicBaseUrl } from '../../services/oauth-metadata.js'

const filenameSchema = z
	.string()
	.trim()
	.min(1)
	.max(250)
	.refine((v) => !v.includes(String.fromCharCode(0)), 'Filename must not contain NUL characters')
const altSchema = z
	.string()
	.max(10_000)
	.refine((v) => !v.includes(String.fromCharCode(0)), 'Alt text must not contain NUL characters')
const editSchema = z
	.object({
		alt: altSchema.optional(),
		filename: filenameSchema.optional(),
		expectedHash: z
			.string()
			.regex(/^sha256:[a-f0-9]{64}$/)
			.optional(),
	})
	.strict()
	.refine((v) => v.alt !== undefined || v.filename !== undefined, 'Supply alt or filename')
const ingestSchema = z
	.object({
		sourceUrl: z.string().url().max(8192).optional(),
		data: z.string().optional(),
		mimeType: z.string().optional(),
		filename: filenameSchema.optional(),
		alt: altSchema.optional(),
		force: z.boolean().optional(),
	})
	.strict()
	.refine(
		(v) => (v.sourceUrl !== undefined) !== (v.data !== undefined),
		'Provide exactly one of sourceUrl or data',
	)
const completeSchema = z
	.object({
		alt: altSchema.optional(),
		filename: filenameSchema.optional(),
		force: z.boolean().optional(),
	})
	.strict()
const uuid = z.string().uuid()
const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')

export async function agentMediaRoutes(app: FastifyInstance) {
	const viewer = { preHandler: [app.requireProject('viewer')] }
	const editor = { preHandler: [app.requireProject('editor')] }
	app.get('/upload-target', viewer, async (request) => (await uploadContext(app, request)).info)
	app.post(
		'/ingest',
		{
			...editor,
			bodyLimit: 2 * 1024 * 1024,
			errorHandler: (error, _request, reply) => {
				if (error.code === 'FST_ERR_CTP_BODY_TOO_LARGE')
					return reply.status(413).send({
						error:
							'Image data is too large. Base64 is limited to 1 MB decoded; call create_media_upload for the two-step upload.',
					})
				throw error
			},
		},
		async (request, reply) => {
			const parsed = ingestSchema.safeParse(request.body)
			if (!parsed.success) throw ingestError(parsed.error.issues.map((i) => i.message).join('; '))
			const input = parsed.data
			const ctx = await uploadContext(app, request)
			if (!ctx.info.canUpload)
				throw ingestError(ctx.info.problem ?? 'No usable upload target', ctx.target ? 403 : 400)
			const source = input.sourceUrl
				? await fetchSourceImage(input.sourceUrl, ctx.info.maxBytes)
				: decodeImageData(input.data ?? '')
			if (
				'declared' in source &&
				source.declared &&
				input.mimeType &&
				source.declared !== input.mimeType
			)
				throw ingestError(
					`Data URI type ${source.declared} contradicts declared ${input.mimeType}.`,
				)
			const result = await ingestMedia(
				app,
				request,
				{
					...input,
					buffer: source.buffer,
					filename: input.filename ?? ('filename' in source ? source.filename : undefined),
					mimeType: input.mimeType ?? ('declared' in source ? source.declared : undefined),
				},
				ctx,
			)
			return reply.status(201).send(result)
		},
	)
	app.post('/uploads', editor, async (request, reply) => {
		const parsed = z
			.object({
				filename: filenameSchema,
				mimeType: z.enum(AGENT_IMAGE_TYPES),
				bytes: z.number().int().positive(),
			})
			.strict()
			.safeParse(request.body)
		if (!parsed.success)
			throw ingestError(
				`Invalid upload declaration: ${parsed.error.issues.map((i) => i.message).join('; ')}. Allowed: ${AGENT_IMAGE_TYPES.join(', ')}.`,
			)
		const ctx = await uploadContext(app, request)
		if (!ctx.info.canUpload)
			throw ingestError(ctx.info.problem ?? 'No usable upload target', ctx.target ? 403 : 400)
		if (parsed.data.bytes > ctx.info.maxBytes)
			throw ingestError(`Image is too large; maximum ${ctx.info.maxBytes} bytes.`)
		const token = randomBytes(32).toString('base64url')
		const expiresAt = new Date(Date.now() + 30 * 60_000)
		const [session] = await app.db
			.insert(mediaUploadSessions)
			.values({
				projectId: getProject(request).id,
				userId: getUser(request).id,
				filename: imageFilename(parsed.data.mimeType, parsed.data.filename),
				mimeType: parsed.data.mimeType,
				bytes: parsed.data.bytes,
				tokenHash: sha(token),
				expiresAt,
			})
			.returning({ id: mediaUploadSessions.id })
		return reply.status(201).send({
			uploadId: session.id,
			uploadUrl: `${publicBaseUrl(request)}/api/v1/media/uploads/${session.id}/content?token=${token}`,
			method: 'PUT',
			headers: { 'Content-Type': parsed.data.mimeType },
			expiresAt: expiresAt.toISOString(),
			maxBytes: ctx.info.maxBytes,
		})
	})
	// Encapsulation keeps raw parsing confined to capability PUT; validate before parsing a byte.
	await app.register(async (raw) => {
		const limits = new WeakMap<FastifyRequest, number>()
		raw.removeAllContentTypeParsers()
		raw.addContentTypeParser('*', async (request: FastifyRequest, stream: Readable) => {
			const limit = limits.get(request)
			if (!limit) throw ingestError('Upload session not found', 404)
			const chunks: Buffer[] = []
			let length = 0
			for await (const chunk of stream) {
				length += chunk.length
				if (length > limit) throw ingestError(`PUT exceeds declared size of ${limit} bytes.`, 413)
				chunks.push(Buffer.from(chunk))
			}
			return Buffer.concat(chunks)
		})
		raw.put<{ Params: { id: string }; Querystring: { token?: string } }>(
			'/uploads/:id/content',
			{
				bodyLimit: mediaMaxSize(),
				config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
				onRequest: async (request, reply) => {
					if (!uuid.safeParse(request.params.id).success)
						return reply.status(404).send({ error: 'Upload session not found' })
					const [session] = await app.db
						.select()
						.from(mediaUploadSessions)
						.where(eq(mediaUploadSessions.id, request.params.id))
						.limit(1)
					const token = typeof request.query.token === 'string' ? request.query.token : ''
					if (
						!session ||
						!timingSafeEqual(Buffer.from(session.tokenHash, 'hex'), Buffer.from(sha(token), 'hex'))
					)
						return reply.status(404).send({ error: 'Upload session not found' })
					if (session.expiresAt.getTime() <= Date.now())
						return reply
							.status(410)
							.send({ error: 'Upload session expired; call create_media_upload again' })
					if (session.status === 'done' || session.status === 'processing')
						return reply
							.status(409)
							.send({ error: 'Upload already completed or processing; call complete_media_upload' })
					// A dynamic lower limit bounds parsing by the declaration as well as the route cap.
					limits.set(request, Math.min(session.bytes, mediaMaxSize()))
				},
			},
			async (request, reply) => {
				const buffer = request.body as Buffer
				if (!Buffer.isBuffer(buffer) || !buffer.length)
					throw ingestError(
						'Upload body is empty; PUT the image bytes before complete_media_upload',
					)
				const [session] = await app.db
					.select()
					.from(mediaUploadSessions)
					.where(eq(mediaUploadSessions.id, request.params.id))
					.limit(1)
				if (!session || session.expiresAt.getTime() <= Date.now())
					return reply.status(410).send({ error: 'Upload session expired' })
				if (buffer.length > session.bytes)
					throw ingestError(`PUT exceeds declared size of ${session.bytes} bytes.`)
				const [updated] = await app.db
					.update(mediaUploadSessions)
					.set({ data: buffer, status: 'uploaded', updatedAt: new Date() })
					.where(
						and(
							eq(mediaUploadSessions.id, session.id),
							inArray(mediaUploadSessions.status, ['created', 'uploaded']),
						),
					)
					.returning({ id: mediaUploadSessions.id })
				if (!updated)
					return reply
						.status(409)
						.send({ error: 'Upload already completed or processing; call complete_media_upload' })
				return { uploadId: session.id, bytes: buffer.length, sha256: sha(buffer) }
			},
		)
	})
	app.post<{ Params: { id: string } }>('/uploads/:id/complete', editor, async (request, reply) => {
		if (!uuid.safeParse(request.params.id).success)
			throw ingestError('Upload session not found', 404)
		const input = completeSchema.safeParse(request.body ?? {})
		if (!input.success) throw ingestError(input.error.issues.map((i) => i.message).join('; '))
		const started = Date.now()
		for (;;) {
			const [session] = await app.db
				.select()
				.from(mediaUploadSessions)
				.where(
					and(
						eq(mediaUploadSessions.id, request.params.id),
						eq(mediaUploadSessions.projectId, getProject(request).id),
					),
				)
				.limit(1)
			if (!session) return reply.status(404).send({ error: 'Upload session not found' })
			if (
				session.userId !== getUser(request).id &&
				!['owner', 'admin'].includes(request.projectRole ?? '')
			)
				return reply
					.status(403)
					.send({ error: 'Only the uploading user or a project admin can complete this upload' })
			if (session.expiresAt.getTime() <= Date.now())
				return reply
					.status(410)
					.send({ error: 'Upload session expired; call create_media_upload again' })
			if (session.status === 'done' && session.result) {
				const target = session.result.target as { kind?: string; collectionId?: string } | undefined
				if (target?.kind === 'library' && !app.license.hasFeature('media-integrations'))
					throw ingestError('The library target requires the media-integrations license.', 403)
				if (target?.kind === 'collection' && target.collectionId) {
					const access = await checkCollectionAccess(request, target.collectionId, 'write')
					if (!access.ok) throw ingestError(access.error, access.status)
				}
				return session.result
			}
			if (session.status === 'processing') {
				// Recovery after an interrupted worker. CAS prevents stealing a fresh claim.
				await app.db
					.update(mediaUploadSessions)
					.set({ status: 'uploaded' })
					.where(
						and(
							eq(mediaUploadSessions.id, session.id),
							eq(mediaUploadSessions.status, 'processing'),
							lt(mediaUploadSessions.updatedAt, new Date(Date.now() - 300_000)),
						),
					)
				if (Date.now() - started >= 29_000)
					throw ingestError(
						'Upload completion is still processing. Call complete_media_upload again after it finishes.',
						409,
					)
				await new Promise((resolve) => setTimeout(resolve, 100))
				continue
			}
			if (!session.data)
				throw ingestError(
					'No image bytes uploaded. PUT the bytes to uploadUrl, then call complete_media_upload.',
				)
			const claimedAt = new Date()
			const [claim] = await app.db
				.update(mediaUploadSessions)
				.set({ status: 'processing', updatedAt: claimedAt })
				.where(
					and(
						eq(mediaUploadSessions.id, session.id),
						eq(mediaUploadSessions.status, 'uploaded'),
						eq(mediaUploadSessions.updatedAt, session.updatedAt),
					),
				)
				.returning()
			if (!claim) continue
			const owned = and(
				eq(mediaUploadSessions.id, session.id),
				eq(mediaUploadSessions.status, 'processing'),
				eq(mediaUploadSessions.updatedAt, claimedAt),
			)
			try {
				const result = await ingestMedia(app, request, {
					...input.data,
					buffer: claim.data ?? session.data,
					filename: input.data.filename ?? session.filename,
					mimeType: session.mimeType,
				})
				const [done] = await app.db
					.update(mediaUploadSessions)
					.set({ status: 'done', data: null, result, updatedAt: new Date() })
					.where(owned)
					.returning({ id: mediaUploadSessions.id })
				if (!done)
					throw ingestError(
						'Upload completed but its session expired or changed. Call list_media to reconcile before retrying.',
						409,
					)
				return result
			} catch (err) {
				await app.db
					.update(mediaUploadSessions)
					.set({ status: 'uploaded', updatedAt: new Date() })
					.where(owned)
				throw err
			}
		}
	})
	app.patch<{ Params: { id: string } }>('/items/:id', editor, async (request, reply) => {
		const parsed = editSchema.safeParse(request.body)
		if (!parsed.success) throw ingestError(parsed.error.issues.map((i) => i.message).join('; '))
		const input = parsed.data
		const pid = getProject(request).id
		if (uuid.safeParse(request.params.id).success) {
			const [item] = await app.db
				.select()
				.from(media)
				.where(and(eq(media.id, request.params.id), eq(media.projectId, pid)))
				.limit(1)
			if (item) {
				await app.requireLicense('media-integrations')(request, reply)
				if (reply.sent) return
				return app.db.transaction(async (tx) => {
					const [locked] = await tx
						.select()
						.from(media)
						.where(and(eq(media.id, item.id), eq(media.projectId, pid)))
						.for('update')
						.limit(1)
					if (!locked) throw ingestError('Media not found', 404)
					if (input.expectedHash && input.expectedHash !== mediaItemHash(locked))
						throw ingestError(
							'Media changed. Call list_media and reconcile before update_media.',
							409,
						)
					const [updated] = await tx
						.update(media)
						.set({
							...(input.alt !== undefined && { alt: input.alt }),
							...(input.filename !== undefined && { filename: input.filename }),
						})
						.where(and(eq(media.id, item.id), eq(media.projectId, pid)))
						.returning()
					return { ...updated, contentHash: mediaItemHash(updated) }
				})
			}
		}
		const ctx = await uploadContext(app, request)
		if (ctx.target?.kind !== 'collection')
			throw ingestError(
				ctx.info.problem ?? 'No media collection target configured; call list_media.',
				404,
			)
		const target = ctx.target
		if (!ctx.info.canUpload)
			throw ingestError(ctx.info.problem ?? 'Media collection is not writable', 403)
		const identity = and(
			eq(content.projectId, pid),
			eq(content.collectionId, target.collection.id),
			or(
				eq(content.externalId, request.params.id),
				...(uuid.safeParse(request.params.id).success ? [eq(content.id, request.params.id)] : []),
			),
		)
		const [cached] = await app.db.select({ id: content.id }).from(content).where(identity).limit(1)
		if (!cached) {
			const live = await fetchLiveExternalRecord(app, pid, target.collection.id, request.params.id)
			if (!live)
				throw ingestError('Media record not found. Call list_media to discover valid ids.', 404)
			await cacheMissingDocs(app.db, content, [live.doc], target.collection, {
				userId: getUser(request).id,
			})
		}
		return app.db.transaction(async (tx) => {
			const [item] = await tx
				.select()
				.from(content)
				.where(
					and(
						eq(content.projectId, pid),
						eq(content.collectionId, target.collection.id),
						or(
							eq(content.externalId, request.params.id),
							...(uuid.safeParse(request.params.id).success
								? [eq(content.id, request.params.id)]
								: []),
						),
					),
				)
				.for('update')
				.limit(1)
			if (!item)
				throw ingestError(
					'Media record not cached or not found. Call list_media to load the target collection before update_media.',
					404,
				)
			if (input.expectedHash && input.expectedHash !== contentHash(item))
				throw ingestError(
					'CONTENT_CONFLICT: Media changed. Call get_content and reconcile before update_media.',
					409,
				)
			const patch: Record<string, unknown> = {}
			for (const key of ['alt', 'filename'] as const)
				if (input[key] !== undefined) {
					const name = target.fields[key]
					if (!name)
						throw ingestError(
							`No ${key} field mapped. Set mediaUploads.fields.${key} before update_media.`,
						)
					patch[name] = input[key]
				}
			if (!item.externalId)
				throw ingestError(
					'Media record has no externalId; reconcile the external collection before update_media.',
					409,
				)
			const external = await updateExternalDb(
				app,
				pid,
				target.collection,
				item.externalId,
				patch,
				tx,
			)
			await tx.insert(contentVersions).values({
				contentId: item.id,
				version: item.version,
				markdown: item.markdown,
				metadata: item.metadata,
				createdBy: getUser(request).id,
				source: requestSource(request),
			})
			const [updated] = await tx
				.update(content)
				.set({
					metadata: {
						...item.metadata,
						...patch,
						...(target.collection.fields.some((f) => f.name === 'updatedAt') &&
						external?.written.updatedAt !== undefined
							? { updatedAt: external.written.updatedAt }
							: {}),
					},
					version: item.version + 1,
					updatedAt: new Date(),
					contentEditedAt: new Date(),
					updatedBy: getUser(request).id,
					updatedSource: requestSource(request),
				})
				.where(eq(content.id, item.id))
				.returning()
			return withContentHash(updated)
		})
	})
	const sweep = setInterval(() => {
		void app.db
			.delete(mediaUploadSessions)
			.where(lt(mediaUploadSessions.expiresAt, new Date()))
			.catch(() => app.log.warn('Expired media upload session cleanup failed'))
	}, 60_000)
	sweep.unref()
	app.addHook('onClose', async () => clearInterval(sweep))
}
