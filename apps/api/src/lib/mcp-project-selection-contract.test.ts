import { InnolopeClient, registerTools } from '@innolope/mcp-server/lib'
import { InnolopeApiError } from '@innolope/sdk'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'

// Spec-only acceptance: assertions were authored without reading production code.
const alpha = {
	id: '00000000-0000-4000-8000-000000000011',
	name: 'Alpha project',
	slug: 'alpha',
}
const beta = {
	id: '00000000-0000-4000-8000-000000000012',
	name: 'Beta project',
	slug: 'beta',
}
const projects = [alpha, beta]
type ToolResult = {
	isError?: boolean
	content: { type: string; text?: string }[]
}
type CapturedTool = {
	config: { inputSchema: Record<string, z.ZodType> }
	handler: (args: unknown) => Promise<ToolResult>
}
const deferred = <T>() => {
	let resolve!: (value: T) => void
	const promise = new Promise<T>((done) => {
		resolve = done
	})
	return { promise, resolve }
}
const resultText = (result: ToolResult) =>
	result.content
		.filter((item) => item.type === 'text')
		.map((item) => item.text ?? '')
		.join('\n')
const restoredNotice = `Active project restored from your last selection: ${alpha.name} (slug: ${alpha.slug}, id: ${alpha.id}). If this conversation is about another project, call use_project or pass \`project\`.`

function harness(options: Parameters<typeof registerTools>[2] = {}, active?: string) {
	const client = new InnolopeClient('https://mcp-contract.invalid', 'contract-test-key', active)
	const tools = new Map<string, CapturedTool>()
	const server = {
		registerTool: (
			name: string,
			config: CapturedTool['config'],
			handler: CapturedTool['handler'],
		) => tools.set(name, { config, handler }),
	}
	registerTools(server as unknown as Parameters<typeof registerTools>[0], client, options)
	return {
		client,
		async invoke(name: string, args: Record<string, unknown> = {}) {
			const tool = tools.get(name)
			if (!tool) throw new Error(`Missing registered tool: ${name}`)
			return tool.handler(z.object(tool.config.inputSchema).parse(args))
		},
	}
}

afterEach(() => {
	vi.restoreAllMocks()
	vi.unstubAllGlobals()
	vi.useRealTimers()
})

describe('MCP project selection independent failure contracts', () => {
	it('A2: an exact project UUID takes precedence over another project slug with that value', async () => {
		const { client, invoke } = harness({}, alpha.id)
		vi.spyOn(client, 'listProjects').mockResolvedValue([{ ...alpha, slug: beta.id }, beta])
		const observed: (string | undefined)[] = []
		vi.spyOn(client, 'listCollections').mockImplementation(async () => {
			observed.push(client.getProjectId())
			return []
		})
		const result = await invoke('list_collections', { project: beta.id })
		expect(result.isError).not.toBe(true)
		expect(observed).toEqual([beta.id])
		expect(client.getProjectId()).toBe(alpha.id)
	})

	it('A3/A4: delayed single-project recovery cannot replace a newer explicit selection', async () => {
		const { client, invoke } = harness()
		const lookupStarted = deferred<void>()
		const lookup = deferred<typeof projects>()
		vi.spyOn(client, 'listProjects').mockImplementationOnce(() => {
			lookupStarted.resolve()
			return lookup.promise
		})
		vi.spyOn(client, 'listCollections')
			.mockRejectedValueOnce(new InnolopeApiError(400, { error: 'Project context required' }))
			.mockResolvedValue([])
		const recovery = invoke('list_collections')
		await lookupStarted.promise
		client.setProject(beta.id)
		lookup.resolve([alpha])
		await recovery
		expect(client.getProjectId()).toBe(beta.id)
	})

	it('A2/A5: a failed project lookup can recover on the next tool call', async () => {
		const { client, invoke } = harness()
		const lookup = vi
			.spyOn(client, 'listProjects')
			.mockRejectedValueOnce(new Error('Temporary project lookup outage'))
			.mockResolvedValue(projects)
		const handler = vi.spyOn(client, 'listCollections').mockResolvedValue([])
		const failed = await invoke('list_collections', { project: alpha.slug })
		expect(failed.isError).toBe(true)
		expect(handler).not.toHaveBeenCalled()
		expect(client.getProjectId()).toBeUndefined()
		const recovered = await invoke('list_collections', { project: alpha.slug })
		expect(recovered.isError).not.toBe(true)
		expect(lookup).toHaveBeenCalledTimes(2)
		expect(handler).toHaveBeenCalledTimes(1)
		expect(client.getProjectId()).toBe(alpha.id)
	})

	it('A2: project cache is client-local and expires after about sixty seconds', async () => {
		vi.useFakeTimers()
		const lookupRequests: string[] = []
		vi.stubGlobal(
			'fetch',
			vi.fn(async (input: string | URL | Request) => {
				const url = input instanceof Request ? input.url : String(input)
				if (new URL(url).pathname === '/api/v1/projects') lookupRequests.push(url)
				return new Response(JSON.stringify(projects), {
					status: 200,
					headers: { 'content-type': 'application/json' },
				})
			}),
		)
		const first = harness({}, beta.id)
		const second = harness({}, beta.id)
		vi.spyOn(first.client, 'listCollections').mockResolvedValue([])
		vi.spyOn(second.client, 'listCollections').mockResolvedValue([])
		expect((await first.invoke('list_collections', { project: alpha.slug })).isError).not.toBe(true)
		expect(lookupRequests).toHaveLength(1)
		vi.advanceTimersByTime(30_000)
		await first.invoke('list_collections', { project: beta.slug })
		expect(lookupRequests).toHaveLength(1)
		await second.invoke('list_collections', { project: alpha.slug })
		expect(lookupRequests).toHaveLength(2)
		vi.advanceTimersByTime(31_000)
		await first.invoke('list_collections', { project: alpha.slug })
		expect(lookupRequests).toHaveLength(3)
	})

	it('A3/A4: delayed override resolution cannot replace a selection made while it waited', async () => {
		const onProjectSelected = vi.fn(async () => {})
		const { client, invoke } = harness({ onProjectSelected })
		const lookupStarted = deferred<void>()
		const lookup = deferred<typeof projects>()
		vi.spyOn(client, 'listProjects')
			.mockImplementationOnce(() => {
				lookupStarted.resolve()
				return lookup.promise
			})
			.mockResolvedValue(projects)
		const observed: (string | undefined)[] = []
		vi.spyOn(client, 'listCollections').mockImplementation(async () => {
			observed.push(client.getProjectId())
			return []
		})
		const pending = invoke('list_collections', { project: alpha.slug })
		await lookupStarted.promise
		// This is the public session selection operation while resolution is suspended.
		client.setProject(beta.id)
		lookup.resolve(projects)
		expect((await pending).isError).not.toBe(true)
		expect(observed).toEqual([alpha.id])
		expect(client.getProjectId()).toBe(beta.id)
		expect(onProjectSelected).not.toHaveBeenCalled()
	})

	it('A3/A4: two first-call overrides stay isolated and persist only the adopted selection', async () => {
		const onProjectSelected = vi.fn(async () => {})
		const { client, invoke } = harness({ onProjectSelected })
		vi.spyOn(client, 'listProjects').mockResolvedValue(projects)
		const bothEntered = deferred<void>()
		const release = deferred<void>()
		const before: (string | undefined)[] = []
		const after: (string | undefined)[] = []
		vi.spyOn(client, 'listCollections').mockImplementation(async () => {
			before.push(client.getProjectId())
			if (before.length === 2) bothEntered.resolve()
			await release.promise
			after.push(client.getProjectId())
			return []
		})
		const calls = [
			invoke('list_collections', { project: alpha.slug }),
			invoke('list_collections', { project: beta.slug }),
		]
		await bothEntered.promise
		expect(new Set(before)).toEqual(new Set([alpha.id, beta.id]))
		release.resolve()
		const results = await Promise.all(calls)
		expect(results.every((result) => !result.isError)).toBe(true)
		expect(after).toEqual(before)
		expect(projects.map((project) => project.id)).toContain(client.getProjectId())
		expect(onProjectSelected).toHaveBeenCalledTimes(1)
		expect(onProjectSelected).toHaveBeenCalledWith(client.getProjectId())
	})

	it('A4: failed selection persistence cannot fail use_project or erase its active selection', async () => {
		const onProjectSelected = vi.fn(async () => {
			throw new Error('Selection storage unavailable')
		})
		const { client, invoke } = harness({ onProjectSelected })
		vi.spyOn(client, 'listProjects').mockResolvedValue(projects)
		vi.spyOn(client, 'listCollections').mockResolvedValue([])
		const selected = await invoke('use_project', { projectId: alpha.id })
		expect(selected.isError).not.toBe(true)
		expect(client.getProjectId()).toBe(alpha.id)
		expect(onProjectSelected).toHaveBeenCalledExactlyOnceWith(alpha.id)
		expect((await invoke('list_collections')).isError).not.toBe(true)
		expect(onProjectSelected).toHaveBeenCalledTimes(1)
	})

	it('A4: failed persistence of first override adoption cannot fail the scoped handler', async () => {
		const onProjectSelected = vi.fn(async () => {
			throw new Error('Selection storage unavailable')
		})
		const { client, invoke } = harness({ onProjectSelected })
		vi.spyOn(client, 'listProjects').mockResolvedValue(projects)
		const handler = vi.spyOn(client, 'listCollections').mockResolvedValue([])
		expect((await invoke('list_collections', { project: alpha.slug })).isError).not.toBe(true)
		expect(handler).toHaveBeenCalledTimes(1)
		expect(client.getProjectId()).toBe(alpha.id)
		expect(onProjectSelected).toHaveBeenCalledExactlyOnceWith(alpha.id)
	})

	it('A5: a failed first result still carries the full restored notice exactly once', async () => {
		const { client, invoke } = harness({ initialProject: alpha }, alpha.id)
		vi.spyOn(client, 'listCollections')
			.mockRejectedValueOnce(new Error('Temporary upstream outage'))
			.mockResolvedValue([])
		const first = await invoke('list_collections')
		expect(first.isError).toBe(true)
		expect(resultText(first).startsWith(restoredNotice)).toBe(true)
		const second = await invoke('list_collections')
		expect(second.isError).not.toBe(true)
		expect(resultText(second)).not.toContain('Active project restored from your last selection:')
	})

	it('A5: concurrent first results emit exactly one restored notice', async () => {
		const { client, invoke } = harness({ initialProject: alpha }, alpha.id)
		const slowEntered = deferred<void>()
		const releaseSlow = deferred<void>()
		vi.spyOn(client, 'listCollections')
			.mockImplementationOnce(async () => {
				slowEntered.resolve()
				await releaseSlow.promise
				return []
			})
			.mockResolvedValue([])
		const slow = invoke('list_collections')
		await slowEntered.promise
		const fast = await invoke('list_collections')
		expect(resultText(fast).startsWith(restoredNotice)).toBe(true)
		releaseSlow.resolve()
		const late = await slow
		expect(resultText(late)).not.toContain('Active project restored from your last selection:')
	})

	it('A6: membership denial after cached resolution remains a failed call without retry', async () => {
		const onProjectSelected = vi.fn(async () => {})
		const { client, invoke } = harness({ onProjectSelected }, beta.id)
		vi.spyOn(client, 'listProjects').mockResolvedValue(projects)
		const denied = Object.assign(new Error('Forbidden: project membership revoked'), {
			status: 403,
			statusCode: 403,
		})
		const handler = vi.spyOn(client, 'listCollections').mockRejectedValue(denied)
		const result = await invoke('list_collections', { project: alpha.slug })
		expect(result.isError).toBe(true)
		expect(handler).toHaveBeenCalledTimes(1)
		expect(client.getProjectId()).toBe(beta.id)
		expect(onProjectSelected).not.toHaveBeenCalled()
	})
})
