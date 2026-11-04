import { randomUUID } from 'node:crypto'
import { request as httpRequest } from 'node:http'
import { createServer } from 'node:net'
import { collections, projectMembers, projects, users } from '@innolope/db'
import { and, eq, inArray, sql } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createOAuthAccessToken } from '../plugins/auth.js'
import { buildTestApp, hasTestDb } from '../test/harness.js'

type RpcResult = { isError?: boolean; content?: { type: string; text?: string }[] }
type Session = { token: string; id: string }

/** A free loopback port, so the MCP loopback client and the test reach the same listener. */
const freePort = () =>
	new Promise<number>((resolve, reject) => {
		const probe = createServer()
		probe.on('error', reject)
		probe.listen(0, '127.0.0.1', () => {
			const address = probe.address()
			probe.close(() =>
				typeof address === 'object' && address
					? resolve(address.port)
					: reject(new Error('no port')),
			)
		})
	})

// Runs on a real listener: the MCP transport force-closes sockets after a response,
// which `app.inject`'s fake sockets don't support (uncaught `destroySoon` errors).
describe.skipIf(!hasTestDb)('MCP durable project selection acceptance (real Postgres)', () => {
	let app: FastifyInstance
	let baseUrl = ''
	const previousInternalUrl = process.env.INTERNAL_API_URL
	const fixtureId = randomUUID()
	const userIds: string[] = []
	const projectIds: string[] = []
	let owner: typeof users.$inferSelect
	let member: typeof users.$inferSelect
	let first: typeof projects.$inferSelect
	let second: typeof projects.$inferSelect
	let third: typeof projects.$inferSelect
	let requestId = 1

	const headers = (token: string, sessionId?: string) => ({
		authorization: `Bearer ${token}`,
		'content-type': 'application/json',
		accept: 'application/json, text/event-stream',
		...(sessionId ? { 'mcp-session-id': sessionId } : {}),
	})
	const tokenFor = (user: typeof users.$inferSelect, clientId: string) =>
		createOAuthAccessToken(
			{ id: user.id, email: user.email, name: user.name, role: user.role },
			{ scope: 'mcp', clientId, audience: `${baseUrl}/mcp` },
		)
	const parseRpc = (body: string) => {
		if (body.trim().startsWith('{')) return JSON.parse(body)
		const messages = body
			.split('\n')
			.filter((line) => line.startsWith('data: '))
			.map((line) => JSON.parse(line.slice(6)))
		const response = messages.find((message) => 'result' in message || 'error' in message)
		expect(response, `Expected JSON-RPC response: ${body}`).toBeDefined()
		return response
	}
	// node:http, not fetch: the MCP SDK's @hono/node-server swaps the global
	// Response class in this process, and fetch responses then read back with no
	// headers (so no mcp-session-id).
	const postMcp = (token: string, payload: unknown, sessionId?: string) =>
		new Promise<{ statusCode: number; sessionId: string; body: string }>((resolve, reject) => {
			const req = httpRequest(
				`${baseUrl}/mcp`,
				{ method: 'POST', headers: headers(token, sessionId) },
				(res) => {
					let body = ''
					res.setEncoding('utf8')
					res.on('data', (chunk) => {
						body += chunk
					})
					res.on('end', () =>
						resolve({
							statusCode: res.statusCode ?? 0,
							sessionId: String(res.headers['mcp-session-id'] ?? ''),
							body,
						}),
					)
					res.on('error', reject)
				},
			)
			req.on('error', reject)
			req.end(JSON.stringify(payload))
		})
	const initialize = async (
		user: typeof users.$inferSelect,
		clientId: string,
	): Promise<Session> => {
		const token = await tokenFor(user, clientId)
		const response = await postMcp(token, {
			jsonrpc: '2.0',
			id: requestId++,
			method: 'initialize',
			params: {
				protocolVersion: '2024-11-05',
				capabilities: {},
				clientInfo: { name: 'selection-acceptance', version: '1.0.0' },
			},
		})
		expect(response.statusCode, response.body).toBe(200)
		expect(parseRpc(response.body).error).toBeUndefined()
		const id = response.sessionId
		expect(id).not.toBe('')
		const initialized = await postMcp(
			token,
			{ jsonrpc: '2.0', method: 'notifications/initialized' },
			id,
		)
		expect(initialized.statusCode).toBe(202)
		return { token, id }
	}
	const call = async (session: Session, name: string, args: Record<string, unknown> = {}) => {
		const response = await postMcp(
			session.token,
			{ jsonrpc: '2.0', id: requestId++, method: 'tools/call', params: { name, arguments: args } },
			session.id,
		)
		expect(response.statusCode, response.body).toBe(200)
		const rpc = parseRpc(response.body)
		expect(rpc.error).toBeUndefined()
		return rpc.result as RpcResult
	}
	const text = (result: RpcResult) =>
		result.content?.map((item) => item.text ?? '').join('\n') ?? ''
	const select = async (session: Session, project: typeof projects.$inferSelect) => {
		const result = await call(session, 'use_project', { projectId: project.id })
		expect(result.isError, text(result)).not.toBe(true)
	}

	beforeAll(async () => {
		// The hosted MCP client calls the REST API over loopback at INTERNAL_API_URL,
		// read when the routes register — point it at the port we listen on.
		const port = await freePort()
		baseUrl = `http://127.0.0.1:${port}`
		process.env.INTERNAL_API_URL = baseUrl
		app = await buildTestApp()
		await app.listen({ port, host: '127.0.0.1' })
		;[owner, member] = await app.db
			.insert(users)
			.values([
				{ email: `mcp-owner-${fixtureId}@test.local`, name: 'Owner', role: 'editor' },
				{ email: `mcp-member-${fixtureId}@test.local`, name: 'Member', role: 'editor' },
			])
			.returning()
		userIds.push(owner.id, member.id)
		;[first, second, third] = await app.db
			.insert(projects)
			.values(
				['First', 'Second', 'Third'].map((name) => ({
					name: `MCP ${name}`,
					slug: `mcp-${name.toLowerCase()}-${fixtureId}`,
					ownerId: owner.id,
				})),
			)
			.returning()
		projectIds.push(first.id, second.id, third.id)
		await app.db.insert(projectMembers).values(
			projectIds.flatMap((projectId) => [
				{ projectId, userId: owner.id, role: 'owner' as const },
				{ projectId, userId: member.id, role: 'editor' as const },
			]),
		)
		await app.db.insert(collections).values(
			[first, second, third].map((project) => ({
				projectId: project.id,
				name: `collection-${project.slug}`,
				label: `Collection ${project.name}`,
				fields: [],
			})),
		)
	})

	afterAll(async () => {
		if (previousInternalUrl === undefined) delete process.env.INTERNAL_API_URL
		else process.env.INTERNAL_API_URL = previousInternalUrl
		if (app && userIds.length) {
			for (const userId of userIds) {
				await app.db.execute(sql`DELETE FROM mcp_project_selections WHERE "userId" = ${userId}`)
			}
			await app.db.delete(projects).where(inArray(projects.id, projectIds))
			await app.db.delete(users).where(inArray(users.id, userIds))
		}
		await app?.close()
	})

	it('restores the same user/client after initialize and emits its notice once', async () => {
		const clientId = `restore-${fixtureId}`
		const original = await initialize(owner, clientId)
		await select(original, second)
		const reconnected = await initialize(owner, clientId)
		expect(reconnected.id).not.toBe(original.id)
		const restored = await call(reconnected, 'list_collections')
		expect(restored.isError, text(restored)).not.toBe(true)
		expect(text(restored)).toContain(
			`Active project restored from your last selection: ${second.name}`,
		)
		expect(text(restored)).toContain(second.slug)
		expect(text(restored)).toContain(`collection-${second.slug}`)
		expect(text(await call(reconnected, 'list_collections'))).not.toContain(
			'Active project restored',
		)
	})

	it('partitions persisted selection by both user and OAuth client', async () => {
		const clientA = `partition-a-${fixtureId}`
		const clientB = `partition-b-${fixtureId}`
		await select(await initialize(owner, clientA), first)
		await select(await initialize(owner, clientB), second)
		await select(await initialize(member, clientA), third)
		for (const [user, clientId, project] of [
			[owner, clientA, first],
			[owner, clientB, second],
			[member, clientA, third],
		] as const) {
			const restored = await call(await initialize(user, clientId), 'list_collections')
			expect(restored.isError, text(restored)).not.toBe(true)
			expect(text(restored)).toContain(`collection-${project.slug}`)
			expect(text(restored)).toContain(
				`Active project restored from your last selection: ${project.name}`,
			)
		}
	})

	it('upserts repeated explicit selections to one durable row', async () => {
		const clientId = `upsert-${fixtureId}`
		const session = await initialize(owner, clientId)
		await select(session, first)
		await select(session, second)
		await Promise.all([select(session, second), select(session, second)])
		const rows = await app.db.execute(
			sql`SELECT "projectId" FROM mcp_project_selections WHERE "userId" = ${owner.id} AND "clientId" = ${clientId}`,
		)
		expect(Array.from(rows)).toEqual([{ projectId: second.id }])
	})

	it('persists first per-call adoption and leaves it unchanged by later overrides', async () => {
		const clientId = `adopt-${fixtureId}`
		const session = await initialize(owner, clientId)
		const adopted = await call(session, 'list_collections', { project: first.slug })
		expect(adopted.isError, text(adopted)).not.toBe(true)
		expect(text(adopted)).toContain(`collection-${first.slug}`)
		const overridden = await call(session, 'list_collections', { project: second.id })
		expect(overridden.isError, text(overridden)).not.toBe(true)
		expect(text(overridden)).toContain(`collection-${second.slug}`)
		const restored = await call(await initialize(owner, clientId), 'list_collections')
		expect(restored.isError, text(restored)).not.toBe(true)
		expect(text(restored)).toContain(
			`Active project restored from your last selection: ${first.name}`,
		)
		expect(text(restored)).toContain(`collection-${first.slug}`)
	})

	it('persists create_project as the next session selection', async () => {
		const clientId = `create-${fixtureId}`
		const session = await initialize(owner, clientId)
		const slug = `created-${fixtureId}`
		const created = await call(session, 'create_project', { name: 'Created selection', slug })
		expect(created.isError, text(created)).not.toBe(true)
		const [project] = await app.db.select().from(projects).where(eq(projects.slug, slug))
		expect(project).toBeDefined()
		projectIds.push(project.id)
		const restored = await call(await initialize(owner, clientId), 'list_projects')
		expect(text(restored)).toContain(
			`Active project restored from your last selection: Created selection (slug: ${slug}, id: ${project.id}).`,
		)
	})

	it('continues after selection storage failure and permits explicit recovery after restore failure', async () => {
		const clientId = `storage-failure-${fixtureId}`
		const session = await initialize(owner, clientId)
		const transaction = vi.spyOn(app.db, 'transaction')
		try {
			transaction.mockRejectedValueOnce(new Error('Injected storage failure'))
			await select(session, first)
			const active = await call(session, 'list_collections')
			expect(active.isError, text(active)).not.toBe(true)
			expect(text(active)).toContain(`collection-${first.slug}`)
			await select(session, second)
			transaction.mockRejectedValueOnce(new Error('Injected restore failure'))
			const reconnected = await initialize(owner, clientId)
			const unbound = await call(reconnected, 'list_collections')
			expect(unbound.isError).toBe(true)
			expect(text(unbound)).not.toContain('Active project restored')
			await select(reconnected, first)
			expect((await call(reconnected, 'list_collections')).isError).not.toBe(true)
		} finally {
			transaction.mockRestore()
		}
	})

	it('does not restore a project after membership is revoked; cache cannot authorize access', async () => {
		const clientId = `revoked-${fixtureId}`
		const old = await initialize(member, clientId)
		await select(old, first)
		await call(old, 'list_collections', { project: first.slug })
		await app.db
			.delete(projectMembers)
			.where(and(eq(projectMembers.userId, member.id), eq(projectMembers.projectId, first.id)))
		try {
			const cached = await call(old, 'list_collections', { project: first.slug })
			expect(cached.isError).toBe(true)
			const reconnected = await initialize(member, clientId)
			const result = await call(reconnected, 'list_collections')
			expect(result.isError).toBe(true)
			expect(text(result)).not.toContain('Active project restored')
			expect(text(result)).not.toContain(`collection-${first.slug}`)
		} finally {
			await app.db
				.insert(projectMembers)
				.values({ projectId: first.id, userId: member.id, role: 'editor' })
		}
	})

	it('skips a deleted persisted project without breaking a new session', async () => {
		const [deleted] = await app.db
			.insert(projects)
			.values({ name: 'Deleted selection', slug: `deleted-${fixtureId}`, ownerId: owner.id })
			.returning()
		projectIds.push(deleted.id)
		await app.db
			.insert(projectMembers)
			.values({ projectId: deleted.id, userId: owner.id, role: 'owner' })
		const clientId = `deleted-${fixtureId}`
		await select(await initialize(owner, clientId), deleted)
		await app.db.delete(projects).where(eq(projects.id, deleted.id))
		const result = await call(await initialize(owner, clientId), 'list_collections')
		expect(result.isError).toBe(true)
		expect(text(result)).not.toContain('Active project restored')
	})
})
