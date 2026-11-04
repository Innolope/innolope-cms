import { InnolopeClient, registerTools } from '@innolope/mcp-server/lib'
import { InnolopeApiError } from '@innolope/sdk'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'

const alpha = { id: '00000000-0000-4000-8000-000000000001', name: 'Alpha project', slug: 'alpha' }
const beta = { id: '00000000-0000-4000-8000-000000000002', name: 'Beta project', slug: 'beta' }
const contentId = '00000000-0000-4000-8000-000000000003'
const otherContentId = '00000000-0000-4000-8000-000000000005'
const collectionId = '00000000-0000-4000-8000-000000000004'
const hash = `sha256:${'a'.repeat(64)}`
const notice = 'Active project restored from your last selection:'
type ToolResult = { isError?: boolean; content: { type: string; text?: string }[] }
type CapturedTool = {
	config: { inputSchema: Record<string, z.ZodType> }
	handler: (args: unknown) => Promise<ToolResult>
}
const deferred = () => {
	let resolve!: () => void
	const promise = new Promise<void>((done) => {
		resolve = done
	})
	return { promise, resolve }
}
const record = (projectId = alpha.id) => ({
	id: contentId,
	collectionId,
	projectId,
	slug: 'article',
	status: 'draft' as const,
	version: 1,
	metadata: { title: 'Article' },
	markdown: 'Body',
	contentHash: hash,
	html: '<p>Body</p>',
	locale: 'en',
	createdAt: '2026-01-01T00:00:00Z',
	updatedAt: '2026-01-01T00:00:00Z',
	publishedAt: null,
})
const resultText = (result: ToolResult) => result.content.map((item) => item.text ?? '').join('\n')

function setup(options: Parameters<typeof registerTools>[2] = {}, selected?: string) {
	const client = new InnolopeClient('https://cms.test', 'test-api-key', selected)
	const tools = new Map<string, CapturedTool>()
	const server = {
		registerTool: (
			name: string,
			config: CapturedTool['config'],
			handler: CapturedTool['handler'],
		) => tools.set(name, { config, handler }),
	}
	vi.spyOn(client, 'trackToolCall').mockImplementation(() => {})
	vi.spyOn(client, 'trackAnalytics').mockImplementation(() => {})
	registerTools(server as unknown as Parameters<typeof registerTools>[0], client, options)
	const invoke = async (name: string, args: Record<string, unknown> = {}) => {
		const tool = tools.get(name)
		if (!tool) throw new Error(`Missing registered tool ${name}`)
		return tool.handler(z.object(tool.config.inputSchema).parse(args))
	}
	return { client, tools, invoke }
}

afterEach(() => {
	vi.restoreAllMocks()
	vi.unstubAllGlobals()
	vi.useRealTimers()
})

describe('MCP project selection acceptance', () => {
	let fixture: ReturnType<typeof setup>
	let persist: ReturnType<typeof vi.fn<(id: string) => Promise<void>>>
	beforeEach(() => {
		persist = vi.fn(async (_id: string) => {})
		fixture = setup({ onProjectSelected: persist })
		vi.spyOn(fixture.client, 'listProjects').mockResolvedValue([alpha, beta])
		vi.spyOn(fixture.client, 'getContent').mockImplementation(async () =>
			record(fixture.client.getProjectId()),
		)
	})

	it('injects optional project into every scoped tool and excludes only explicit account tools', () => {
		const accountTools = new Set([
			'list_projects',
			'use_project',
			'create_project',
			'list_templates',
		])
		expect(fixture.tools.size).toBeGreaterThan(10)
		for (const [name, tool] of fixture.tools) {
			if (accountTools.has(name)) {
				expect(tool.config.inputSchema.project, name).toBeUndefined()
			} else {
				const selector = tool.config.inputSchema.project
				expect(selector, name).toBeDefined()
				expect(selector.safeParse(undefined).success, name).toBe(true)
				expect(selector.safeParse(alpha.slug).success, name).toBe(true)
				expect(selector.safeParse(alpha.id).success, name).toBe(true)
			}
		}
		expect(fixture.tools.get('report_feedback')?.config.inputSchema.project).toBeDefined()
	})

	it.each(
		['', 1, null, {}, []].map((project) => ({ project })),
	)('rejects invalid project selector $project without invoking a handler', async ({ project }) => {
		try {
			const result = await fixture.invoke('get_content', { id: contentId, project })
			expect(result.isError).toBe(true)
		} catch (error) {
			expect(error).toBeInstanceOf(z.ZodError)
		}
		expect(fixture.client.getContent).not.toHaveBeenCalled()
		expect(persist).not.toHaveBeenCalled()
	})

	it.each([
		alpha.slug,
		alpha.id,
	])('resolves %s and adopts it only when no selection exists', async (project) => {
		const result = await fixture.invoke('get_content', { id: contentId, project })
		expect(result.isError, resultText(result)).not.toBe(true)
		expect(fixture.client.getProjectId()).toBe(alpha.id)
		expect(persist).toHaveBeenCalledExactlyOnceWith(alpha.id)
		expect(resultText(result)).toContain(alpha.slug)
	})

	it('unknown project returns valid choices without handler, persistence, or selection effects', async () => {
		fixture.client.setProject(alpha.id)
		const result = await fixture.invoke('get_content', {
			id: contentId,
			project: 'missing-project',
		})
		expect(result.isError).toBe(true)
		for (const project of [alpha, beta]) {
			expect(resultText(result)).toContain(project.slug)
			expect(resultText(result)).toContain(project.id)
		}
		expect(fixture.client.getContent).not.toHaveBeenCalled()
		expect(persist).not.toHaveBeenCalled()
		expect(fixture.client.getProjectId()).toBe(alpha.id)
	})

	it('strips project before forwarding mutation data and leaves an existing selection intact', async () => {
		fixture.client.setProject(alpha.id)
		const update = vi.spyOn(fixture.client, 'updateContent').mockResolvedValue(record(beta.id))
		const result = await fixture.invoke('update_content', {
			id: contentId,
			project: beta.slug,
			markdown: 'Changed',
			expectedHash: hash,
		})
		expect(result.isError, resultText(result)).not.toBe(true)
		expect(update).toHaveBeenCalledTimes(1)
		expect(update.mock.calls[0][1]).toMatchObject({ markdown: 'Changed', expectedHash: hash })
		expect(update.mock.calls[0][1]).not.toHaveProperty('project')
		expect(fixture.client.getProjectId()).toBe(alpha.id)
		expect(persist).not.toHaveBeenCalled()
	})

	it('isolates overlapping tool overrides across await and preserves the first adopted selection', async () => {
		const enteredAlpha = deferred()
		const enteredBeta = deferred()
		const release = deferred()
		const observed: string[] = []
		vi.mocked(fixture.client.getContent).mockImplementation(async () => {
			const before = fixture.client.getProjectId()
			if (before === alpha.id) enteredAlpha.resolve()
			if (before === beta.id) enteredBeta.resolve()
			await release.promise
			expect(fixture.client.getProjectId()).toBe(before)
			observed.push(before ?? 'missing')
			return record(before)
		})
		const first = fixture.invoke('get_content', { id: contentId, project: alpha.slug })
		await enteredAlpha.promise
		const second = fixture.invoke('get_content', { id: contentId, project: beta.slug })
		await enteredBeta.promise
		expect(fixture.client.getProjectId()).toBe(alpha.id)
		release.resolve()
		const results = await Promise.all([first, second])
		expect(results.every((result) => !result.isError)).toBe(true)
		expect(observed.sort()).toEqual([alpha.id, beta.id].sort())
		expect(fixture.client.getProjectId()).toBe(alpha.id)
		expect(persist).toHaveBeenCalledExactlyOnceWith(alpha.id)
	})

	it('persists explicit use_project and create_project selections', async () => {
		const created = { id: contentId, slug: 'new-project', name: 'New project' }
		vi.spyOn(fixture.client, 'createProject').mockResolvedValue(created)
		const use = await fixture.invoke('use_project', { projectId: beta.id })
		expect(use.isError, resultText(use)).not.toBe(true)
		expect(persist).toHaveBeenLastCalledWith(beta.id)
		const create = await fixture.invoke('create_project', {
			name: created.name,
			slug: created.slug,
		})
		expect(create.isError, resultText(create)).not.toBe(true)
		expect(fixture.client.getProjectId()).toBe(created.id)
		expect(persist).toHaveBeenLastCalledWith(created.id)
	})

	it('continues the tool after persistence rejects and never retries the write', async () => {
		persist.mockRejectedValue(new Error('Persistence timed out after possible commit'))
		const result = await fixture.invoke('get_content', { id: contentId, project: alpha.slug })
		expect(result.isError, resultText(result)).not.toBe(true)
		expect(fixture.client.getContent).toHaveBeenCalledTimes(1)
		expect(persist).toHaveBeenCalledTimes(1)
		expect(fixture.client.getProjectId()).toBe(alpha.id)
	})

	it('allows feedback without any active project', async () => {
		const feedback = vi
			.spyOn(fixture.client, 'reportFeedback')
			.mockResolvedValue({ id: contentId, createdAt: new Date().toISOString() })
		const result = await fixture.invoke('report_feedback', {
			type: 'friction',
			summary: 'No selection yet',
		})
		expect(result.isError, resultText(result)).not.toBe(true)
		expect(feedback).toHaveBeenCalledTimes(1)
	})

	it('reports missing selection with per-call project recovery guidance', async () => {
		const list = vi
			.spyOn(fixture.client, 'listCollections')
			.mockRejectedValue(new InnolopeApiError(400, { error: 'Project context required' }))
		const result = await fixture.invoke('list_collections')
		expect(result.isError).toBe(true)
		expect(resultText(result)).toContain('use_project')
		expect(resultText(result)).toMatch(/project.*(?:parameter|argument)|(?:pass|provide).*project/i)
		expect(list).toHaveBeenCalledTimes(1)
		expect(persist).not.toHaveBeenCalled()
	})

	it('turns list failure into an error without retrying or executing the content handler', async () => {
		vi.mocked(fixture.client.listProjects).mockRejectedValue(new Error('Project list timed out'))
		const result = await fixture.invoke('get_content', { id: contentId, project: alpha.slug })
		expect(result.isError).toBe(true)
		expect(fixture.client.listProjects).toHaveBeenCalledTimes(1)
		expect(fixture.client.getContent).not.toHaveBeenCalled()
		expect(persist).not.toHaveBeenCalled()
	})
})

describe('MCP restored selection notice', () => {
	it('suppresses the restored notice when the user explicitly chooses another project first', async () => {
		const fixture = setup({ initialProject: alpha })
		vi.spyOn(fixture.client, 'listProjects').mockResolvedValue([alpha, beta])
		vi.spyOn(fixture.client, 'getContent').mockResolvedValue(record(beta.id))
		const chosen = await fixture.invoke('use_project', { projectId: beta.id })
		expect(chosen.isError, resultText(chosen)).not.toBe(true)
		expect(resultText(chosen)).not.toContain(notice)
		expect(resultText(await fixture.invoke('get_content', { id: contentId }))).not.toContain(notice)
		expect(fixture.client.getProjectId()).toBe(beta.id)
	})

	it('restores the effective selection and prefixes the first result exactly once', async () => {
		const fixture = setup({ initialProject: alpha })
		vi.spyOn(fixture.client, 'listProjects').mockResolvedValue([alpha, beta])
		vi.spyOn(fixture.client, 'getContent').mockResolvedValue(record())
		expect(fixture.client.getProjectId()).toBe(alpha.id)
		const first = await fixture.invoke('get_content', { id: contentId })
		expect(resultText(first)).toMatch(new RegExp(`^${notice}`))
		expect(resultText(first)).toContain(`${alpha.name} (slug: ${alpha.slug}, id: ${alpha.id})`)
		expect(resultText(await fixture.invoke('get_content', { id: contentId }))).not.toContain(notice)
	})

	it('consumes its one notice on an error result too', async () => {
		const fixture = setup({ initialProject: alpha })
		vi.spyOn(fixture.client, 'getContent').mockRejectedValue(new Error('Record not found'))
		const first = await fixture.invoke('get_content', { id: contentId })
		expect(first.isError).toBe(true)
		expect(resultText(first).startsWith(notice)).toBe(true)
		expect(resultText(await fixture.invoke('get_content', { id: contentId }))).not.toContain(notice)
	})

	it('emits exactly one notice across concurrent first calls', async () => {
		const fixture = setup({ initialProject: alpha })
		const release = deferred()
		const bothEntered = deferred()
		let count = 0
		vi.spyOn(fixture.client, 'getContent').mockImplementation(async () => {
			if (++count === 2) bothEntered.resolve()
			await release.promise
			return record()
		})
		const first = fixture.invoke('get_content', { id: contentId })
		const second = fixture.invoke('get_content', { id: contentId })
		await bothEntered.promise
		release.resolve()
		const results = await Promise.all([first, second])
		expect(results.filter((result) => resultText(result).startsWith(notice))).toHaveLength(1)
	})
})

describe('InnolopeClient project context and list cache', () => {
	it('invalidates the project list after creating a project', async () => {
		const fetch = vi
			.fn()
			.mockResolvedValueOnce(Response.json([alpha]))
			.mockResolvedValueOnce(Response.json(beta))
			.mockResolvedValueOnce(Response.json([alpha, beta]))
		vi.stubGlobal('fetch', fetch)
		const client = new InnolopeClient('https://cms.test', 'test-api-key')
		expect(await client.listProjects()).toEqual([alpha])
		expect(await client.createProject({ name: beta.name, slug: beta.slug })).toEqual(beta)
		expect(await client.listProjects()).toEqual([alpha, beta])
		expect(fetch).toHaveBeenCalledTimes(3)
	})

	it('shares an in-flight project list, caches for about 60 seconds, and isolates clients', async () => {
		vi.useFakeTimers()
		vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
		const release = deferred()
		const fetch = vi.fn(async () => {
			await release.promise
			return Response.json([alpha, beta])
		})
		vi.stubGlobal('fetch', fetch)
		const client = new InnolopeClient('https://cms.test', 'test-api-key')
		const requests = [client.listProjects(), client.listProjects()]
		await Promise.resolve()
		expect(fetch).toHaveBeenCalledTimes(1)
		release.resolve()
		expect(await Promise.all(requests)).toEqual([
			[alpha, beta],
			[alpha, beta],
		])
		vi.setSystemTime(new Date('2026-01-01T00:00:59Z'))
		await client.listProjects()
		expect(fetch).toHaveBeenCalledTimes(1)
		await new InnolopeClient('https://cms.test', 'other-key').listProjects()
		expect(fetch).toHaveBeenCalledTimes(2)
		vi.setSystemTime(new Date('2026-01-01T00:01:01Z'))
		await client.listProjects()
		expect(fetch).toHaveBeenCalledTimes(3)
	})

	it('does not retain a rejected list request as a permanently poisoned cache', async () => {
		const fetch = vi
			.fn()
			.mockRejectedValueOnce(new Error('Offline'))
			.mockResolvedValueOnce(Response.json([alpha]))
		vi.stubGlobal('fetch', fetch)
		const client = new InnolopeClient('https://cms.test', 'test-api-key')
		await expect(client.listProjects()).rejects.toThrow()
		expect(fetch).toHaveBeenCalledTimes(1)
		expect(await client.listProjects()).toEqual([alpha])
		expect(fetch).toHaveBeenCalledTimes(2)
	})

	it('restores outer and session context after nested calls and a rejected callback', async () => {
		const client = new InnolopeClient('https://cms.test', 'test-api-key', alpha.id)
		await client.runWithProject(beta.id, async () => {
			expect(client.getProjectId()).toBe(beta.id)
			await expect(
				client.runWithProject(contentId, async () => {
					await Promise.resolve()
					expect(client.getProjectId()).toBe(contentId)
					throw new Error('Callback failure')
				}),
			).rejects.toThrow('Callback failure')
			expect(client.getProjectId()).toBe(beta.id)
		})
		expect(client.getProjectId()).toBe(alpha.id)
	})

	it('keeps headers, project paths, export and feedback in each concurrent call context', async () => {
		const client = new InnolopeClient('https://cms.test', 'test-api-key', contentId)
		const captured: {
			url: string
			project: string | null
			body: Record<string, unknown> | undefined
		}[] = []
		vi.stubGlobal(
			'fetch',
			vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
				captured.push({
					url: String(input),
					project: new Headers(init?.headers).get('X-Project-Id'),
					body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
				})
				return Response.json({
					...record(),
					id: contentId,
					createdAt: '2026-01-01T00:00:00Z',
					data: [],
					pagination: { total: 0, page: 1, limit: 10, totalPages: 0 },
				})
			}),
		)
		const release = deferred()
		const one = client.runWithProject(alpha.id, async () => {
			await release.promise
			await client.getContent(contentId)
			await client.testExternalDatabase({
				type: 'postgresql',
				connectionString: 'postgres://test.invalid/db',
			})
			await client.exportContent()
			await client.reportFeedback({ type: 'friction', summary: alpha.slug })
		})
		const two = client.runWithProject(beta.id, async () => {
			await client.getContent(otherContentId)
			release.resolve()
			await client.testExternalDatabase({
				type: 'postgresql',
				connectionString: 'postgres://test.invalid/db',
			})
			await client.exportContent()
			await client.reportFeedback({ type: 'friction', summary: beta.slug })
		})
		await Promise.all([one, two])
		for (const project of [alpha, beta]) {
			const requests = captured.filter((request) => request.project === project.id)
			expect(requests).toHaveLength(4)
			expect(
				requests.some((request) => request.url.endsWith(`/projects/${project.id}/database/test`)),
			).toBe(true)
			const expectedContentId = project.id === alpha.id ? contentId : otherContentId
			expect(
				requests.some((request) => request.url.endsWith(`/content/${expectedContentId}`)),
			).toBe(true)
			const feedback = requests.find((request) => request.body?.summary === project.slug)
			expect(feedback?.body?.projectId).toBe(project.id)
		}
		expect(client.getProjectId()).toBe(contentId)
	})
})
