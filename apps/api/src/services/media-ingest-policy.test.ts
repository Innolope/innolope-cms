import type { collections, ProjectSettings } from '@innolope/db'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mediaDelivery, probeDelivery } from './media-delivery.js'
import {
	decodeImageData,
	detectMediaFields,
	fetchSourceImage,
	INLINE_MAX_BYTES,
	imageFilename,
	mediaUploadsSchema,
	resolveUploadTarget,
	sniffImage,
} from './media-ingest-policy.js'

const png = Buffer.from(
	'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/aV8AAAAASUVORK5CYII=',
	'base64',
)
const collection = (id: string, opts: Partial<typeof collections.$inferSelect> = {}) =>
	({
		id,
		name: id,
		label: id,
		source: 'external',
		externalTable: id,
		accessMode: 'read-write',
		fields: [
			'fullPath',
			'filename',
			'alt',
			'mimeType',
			'filesize',
			'width',
			'height',
			'createdAt',
			'updatedAt',
		].map((name) => ({ name, type: 'text' })),
		...opts,
	}) as typeof collections.$inferSelect
const settings = (extra: Record<string, unknown> = {}) =>
	({
		locales: ['en'],
		defaultLocale: 'en',
		mediaAdapter: 'cloudflare',
		...extra,
	}) as ProjectSettings
const access = { role: 'editor', licensed: true }
afterEach(() => {
	vi.useRealTimers()
	vi.unstubAllEnvs()
	vi.unstubAllGlobals()
})

describe('agent media byte gate (F1/F2)', () => {
	it('sniffs valid PNG independently of an extension or headers', () =>
		expect(sniffImage(png)).toEqual({ mimeType: 'image/png', width: 1, height: 1 }))
	it.each([
		'image/jpeg',
		'image/svg+xml',
		'text/html',
	])('refuses contradictory declaration %s', (mime) =>
		expect(() => sniffImage(png, mime)).toThrow(/detected image\/png/))
	it.each([
		Buffer.alloc(0),
		Buffer.from('<svg><script/></svg>'),
		Buffer.from('hello'),
		Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
	])('refuses empty, SVG, unknown and corrupt bytes', (bytes) =>
		expect(() => sniffImage(bytes)).toThrow(/Allowed:/))
	it('accepts strict base64 and a matching data URI', () => {
		expect(decodeImageData(png.toString('base64')).buffer).toEqual(png)
		expect(decodeImageData(`data:image/png;base64,${png.toString('base64')}`)).toEqual({
			buffer: png,
			declared: 'image/png',
		})
	})
	it.each([
		'!!!',
		'a',
		'a===',
		'data:image/png,not-base64',
		'ab-c',
		'====',
	])('rejects malformed base64 %s', (value) =>
		expect(() => decodeImageData(value)).toThrow(/base64/))
	it('enforces real decoded 1 MiB inclusive and directs larger inputs to two-step', () => {
		expect(decodeImageData(Buffer.alloc(INLINE_MAX_BYTES).toString('base64')).buffer).toHaveLength(
			INLINE_MAX_BYTES,
		)
		expect(() => decodeImageData(Buffer.alloc(INLINE_MAX_BYTES + 1).toString('base64'))).toThrow(
			/create_media_upload/,
		)
	})
	it('sanitizes paths, controls and Unicode while always matching the type extension', () => {
		expect(imageFilename('image/png', '../../hello.svg')).toBe('hello.png')
		expect(imageFilename('image/jpeg', 'C:\\tmp\\photo.PNG')).toBe('photo.jpg')
		expect(imageFilename('image/gif')).toMatch(/^image-[a-f0-9-]+\.gif$/)
		// Seed 503; deterministic parser/filename fuzz, 2,000 samples, no external workload.
		let seed = 503
		for (let i = 0; i < 2000; i++) {
			let value = ''
			for (let j = 0; j < 40; j++) {
				seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
				value += String.fromCharCode(seed % 65536)
			}
			const name = imageFilename('image/webp', value)
			expect(name).toMatch(/\.webp$/)
			expect(name).not.toMatch(/[\\/\r\n]/)
			expect(name.includes(String.fromCharCode(0))).toBe(false)
			expect(name.length).toBeLessThanOrEqual(155)
		}
	})
})
describe('target resolution and field/settings contracts (F4/F3)', () => {
	it('returns exact default shape for the library', () => {
		const { info } = resolveUploadTarget({ settings: settings() }, [], access)
		expect(info).toEqual({
			setting: { target: 'auto', collectionId: null, fields: {}, deliveryVariant: null },
			resolved: {
				kind: 'library',
				collectionId: null,
				collectionName: null,
				collectionLabel: null,
				fields: null,
				deliveryVariant: 'public',
			},
			candidates: [],
			allowedTypes: ['image/jpeg', 'image/png', 'image/webp', 'image/gif'],
			maxBytes: 10_000_000,
			canUpload: true,
			problem: null,
		})
	})
	it('selects the unique writable target; prefers a unique relation target among several', () => {
		const cols = [
			collection('a'),
			collection('b'),
			collection('articles', {
				source: 'internal',
				fields: [{ name: 'postImage', type: 'relation', relationTo: 'b' }],
			}),
		]
		const project = {
			settings: settings({
				externalDb: {
					mediaStorage: {
						a: { adapter: 'r2', pathColumn: 'fullPath' },
						b: { adapter: 'cloudflare-images', pathColumn: 'fullPath', pathVariant: 'site' },
					},
				},
			}),
		}
		expect(resolveUploadTarget(project, [cols[0]], access).info.resolved.collectionId).toBe('a')
		expect(resolveUploadTarget(project, cols, access).info.resolved).toMatchObject({
			kind: 'collection',
			collectionId: 'b',
			deliveryVariant: 'site',
		})
		const ambiguous = resolveUploadTarget(project, cols.slice(0, 2), access).info
		expect(ambiguous.canUpload).toBe(false)
		expect(ambiguous.problem).toMatch(/a.*b.*mediaUploads.collectionId/)
		expect(ambiguous.resolved.kind).toBeNull()
	})
	it('refuses explicit missing, read-only and nonwritable targets; auto falls back to library', () => {
		for (const adapter of ['absolute', 'custom-url', 's3']) {
			const project = {
				settings: settings({
					mediaUploads: { target: 'collection', collectionId: 'a' },
					externalDb: { mediaStorage: { a: { adapter, pathColumn: 'fullPath' } } },
				}),
			}
			expect(resolveUploadTarget(project, [collection('a')], access).info.canUpload).toBe(false)
		}
		const project = {
			settings: settings({
				mediaUploads: { target: 'collection', collectionId: 'a' },
				externalDb: { mediaStorage: { a: { adapter: 'r2', pathColumn: 'fullPath' } } },
			}),
		}
		expect(
			resolveUploadTarget(project, [collection('a', { accessMode: 'read-only' })], access).info
				.canUpload,
		).toBe(false)
		project.settings.mediaUploads = { target: 'auto' }
		expect(
			resolveUploadTarget(project, [collection('a', { accessMode: 'read-only' })], access).info
				.resolved.kind,
		).toBe('library')
	})
	it('reports license and viewer restrictions independently', () => {
		expect(
			resolveUploadTarget({ settings: settings() }, [], { ...access, licensed: false }).info
				.problem,
		).toMatch(/license/)
		expect(
			resolveUploadTarget({ settings: settings() }, [], { ...access, role: 'viewer' }).info.problem,
		).toMatch(/Editor/)
	})
	it.each([
		'alt',
		'altText',
		'alt_text',
		'alternativeText',
		'ALTTEXT',
	])('detects alt spelling %s and camel-case metadata', (alt) => {
		const col = collection('a', {
			fields: ['path', 'fileName', 'mimeType', 'fileSize', 'image_width', 'height', alt].map(
				(name) => ({ name, type: 'text' }),
			),
		})
		expect(detectMediaFields(col, { adapter: 'r2', pathColumn: 'path' })).toEqual({
			path: 'path',
			filename: 'fileName',
			mimeType: 'mimeType',
			size: 'fileSize',
			width: 'image_width',
			height: 'height',
			alt,
		})
	})
	it('respects overrides; refuses nonexistent and overlapping mappings before writes', () => {
		const project = {
			settings: settings({
				mediaUploads: {
					target: 'collection',
					collectionId: 'a',
					fields: { alt: 'filename', filename: 'filename' },
				},
				externalDb: { mediaStorage: { a: { adapter: 'r2', pathColumn: 'fullPath' } } },
			}),
		}
		expect(resolveUploadTarget(project, [collection('a')], access).info.canUpload).toBe(false)
		project.settings.mediaUploads = {
			target: 'collection',
			collectionId: 'a',
			fields: { alt: 'missing' },
		}
		expect(resolveUploadTarget(project, [collection('a')], access).info.problem).toMatch(/mapping/)
	})
	it('validates settings strictly while retaining auto/defaults and safe transforms', () => {
		expect(mediaUploadsSchema.safeParse({}).success).toBe(true)
		expect(mediaUploadsSchema.safeParse({ target: 'collection' }).success).toBe(false)
		expect(
			mediaUploadsSchema.safeParse({
				target: 'auto',
				deliveryVariant: 'format=auto,quality=80,width=1440',
			}).success,
		).toBe(true)
		for (const invalid of [
			{ fields: { alt: '_id' } },
			{ fields: { alt: '$set' } },
			{ fields: { filename: 'constructor' } },
			{ deliveryVariant: 'public?token=secret' },
			{ target: 'bogus' },
			{ extra: true },
		])
			expect(mediaUploadsSchema.safeParse(invalid).success).toBe(false)
	})
})
describe('bounded streaming source fetch (F5/F2)', () => {
	it('bounds a URL guard or source that never resolves even if it ignores AbortSignal', async () => {
		vi.useFakeTimers()
		const pending = fetchSourceImage(
			'https://source.test/x',
			100,
			async () => new Promise<Response>(() => {}),
		)
		const assertion = expect(pending).rejects.toThrow(/timed out/)
		await vi.advanceTimersByTimeAsync(20_000)
		await assertion
	})
	const fetcher = (response: Response) => vi.fn(async () => response)
	it('reads bytes even with absent/lied size and derives Content-Disposition filename', async () => {
		const response = new Response(png, {
			headers: { 'content-length': '1', 'content-disposition': 'attachment; filename="chart.jpg"' },
		})
		const result = await fetchSourceImage(
			'https://source.test/contentUri',
			png.length,
			fetcher(response),
		)
		expect(result.buffer).toEqual(png)
		expect(result.filename).toBe('chart.jpg')
	})
	it.each([403, 404, 302])('reports source HTTP/redirect error %s', async (status) => {
		await expect(
			fetchSourceImage('https://source.test/x', 100, fetcher(new Response(null, { status }))),
		).rejects.toThrow(status === 302 ? /redirect/ : new RegExp(`${status}`))
	})
	it('aborts streamed bytes over actual cap and cancels the reader', async () => {
		let cancelled = false
		const body = new ReadableStream({
			start(c) {
				c.enqueue(new Uint8Array(8))
				c.enqueue(new Uint8Array(8))
			},
			cancel() {
				cancelled = true
			},
		})
		await expect(
			fetchSourceImage('https://source.test/x', 10, fetcher(new Response(body))),
		).rejects.toThrow(/large/)
		expect(cancelled).toBe(true)
	})
	it('preserves a blocked address error', async () => {
		await expect(
			fetchSourceImage('https://source.test/x', 100, async () => {
				throw new Error('Request to private/internal addresses is not allowed')
			}),
		).rejects.toThrow(/private/)
	})
	it('propagates an overall 20-second timeout', async () => {
		vi.useFakeTimers()
		const pending = fetchSourceImage(
			'https://source.test/x',
			100,
			async (_url, init) =>
				new Promise((_resolve, reject) =>
					init?.signal?.addEventListener('abort', () => reject(new Error('aborted'))),
				),
		)
		const assertion = expect(pending).rejects.toThrow(/timed out/)
		await vi.advanceTimersByTimeAsync(20_000)
		await assertion
	})
})
describe('renderable delivery URLs (F9)', () => {
	it('bounds a stalled guard/probe to five seconds', async () => {
		vi.useFakeTimers()
		const pending = probeDelivery(
			'https://cdn.test/image',
			async () => new Promise<Response>(() => {}),
		)
		await vi.advanceTimersByTimeAsync(5_000)
		expect(await pending).toBe(false)
	})
	it('resolves local library files against the CMS origin', async () => {
		expect(
			(
				await mediaDelivery(
					'/uploads/image.png',
					{
						kind: 'library',
						variant: 'public',
						fallbackVariant: 'public',
						baseUrl: 'https://cms.test',
					},
					async () => true,
				)
			).deliveryUrl,
		).toBe('https://cms.test/uploads/image.png')
	})
	it('uses configured transform, falls back to named variant and exposes failed probe', async () => {
		const base = 'https://imagedelivery.net/hash/id'
		const probe = vi.fn(async (url: string) => url.endsWith('/site'))
		const result = await mediaDelivery(
			`${base}/public`,
			{ kind: 'library', variant: 'width=1440', fallbackVariant: 'site' },
			probe,
		)
		expect(result).toMatchObject({ deliveryUrl: `${base}/site`, deliveryVerified: true })
		expect(result.warnings).toEqual([expect.stringContaining('transform failed')])
		const failed = await mediaDelivery(
			`${base}/public`,
			{ kind: 'library', variant: 'public', fallbackVariant: 'public' },
			async () => false,
		)
		expect(failed.deliveryVerified).toBe(false)
		expect(failed.warnings?.[0]).toContain('check_media')
	})
	it('completes bare CF URLs and non-CF storage values', async () => {
		expect(
			(
				await mediaDelivery(
					'https://imagedelivery.net/hash/id',
					{ kind: 'library', variant: 'public', fallbackVariant: 'public' },
					async () => true,
				)
			).deliveryUrl,
		).toBe('https://imagedelivery.net/hash/id/public')
		expect(
			(
				await mediaDelivery(
					'https://cdn.test/a.png',
					{ kind: 'library', variant: 'public', fallbackVariant: 'public' },
					async () => true,
				)
			).deliveryUrl,
		).toBe('https://cdn.test/a.png')
	})
	it.each([405, 501])('falls back from HEAD %s to ranged GET, cancels the body', async (status) => {
		const calls: RequestInit[] = []
		expect(
			await probeDelivery('https://cdn.test/image', async (_url, init) => {
				calls.push(init ?? {})
				return new Response(null, { status: calls.length === 1 ? status : 206 })
			}),
		).toBe(true)
		expect(calls.map((c) => c.method)).toEqual(['HEAD', 'GET'])
		expect(calls[1].headers).toEqual({ Range: 'bytes=0-0' })
	})
	it('turns probe network failures into unverified, never fabricated success', async () =>
		expect(
			await probeDelivery('https://cdn.test/image', async () => {
				throw new Error('network')
			}),
		).toBe(false))
})
