import { registerTools } from '@innolope/mcp-server/lib'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'

const currentHash = `sha256:${'a'.repeat(64)}`
const nextHash = `sha256:${'b'.repeat(64)}`
const recordId = '00000000-0000-4000-8000-000000000001'
const collectionId = '00000000-0000-4000-8000-000000000002'
const projectId = '00000000-0000-4000-8000-000000000003'
type ToolResult = {
	isError?: boolean
	structuredContent?: unknown
	content: { type: string; text?: string }[]
}
type CapturedTool = {
	config: { inputSchema: Record<string, z.ZodType> }
	handler: (args: unknown) => Promise<ToolResult>
}

describe('MCP agent content hash acceptance', () => {
	let tools: Map<string, CapturedTool>
	let client: ReturnType<typeof createClient>
	const record = (contentHash = currentHash) => ({
		id: recordId,
		collectionId,
		projectId,
		slug: 'hash-acceptance',
		status: 'draft',
		version: 1,
		metadata: { title: 'Hash acceptance' },
		markdown: 'Body',
		contentHash,
	})
	const createClient = () => ({
		getProjectId: vi.fn(() => projectId),
		trackToolCall: vi.fn(),
		trackAnalytics: vi.fn(),
		getContent: vi.fn(async () => record()),
		updateContent: vi.fn(async () => record(nextHash)),
		publishContent: vi.fn(async () => ({ ...record(nextHash), status: 'published' })),
		submitForReview: vi.fn(async () => ({ ...record(nextHash), status: 'in_review' })),
		deleteContent: vi.fn(async () => ({ success: true })),
		bulkUpdateContent: vi.fn(async () => ({ data: [record(nextHash)], count: 1 })),
	})
	const invoke = async (name: string, args: Record<string, unknown>) => {
		const tool = tools.get(name)
		expect(tool, `registered ${name}`).toBeDefined()
		if (!tool) throw new Error(`Expected registered tool ${name}`)
		return tool.handler(z.object(tool.config.inputSchema).parse(args))
	}
	const rejected = async (name: string, args: Record<string, unknown>) => {
		let result: ToolResult
		try {
			result = await invoke(name, args)
		} catch (error) {
			expect(error).toBeInstanceOf(Error)
			return
		}
		expect(result.isError, `${name} must reject invalid mutation`).toBe(true)
	}

	beforeEach(() => {
		tools = new Map()
		client = createClient()
		const server = {
			registerTool: (
				name: string,
				config: CapturedTool['config'],
				handler: CapturedTool['handler'],
			) => tools.set(name, { config, handler }),
		}
		registerTools(
			server as unknown as Parameters<typeof registerTools>[0],
			client as unknown as Parameters<typeof registerTools>[1],
		)
	})

	it('exposes get_content hash in structured output and control text despite a long body', async () => {
		client.getContent.mockResolvedValue({ ...record(), markdown: 'Long body '.repeat(20000) })
		const result = await invoke('get_content', { id: recordId })
		expect(JSON.stringify(result.structuredContent)).toContain(currentHash)
		const text = result.content
			.filter((item) => item.type === 'text')
			.map((item) => item.text)
			.join('\n')
		expect(text).toContain(currentHash)
	})

	it.each([
		'update_content',
		'publish_content',
		'submit_for_review',
	])('%s rejects absent and invalid hashes without mutation', async (name) => {
		for (const expectedHash of [
			undefined,
			'',
			'*',
			`sha256:${'A'.repeat(64)}`,
			'sha256:bad',
			42,
			null,
		]) {
			await rejected(name, {
				id: recordId,
				markdown: 'Change',
				...(expectedHash === undefined ? {} : { expectedHash }),
			})
		}
		expect(client.updateContent).not.toHaveBeenCalled()
		expect(client.publishContent).not.toHaveBeenCalled()
		expect(client.submitForReview).not.toHaveBeenCalled()
	})

	it('forwards caller hashes for update, publish and submit without refreshing them', async () => {
		const updated = await invoke('update_content', {
			id: recordId,
			markdown: 'Change',
			expectedHash: currentHash,
		})
		expect(client.updateContent).toHaveBeenCalledWith(
			recordId,
			expect.objectContaining({ expectedHash: currentHash, markdown: 'Change' }),
		)
		expect(JSON.stringify(updated)).toMatch(/sha256:|get_content|re-read/i)
		await invoke('publish_content', { id: recordId, expectedHash: currentHash })
		expect(client.publishContent).toHaveBeenCalledWith(recordId, currentHash)
		await invoke('submit_for_review', { id: recordId, expectedHash: currentHash })
		expect(client.submitForReview).toHaveBeenCalledWith(recordId, currentHash)
		expect(client.getContent).not.toHaveBeenCalled()
	})

	it('delete preview exposes the reviewed hash and confirmation forwards that exact hash', async () => {
		const preview = await invoke('delete_content', { id: recordId })
		expect(JSON.stringify(preview)).toContain(currentHash)
		expect(client.deleteContent).not.toHaveBeenCalled()
		client.getContent.mockClear()
		await rejected('delete_content', { id: recordId, confirm: true })
		expect(client.deleteContent).not.toHaveBeenCalled()
		await invoke('delete_content', {
			id: recordId,
			confirm: true,
			expectedHash: currentHash,
			collectionId,
		})
		expect(client.deleteContent).toHaveBeenCalledWith(recordId, collectionId, currentHash)
		expect(client.getContent).not.toHaveBeenCalled()
	})

	it('requires every bulk hash and forwards hashes and dry-run without replacement', async () => {
		await rejected('bulk_update', { items: [{ id: recordId, markdown: 'Missing' }] })
		expect(client.bulkUpdateContent).not.toHaveBeenCalled()
		const items = [{ id: recordId, markdown: 'Changed', expectedHash: currentHash }]
		await invoke('bulk_update', { items, dryRun: true })
		expect(client.bulkUpdateContent).toHaveBeenCalledWith(
			items,
			expect.objectContaining({ dryRun: true }),
		)
		expect(client.getContent).not.toHaveBeenCalled()
	})

	it.each([
		'CONTENT_CONFLICT',
		'CONTENT_HASH_REQUIRED',
	])('gives read/review guidance for %s and never retries', async (code) => {
		const error = Object.assign(
			new Error(`${code}: content changed; re-read and review before retrying`),
			{
				status: code === 'CONTENT_CONFLICT' ? 409 : 428,
				statusCode: code === 'CONTENT_CONFLICT' ? 409 : 428,
				code,
			},
		)
		client.updateContent.mockRejectedValue(error)
		const result = await invoke('update_content', {
			id: recordId,
			expectedHash: currentHash,
			markdown: 'Change',
		})
		expect(result.isError).toBe(true)
		const text = JSON.stringify(result)
		expect(text).toMatch(/re-read|reread|get_content/i)
		expect(text).not.toMatch(/duplicate.slug|slug.*(?:unique|already|exists)/i)
		expect(client.updateContent).toHaveBeenCalledTimes(1)
		expect(client.getContent).not.toHaveBeenCalled()
	})

	it('does not retry a mutation after a response timeout', async () => {
		client.updateContent.mockRejectedValue(new Error('Response timed out after possible commit'))
		const result = await invoke('update_content', {
			id: recordId,
			expectedHash: currentHash,
			markdown: 'Change',
		})
		expect(result.isError).toBe(true)
		expect(client.updateContent).toHaveBeenCalledTimes(1)
		expect(client.getContent).not.toHaveBeenCalled()
	})
})
