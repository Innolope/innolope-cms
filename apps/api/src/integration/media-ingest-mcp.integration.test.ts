import { randomUUID } from 'node:crypto'
import { createServer as createHttpServer, request as httpRequest, type Server } from 'node:http'
import { createServer as createPortProbe } from 'node:net'
import { collections, projectMembers, projects, users } from '@innolope/db'
import { inArray, sql } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createOAuthAccessToken } from '../plugins/auth.js'
import { buildTestApp, hasTestDb } from '../test/harness.js'

const png = Buffer.from(
	'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/aV8AAAAASUVORK5CYII=',
	'base64',
)

// Only test source URLs are intercepted; the guard's other exports stay real.
vi.mock('../adapters/connection-guard.js', async (importOriginal) => ({
	...(await importOriginal<typeof import('../adapters/connection-guard.js')>()),
	safeFetch: (url: string, init?: RequestInit) => fetch(url, init),
}))

const freePort = () =>
	new Promise<number>((resolve, reject) => {
		const server = createPortProbe()
		server.on('error', reject)
		server.listen(0, '127.0.0.1', () => {
			const address = server.address()
			server.close(() =>
				typeof address === 'object' && address
					? resolve(address.port)
					: reject(new Error('No port')),
			)
		})
	})

describe.skipIf(!hasTestDb)('six-image MCP acceptance (real Postgres)', { timeout: 60_000 }, () => {
	let app: FastifyInstance
	let baseUrl: string
	let sourceUrl: string
	let sourceServer: Server | undefined
	const sourceRequests: number[] = []
	let token: string
	let userId: string
	let projectId: string
	let collectionId: string
	let sessionId: string
	let requestId = 1
	const previousInternal = process.env.INTERNAL_API_URL
	const originalFetch = globalThis.fetch
	const clientId = `media-acceptance-${randomUUID()}`

	const rpc = (payload: unknown, session?: string) =>
		new Promise<{ body: string; session: string; status: number }>((resolve, reject) => {
			const req = httpRequest(
				`${baseUrl}/mcp`,
				{
					method: 'POST',
					headers: {
						authorization: `Bearer ${token}`,
						'content-type': 'application/json',
						accept: 'application/json, text/event-stream',
						...(session ? { 'mcp-session-id': session } : {}),
					},
				},
				(res) => {
					let body = ''
					res.setEncoding('utf8')
					res.on('data', (chunk) => {
						body += chunk
					})
					res.on('end', () =>
						resolve({
							body,
							session: String(res.headers['mcp-session-id'] ?? ''),
							status: res.statusCode ?? 0,
						}),
					)
					res.on('error', reject)
				},
			)
			req.on('error', reject)
			req.end(JSON.stringify(payload))
		})
	const parse = (body: string) => {
		if (body.trim().startsWith('{')) return JSON.parse(body)
		return body
			.split('\n')
			.filter((line) => line.startsWith('data: '))
			.map((line) => JSON.parse(line.slice(6)))
			.find((message) => 'result' in message || 'error' in message)
	}
	const call = async (name: string, args: Record<string, unknown>) => {
		const response = await rpc(
			{ jsonrpc: '2.0', id: requestId++, method: 'tools/call', params: { name, arguments: args } },
			sessionId,
		)
		expect(response.status, response.body).toBe(200)
		const parsed = parse(response.body)
		expect(parsed.error, response.body).toBeUndefined()
		return parsed.result as {
			isError?: boolean
			structuredContent?: unknown
			content?: Array<{ text?: string }>
		}
	}
	const text = (result: { content?: Array<{ text?: string }> }) =>
		result.content?.map((part) => part.text ?? '').join('\n') ?? ''

	beforeAll(async () => {
		sourceServer = createHttpServer((req, res) => {
			const image = Number(req.url?.slice(1))
			if (!Number.isInteger(image) || image < 1 || image > 6) {
				res.writeHead(404).end()
				return
			}
			sourceRequests.push(image)
			const bytes = Buffer.concat([png, Buffer.from([image])])
			res.writeHead(200, { 'content-type': 'image/png', 'content-length': bytes.length })
			res.end(bytes)
		})
		await new Promise<void>((resolve, reject) => {
			sourceServer?.once('error', reject)
			sourceServer?.listen(0, '127.0.0.1', resolve)
		})
		const sourceAddress = sourceServer.address()
		if (!sourceAddress || typeof sourceAddress === 'string') throw new Error('No source port')
		sourceUrl = `http://127.0.0.1:${sourceAddress.port}`
		const port = await freePort()
		baseUrl = `http://127.0.0.1:${port}`
		process.env.INTERNAL_API_URL = baseUrl
		app = await buildTestApp()
		await app.listen({ port, host: '127.0.0.1' })
		const short = randomUUID().slice(0, 8)
		const [user] = await app.db
			.insert(users)
			.values({ email: `mcp-media-${short}@test.local`, name: 'Owner', role: 'editor' })
			.returning()
		userId = user.id
		const [project] = await app.db
			.insert(projects)
			.values({ name: 'MCP media', slug: `mcp-media-${short}`, ownerId: userId })
			.returning()
		projectId = project.id
		await app.db.insert(projectMembers).values({ projectId, userId, role: 'owner' })
		const [collection] = await app.db
			.insert(collections)
			.values({
				projectId,
				name: 'articles',
				label: 'Articles',
				fields: [{ name: 'title', type: 'text' }],
			})
			.returning()
		collectionId = collection.id
		token = await createOAuthAccessToken(
			{ id: user.id, email: user.email, name: user.name, role: user.role },
			{ scope: 'mcp', clientId, audience: `${baseUrl}/mcp` },
		)
		vi.stubGlobal(
			'fetch',
			vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
				const url = String(input instanceof Request ? input.url : input)
				if (url.startsWith('https://api.cloudflare.com/')) {
					const id = randomUUID()
					return Response.json({
						success: true,
						result: {
							id,
							filename: 'picture.png',
							variants: [`https://imagedelivery.net/test-hash/${id}/public`],
						},
						errors: [],
					})
				}
				if (url.startsWith('https://imagedelivery.net/')) return new Response(null, { status: 200 })
				return originalFetch(input, init)
			}),
		)
		const initialized = await rpc({
			jsonrpc: '2.0',
			id: requestId++,
			method: 'initialize',
			params: {
				protocolVersion: '2024-11-05',
				capabilities: {},
				clientInfo: { name: 'media-acceptance', version: '1.0.0' },
			},
		})
		expect(initialized.status, initialized.body).toBe(200)
		sessionId = initialized.session
		expect(sessionId).not.toBe('')
		const notification = await rpc(
			{ jsonrpc: '2.0', method: 'notifications/initialized' },
			sessionId,
		)
		expect(notification.status).toBe(202)
		const selected = await call('use_project', { projectId })
		expect(selected.isError, text(selected)).not.toBe(true)
	})

	afterAll(async () => {
		vi.unstubAllGlobals()
		if (previousInternal === undefined) delete process.env.INTERNAL_API_URL
		else process.env.INTERNAL_API_URL = previousInternal
		if (userId) {
			await app.db.execute(sql`DELETE FROM mcp_project_selections WHERE "userId" = ${userId}`)
			await app.db.delete(projects).where(inArray(projects.id, [projectId]))
			await app.db.delete(users).where(inArray(users.id, [userId]))
		}
		await app?.close()
		if (sourceServer?.listening)
			await new Promise<void>((resolve, reject) =>
				sourceServer?.close((error) => (error ? reject(error) : resolve())),
			)
	})

	it('uploads six source images, creates a draft, and checks all six (F14)', async () => {
		const items = Array.from({ length: 6 }, (_, i) => ({
			sourceUrl: `${sourceUrl}/${i + 1}`,
			alt: `Chart ${i + 1}`,
		}))
		const uploaded = await call('upload_media', { items })
		expect(uploaded.isError, text(uploaded)).not.toBe(true)
		expect(uploaded.structuredContent).toBeDefined()
		const output = `${text(uploaded)}\n${JSON.stringify(uploaded.structuredContent)}`
		const urls = [
			...new Set(
				output.match(/https:\/\/imagedelivery\.net\/test-hash\/[a-zA-Z0-9-]+\/public/g) ?? [],
			),
		]
		expect(urls).toHaveLength(6)
		expect([...sourceRequests].sort()).toEqual([1, 2, 3, 4, 5, 6])
		for (const item of items) expect(output).toContain(item.alt)
		const markdown = urls.map((url, i) => `![Chart ${i + 1}](${url})`).join('\n\n')
		const created = await call('create_content', {
			collectionId,
			slug: 'six-charts',
			metadata: { title: 'Six charts' },
			markdown,
			status: 'draft',
		})
		expect(created.isError, text(created)).not.toBe(true)
		const createdText = `${text(created)}\n${JSON.stringify(created.structuredContent)}`
		const structured = created.structuredContent as
			| { id?: string; data?: { id?: string } }
			| undefined
		const id =
			structured?.id ??
			structured?.data?.id ??
			// "ID: <uuid>" — the project id echoed earlier in the text is also a UUID.
			createdText.match(
				/\bID: ([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i,
			)?.[1]
		expect(id).toBeTruthy()
		const checked = await call('check_media', { id })
		expect(checked.isError, text(checked)).not.toBe(true)
		const checkOutput = `${text(checked)}\n${JSON.stringify(checked.structuredContent)}`
		for (const url of urls) expect(checkOutput).toContain(url)
		expect(checkOutput).toContain('All 6 image(s) serve correctly.')
		expect(checkOutput.match(/library: yes/g)).toHaveLength(6)
		expect(checkOutput).not.toMatch(/external or deleted|BROKEN/)
	})
})
