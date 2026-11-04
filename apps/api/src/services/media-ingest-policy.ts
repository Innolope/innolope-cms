import { randomUUID } from 'node:crypto'
import type { collections, ProjectSettings } from '@innolope/db'
import { z } from 'zod'
import { safeFetch } from '../adapters/connection-guard.js'
import { getImageDimensions } from '../lib/image.js'
import { getMediaStorageMap, type MediaStorageEntry } from '../lib/media-storage.js'
import { isWritableImportedStorage } from '../lib/media-upload.js'
import { effectiveAdapterName, mediaMaxSize } from '../plugins/media.js'

export const AGENT_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'] as const
export const INLINE_MAX_BYTES = 1024 * 1024
export const mediaUploadFields = [
	'path',
	'filename',
	'alt',
	'mimeType',
	'size',
	'width',
	'height',
] as const
const column = z
	.string()
	.min(1)
	.max(128)
	.regex(/^[a-zA-Z_][a-zA-Z0-9_]*$/)
	.refine((v) => !['__proto__', 'prototype', 'constructor', '_id'].includes(v), 'Unsafe field name')
export const mediaUploadsSchema = z
	.object({
		target: z.enum(['auto', 'library', 'collection']).optional(),
		collectionId: z.string().uuid().optional(),
		fields: z
			.object(
				Object.fromEntries(mediaUploadFields.map((k) => [k, column.optional()])) as Record<
					(typeof mediaUploadFields)[number],
					z.ZodOptional<typeof column>
				>,
			)
			.strict()
			.optional(),
		deliveryVariant: z
			.string()
			.min(1)
			.max(250)
			.regex(/^[a-zA-Z0-9_=,.-]+$/)
			.optional(),
	})
	.strict()
	.superRefine((v, ctx) => {
		if (v.target === 'collection' && !v.collectionId)
			ctx.addIssue({
				code: 'custom',
				path: ['collectionId'],
				message: 'collectionId is required when mediaUploads.target is collection',
			})
	})
export type MediaUploadSetting = z.infer<typeof mediaUploadsSchema>
type Collection = typeof collections.$inferSelect
export type MediaFields = Record<(typeof mediaUploadFields)[number], string | null>
export type IngestTarget =
	| { kind: 'library'; variant: string; fallbackVariant: string; baseUrl?: string }
	| {
			kind: 'collection'
			collection: Collection
			entry: MediaStorageEntry
			fields: MediaFields
			variant: string
			fallbackVariant: string
	  }
/**
 * An ingest failure whose message is written for the caller. `expose` keeps the
 * global error handler from replacing a 5xx message (a storage provider or
 * external-database step failing) with a generic "Internal server error".
 */
export function ingestError(
	message: string,
	statusCode = 400,
): Error & { statusCode: number; expose: true } {
	return Object.assign(new Error(message), { statusCode, expose: true as const })
}
const heuristics = {
	filename: /(^|_)(filename|name)($|_)/i,
	mimeType: /(^|_)(mimetype|mime)($|_)/i,
	size: /(^|_)(filesize|size)($|_)/i,
	width: /(^|_)width($|_)/i,
	height: /(^|_)height($|_)/i,
	alt: /^(alt|altText|alt_text|alternativeText)$/i,
}
export function detectMediaFields(
	col: Pick<Collection, 'fields'>,
	entry: MediaStorageEntry,
	overrides: MediaUploadSetting['fields'] = {},
): MediaFields {
	const names = col.fields.map((f) => f.name)
	const result: MediaFields = {
		path: overrides.path ?? entry.pathColumn,
		filename: null,
		alt: null,
		mimeType: null,
		size: null,
		width: null,
		height: null,
	}
	const used = new Set([result.path, ...Object.values(overrides)])
	for (const key of ['mimeType', 'filename', 'size', 'width', 'height', 'alt'] as const) {
		const field =
			overrides[key] ??
			names.find(
				(n) =>
					!used.has(n) &&
					heuristics[key].test(key === 'alt' ? n : n.replace(/([a-z0-9])([A-Z])/g, '$1_$2')),
			) ??
			null
		result[key] = field
		if (field) used.add(field)
	}
	return result
}
export function resolveUploadTarget(
	project: { settings: ProjectSettings },
	cols: Collection[],
	access: { role?: string; licensed: boolean },
) {
	const setting = {
		target: 'auto' as 'auto' | 'library' | 'collection',
		collectionId: null as string | null,
		fields: {} as Record<string, string>,
		deliveryVariant: null as string | null,
		...project.settings.mediaUploads,
	}
	const map = getMediaStorageMap(project)
	const usable = cols.filter(
		(c) =>
			c.source === 'external' &&
			c.externalTable &&
			c.accessMode !== 'read-only' &&
			isWritableImportedStorage(map[c.externalTable]),
	)
	let chosen: Collection | undefined
	let problem: string | null = null
	if (setting.target === 'collection') {
		chosen = usable.find((c) => c.id === setting.collectionId)
		if (!chosen)
			problem =
				'Configured media collection is missing, read-only, or has no writable imported storage. Set mediaUploads.collectionId to a writable candidate.'
	} else if (setting.target === 'auto') {
		if (usable.length === 1) chosen = usable[0]
		if (usable.length > 1) {
			const preferred = usable.filter((c) =>
				cols.some(
					(other) =>
						other.id !== c.id &&
						other.fields.some(
							(f) =>
								f.type === 'relation' &&
								[c.id, c.name, c.externalTable].includes(f.relationTo ?? ''),
						),
				),
			)
			if (preferred.length === 1) chosen = preferred[0]
			else
				problem = `Ambiguous media upload target: ${usable.map((c) => `${c.label} (${c.id})`).join(', ')}. Set mediaUploads.target to collection and mediaUploads.collectionId.`
		}
	}
	const fallbackVariant =
		(chosen && map[chosen.externalTable ?? '']?.pathVariant) ||
		project.settings.cloudflare?.imagesVariant ||
		'public'
	const variant = setting.deliveryVariant ?? fallbackVariant
	let target: IngestTarget | null = problem ? null : { kind: 'library', variant, fallbackVariant }
	if (chosen) {
		const entry = map[chosen.externalTable ?? '']
		const fields = detectMediaFields(chosen, entry, setting.fields)
		const mapped = Object.values(fields).filter((v): v is string => v !== null)
		if (
			mapped.some((n) => !chosen.fields.some((f) => f.name === n)) ||
			new Set(mapped).size !== mapped.length
		) {
			problem =
				'Media field mapping must name distinct declared fields. Update mediaUploads.fields.'
			target = null
		} else
			target = { kind: 'collection', collection: chosen, entry, fields, variant, fallbackVariant }
	}
	const kind = target?.kind ?? null
	const maxBytes = Math.min(
		mediaMaxSize(),
		(
			target?.kind === 'collection'
				? target.entry.adapter === 'cloudflare-images'
				: effectiveAdapterName(project.settings) === 'cloudflare'
		)
			? 10_000_000
			: mediaMaxSize(),
	)
	if (!problem && !['editor', 'admin', 'owner'].includes(access.role ?? ''))
		problem = 'Editor project role is required to upload media.'
	if (!problem && kind === 'library' && !access.licensed)
		problem = 'The library target requires the media-integrations license.'
	return {
		target,
		info: {
			setting,
			resolved: {
				kind,
				collectionId: chosen?.id ?? null,
				collectionName: chosen?.name ?? null,
				collectionLabel: chosen?.label ?? null,
				fields: target?.kind === 'collection' ? target.fields : null,
				deliveryVariant: target ? variant : null,
			},
			candidates: usable.map((c) => ({ id: c.id, name: c.name, label: c.label })),
			allowedTypes: [...AGENT_IMAGE_TYPES],
			maxBytes,
			canUpload: !problem,
			problem,
		},
	}
}
export function normalizeImageMime(value?: string) {
	return value === 'image/jpg' ? 'image/jpeg' : value
}
export function sniffImage(buffer: Buffer, declared?: string) {
	declared = normalizeImageMime(declared)
	let detected = 'unknown'
	if (buffer.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) detected = 'image/jpeg'
	else if (buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])))
		detected = 'image/png'
	else if (/^GIF8[79]a$/.test(buffer.subarray(0, 6).toString('ascii'))) detected = 'image/gif'
	else if (
		buffer.subarray(0, 4).toString() === 'RIFF' &&
		buffer.subarray(8, 12).toString() === 'WEBP'
	)
		detected = 'image/webp'
	else if (
		buffer
			.subarray(0, 1000)
			.toString()
			.match(/<svg\b/i)
	)
		detected = 'image/svg+xml'
	if (!(AGENT_IMAGE_TYPES as readonly string[]).includes(detected))
		throw ingestError(
			`Detected ${detected}${buffer.length ? '' : ' (empty body)'}. Allowed: ${AGENT_IMAGE_TYPES.join(', ')}. SVG is not supported.`,
		)
	if (declared && declared !== detected)
		throw ingestError(
			`Declared ${declared} contradicts detected ${detected}. Allowed: ${AGENT_IMAGE_TYPES.join(', ')}.`,
		)
	const dimensions = getImageDimensions(buffer)
	if (!dimensions || dimensions.width <= 0 || dimensions.height <= 0)
		throw ingestError(
			`Corrupt image: detected ${detected} but the bytes do not decode. Allowed: ${AGENT_IMAGE_TYPES.join(', ')}.`,
		)
	return { mimeType: detected, ...dimensions }
}
export function imageFilename(mime: string, input?: string) {
	const extensions: Record<string, string> = {
		'image/jpeg': 'jpg',
		'image/png': 'png',
		'image/webp': 'webp',
		'image/gif': 'gif',
	}
	let name = input ?? ''
	try {
		name = decodeURIComponent(name)
	} catch {
		/* preserve malformed URL text for sanitizing */
	}
	const base = name
		.split(/[\\/]/)
		.pop()
		?.replace(/\.[^.]*$/, '')
		.replace(/[^\p{L}\p{N}._-]+/gu, '-')
		.replace(/^[.-]+|[.-]+$/g, '')
		.slice(0, 150)
	return `${base || `image-${randomUUID().slice(0, 8)}`}.${extensions[mime]}`
}
export function decodeImageData(data: string): { buffer: Buffer; declared?: string } {
	const match = /^data:([^;,]+);base64,([\s\S]*)$/.exec(data)
	const encoded = (match ? match[2] : data).replace(/[\t\n\v\f\r ]/g, '')
	if (encoded.length > 4 * Math.ceil(INLINE_MAX_BYTES / 3))
		throw ingestError(
			'Base64 data exceeds 1 MB decoded. Call create_media_upload for the two-step upload.',
		)
	if (!encoded || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded))
		throw ingestError(
			'Invalid base64 image data. Encode with base64 -w0. Use upload_media with sourceUrl or create_media_upload.',
		)
	const buffer = Buffer.from(encoded, 'base64')
	if (buffer.length > INLINE_MAX_BYTES)
		throw ingestError(
			'Base64 data exceeds 1 MB decoded. Call create_media_upload for the two-step upload.',
		)
	return { buffer, declared: normalizeImageMime(match?.[1]) }
}
export async function fetchSourceImage(
	url: string,
	maxBytes: number,
	fetcher: typeof safeFetch = safeFetch,
) {
	const controller = new AbortController()
	let timer: ReturnType<typeof setTimeout> | undefined
	const timeout = new Promise<never>((_resolve, reject) => {
		timer = setTimeout(() => {
			controller.abort()
			reject(ingestError('Source image fetch timed out after 20 seconds.'))
		}, 20_000)
	})
	try {
		const response = await Promise.race([
			fetcher(url, { signal: controller.signal }, { maxRedirects: 5 }),
			timeout,
		])
		if (!response.ok) {
			await response.body?.cancel()
			throw ingestError(
				response.status >= 300 && response.status < 400
					? 'Source redirect limit exceeded (5 redirects).'
					: `Source returned HTTP ${response.status}.`,
			)
		}
		const reader = response.body?.getReader()
		if (!reader) throw ingestError('Source returned an empty body.')
		const chunks: Buffer[] = []
		let size = 0
		try {
			for (;;) {
				const { done, value } = await Promise.race([reader.read(), timeout])
				if (done) break
				size += value.byteLength
				if (size > maxBytes) {
					controller.abort()
					throw ingestError(`Source image is too large; maximum ${maxBytes} bytes.`)
				}
				chunks.push(Buffer.from(value))
			}
		} finally {
			void reader.cancel().catch(() => {})
		}
		const disposition = response.headers.get('content-disposition')
		const name =
			/filename\*=UTF-8''([^;]+)/i.exec(disposition ?? '')?.[1] ??
			/filename="?([^";]+)/i.exec(disposition ?? '')?.[1]
		return {
			buffer: Buffer.concat(chunks),
			filename: name || new URL(url).pathname.split('/').pop(),
		}
	} catch (err) {
		if (controller.signal.aborted && !(err instanceof Error && 'statusCode' in err))
			throw ingestError('Source image fetch timed out after 20 seconds.')
		throw ingestError(err instanceof Error ? err.message : 'Source fetch failed.')
	} finally {
		clearTimeout(timer)
	}
}
