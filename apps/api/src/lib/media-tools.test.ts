import { registerTools } from '@innolope/mcp-server/lib'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'

vi.mock('node:dns/promises', () => ({
	lookup: vi.fn(async () => [{ address: '8.8.8.8', family: 4 }]),
}))
const projectId = '11111111-1111-4111-8111-111111111111'
const image = (i = 1) => ({
	id: `image-${i}`,
	externalId: `external-${i}`,
	filename: `chart-${i}.png`,
	fullPath: `https://imagedelivery.net/hash/id-${i}/public`,
	deliveryUrl: `https://imagedelivery.net/hash/id-${i}/public`,
	deliveryVerified: true,
	width: 1,
	height: 1,
	bytes: 100,
	mimeType: 'image/png',
	sha256: 'abc',
	duplicate: false,
	target: { kind: 'collection', collectionId: projectId, collectionName: 'blog-media' },
})
type Result = {
	isError?: boolean
	content: { text?: string }[]
	structuredContent?: Record<string, unknown>
}
type Tool = {
	config: {
		inputSchema: z.ZodRawShape
		outputSchema?: z.ZodRawShape
		annotations: Record<string, unknown>
	}
	handler: (args: unknown) => Promise<Result>
}
const text = (r: Result) => r.content.map((c) => c.text).join('\n')
describe('registered agent media tools', () => {
	let tools: Map<string, Tool>
	let client: ReturnType<typeof fakeClient>
	const fakeClient = () => ({
		listProjects: vi.fn(async () => [
			{ id: projectId, slug: 'media', name: 'Media' },
			{ id: '22222222-2222-4222-8222-222222222222', slug: 'other', name: 'Other' },
		]),
		getProjectId: () => projectId,
		trackToolCall: vi.fn(),
		runWithProject: async (_id: string, run: () => unknown) => run(),
		ingestMedia: vi.fn(async () => image()),
		createMediaUpload: vi.fn(async () => ({
			uploadId: projectId,
			uploadUrl: 'https://cms.test/api/v1/media/uploads/id/content?token=sensitive',
			method: 'PUT' as const,
			headers: { 'Content-Type': 'image/png' },
			expiresAt: '2026-11-03T12:30:00Z',
			maxBytes: 10000,
		})),
		completeMediaUpload: vi.fn(async () => image()),
		updateMedia: vi.fn(async () => ({ id: projectId, alt: 'New' })),
		listUploadMedia: vi.fn(async () => ({
			target: { resolved: { kind: 'collection', collectionLabel: 'Blog media' }, problem: null },
			data: [
				{
					id: 'item',
					url: 'https://imagedelivery.net/hash/new/public',
					fullPath: 'https://imagedelivery.net/hash/new/public',
					filename: 'new.png',
					size: 100,
					alt: 'New',
					externalId: 'ext-new',
					type: 'image',
				},
			],
			pagination: { page: 1, total: 1 },
		})),
		listMedia: vi.fn(async () => ({
			data: [
				{ id: 'old-media', url: 'https://imagedelivery.net/hash/old/public', filename: 'old.png' },
			],
		})),
		getContent: vi.fn(async () => ({
			id: 'article',
			metadata: { title: 'Article' },
			markdown:
				'![New](https://imagedelivery.net/hash/new/width=1440)\n![Old](https://imagedelivery.net/hash/old/width=1440)',
		})),
	})
	const invoke = async (name: string, args: Record<string, unknown>) => {
		const tool = tools.get(name)
		if (!tool) throw new Error(`Missing ${name}`)
		const result = await tool.handler(z.object(tool.config.inputSchema).parse(args))
		if (!result.isError && tool.config.outputSchema)
			expect(z.object(tool.config.outputSchema).safeParse(result.structuredContent).success).toBe(
				true,
			)
		return result
	}
	beforeEach(() => {
		tools = new Map()
		client = fakeClient()
		registerTools(
			{
				registerTool: (name: string, config: Tool['config'], handler: Tool['handler']) =>
					tools.set(name, { config, handler }),
			} as never,
			client as never,
		)
	})
	afterEach(() => vi.unstubAllGlobals())
	it('registers typed create/update operations and per-call project schema', () => {
		for (const name of [
			'upload_media',
			'create_media_upload',
			'complete_media_upload',
			'update_media',
		]) {
			const tool = tools.get(name)
			expect(tool?.config.outputSchema).toBeDefined()
			expect(tool?.config.inputSchema.project).toBeDefined()
			expect(tool?.config.annotations.readOnlyHint).toBe(false)
		}
	})
	it('uses Task 1 recovery for an unselected or unknown project without invoking ingest', async () => {
		vi.spyOn(client, 'getProjectId').mockReturnValue(undefined as never)
		const missing = await invoke('upload_media', { sourceUrl: 'https://source.test/image' })
		expect(missing.isError).toBe(true)
		expect(text(missing)).toContain('use_project')
		const unknown = await invoke('upload_media', {
			project: 'missing',
			sourceUrl: 'https://source.test/image',
		})
		expect(unknown.isError).toBe(true)
		expect(text(unknown)).toContain('Unknown project')
		expect(client.ingestMedia).not.toHaveBeenCalled()
	})
	it('uploads six images with bounded concurrency four, preserves item order and markdown snippets', async () => {
		let active = 0
		let peak = 0
		client.ingestMedia.mockImplementation(async (input?: unknown) => {
			active++
			peak = Math.max(active, peak)
			const i = Number((input as { sourceUrl: string }).sourceUrl.split('/').pop())
			await new Promise((resolve) => setTimeout(resolve, i === 1 ? 15 : 1))
			active--
			return image(i)
		})
		const result = await invoke('upload_media', {
			items: Array.from({ length: 6 }, (_, i) => ({
				sourceUrl: `https://source.test/${i + 1}`,
				alt: `Chart ${i + 1}`,
			})),
		})
		expect(result.isError).toBe(false)
		expect(peak).toBe(4)
		expect((result.structuredContent?.results as { id: string }[]).map((r) => r.id)).toEqual(
			Array.from({ length: 6 }, (_, i) => `image-${i + 1}`),
		)
		expect(text(result)).toContain('![Chart 1](https://imagedelivery.net/hash/id-1/public)')
		expect(text(result)).toContain('external-6')
	})
	it('states partial failures first and marks only all-failed batches as errors', async () => {
		client.ingestMedia.mockRejectedValueOnce(new Error('Source HTTP 403'))
		let result = await invoke('upload_media', {
			items: [{ sourceUrl: 'https://source.test/1' }, { sourceUrl: 'https://source.test/2' }],
		})
		expect(text(result)).toMatch(/^1 of 2 failed:/)
		expect(result.isError).toBe(false)
		client.ingestMedia.mockRejectedValue(new Error('Storage failure'))
		result = await invoke('upload_media', { sourceUrl: 'https://source.test/1' })
		expect(result.isError).toBe(true)
		expect(text(result)).toContain('list_media')
	})
	it('rejects batch mixing or more than twenty items before calling ingest', async () => {
		expect((await invoke('upload_media', { items: [{ data: 'abc' }], data: 'abc' })).isError).toBe(
			true,
		)
		await expect(
			invoke('upload_media', {
				items: Array.from({ length: 21 }, () => ({ sourceUrl: 'https://source.test/image' })),
			}),
		).rejects.toThrow()
		expect(client.ingestMedia).not.toHaveBeenCalled()
	})
	it('provides capability curl and a typed replayable completion', async () => {
		const created = await invoke('create_media_upload', {
			filename: 'local.png',
			mimeType: 'image/png',
			bytes: 100,
		})
		expect(text(created)).toContain('curl -X PUT')
		expect(text(created)).toContain('--data-binary @<file>')
		expect(text(created)).toContain('complete_media_upload')
		const complete = await invoke('complete_media_upload', {
			uploadId: projectId,
			alt: 'Local chart',
		})
		expect(text(complete)).toContain('![Local chart]')
	})
	it('edits named fields without fetching or requiring a hash', async () => {
		const result = await invoke('update_media', { id: 'ext-new', alt: 'New' })
		expect(result.isError).not.toBe(true)
		expect(client.updateMedia).toHaveBeenCalledWith('ext-new', { alt: 'New' })
		expect(client.getContent).not.toHaveBeenCalled()
	})
	it('keeps base64 and signed source URLs out of usage telemetry', async () => {
		await invoke('upload_media', { data: 'AAAA', sourceUrl: undefined })
		expect(JSON.stringify(client.trackToolCall.mock.calls)).not.toContain('AAAA')
		expect(JSON.stringify(client.trackToolCall.mock.calls)).toContain('[redacted]')
	})
	it('R12 names the target and explains a forbidden library listing', async () => {
		client.listUploadMedia.mockResolvedValue({
			target: { resolved: { kind: 'library' }, problem: null },
			data: [],
			pagination: { page: 1, total: 0 },
			note: 'The media library requires the media-integrations license.',
		} as never)
		const result = await invoke('list_media', {})
		expect(result.isError).not.toBe(true)
		expect(text(result)).toContain('Agent uploads: library')
		expect(text(result)).toContain('media-integrations license')
	})

	it('discovers target uploads and checks both the collection and existing library independent of CF variant', async () => {
		const listed = await invoke('list_media', {})
		expect(text(listed)).toContain('Agent uploads: Blog media')
		expect(text(listed)).toContain('externalId: ext-new')
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => new Response(null, { status: 200 })),
		)
		const checked = await invoke('check_media', { id: 'article' })
		expect(text(checked)).toContain('yes (id: item, externalId: ext-new)')
		expect(text(checked)).toContain('yes (id: old-media)')
		expect(text(checked)).toContain('All 2 image(s) serve correctly')
	})
})
