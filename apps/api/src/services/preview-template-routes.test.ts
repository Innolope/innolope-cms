import rateLimit from '@fastify/rate-limit'
import {
	collectionPreviewTemplates,
	collections,
	content,
	type Database,
	projectMemberCollections,
	projectMembers,
	projects,
} from '@innolope/db'
import { getTableName, type SQL } from 'drizzle-orm'
import { PgDialect } from 'drizzle-orm/pg-core'
import Fastify, { type FastifyInstance } from 'fastify'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { projectPlugin } from '../plugins/project.js'
import { collectionPreviewTemplateRoutes } from '../routes/v1/collection-preview-templates.js'

const capture = vi.hoisted(() => vi.fn())
vi.mock('./preview-template.js', async (original) => ({
	...(await original<typeof import('./preview-template.js')>()),
	capturePreviewTemplate: capture,
}))

const PID = '00000000-0000-4000-8000-000000000001'
const CID = '00000000-0000-4000-8000-000000000002'
const FOREIGN = '00000000-0000-4000-8000-000000000003'
const ALLOWED = '00000000-0000-4000-8000-000000000004'
const URL = 'https://example.com/articles/sample/en/'
const path = (id = CID) => `/api/v1/collections/${id}/preview-template`
const headers = (role = 'admin') => ({ authorization: role, 'x-project-id': PID })
const captured = {
	sourceUrl: URL,
	finalUrl: URL,
	html: '<html><body>template</body></html>',
	slots: { body: { selector: '.body', strategy: 'semantic' }, title: null, image: null },
	classMap: {},
	warnings: [],
	stats: { bytes: 46, stylesheets: 0, inlinedFonts: 0 },
	capturedAt: '2026-11-03T12:00:00.000Z',
}

describe('preview route guards and failure isolation (mock database)', () => {
	let app: FastifyInstance
	let tables: Map<string, Array<Record<string, unknown>>>
	let writes: ReturnType<typeof vi.fn>
	let failWrite: boolean
	let failHints: boolean
	const dialect = new PgDialect()
	beforeEach(async () => {
		capture.mockReset().mockResolvedValue(captured)
		writes = vi.fn()
		failWrite = false
		failHints = false
		tables = new Map([
			[getTableName(projects), [{ id: PID, slug: 'test', name: 'Test', settings: {} }]],
			[
				getTableName(projectMembers),
				['admin', 'editor', 'viewer', 'restricted'].map((role) => ({
					id: `membership-${role}`,
					userId: role,
					projectId: PID,
					role: role === 'restricted' ? 'viewer' : role,
				})),
			],
			[
				getTableName(collections),
				[
					{
						id: CID,
						projectId: PID,
						name: 'articles',
						source: 'internal',
						fields: [],
						settings: { publicUrlTemplate: 'https://example.com/articles/{slug}/{locale}/' },
					},
					{
						id: ALLOWED,
						projectId: PID,
						name: 'allowed',
						source: 'internal',
						fields: [],
						settings: {},
					},
					{
						id: FOREIGN,
						projectId: FOREIGN,
						name: 'foreign',
						source: 'internal',
						fields: [],
						settings: {},
					},
				],
			],
			[
				getTableName(projectMemberCollections),
				[{ memberId: 'membership-restricted', collectionId: ALLOWED }],
			],
			[
				getTableName(content),
				[
					{
						id: CID,
						projectId: PID,
						collectionId: CID,
						slug: 'sample',
						locale: 'en',
						metadata: { title: 'Known title' },
						markdown: '**Known** prose [link](https://example.com).',
					},
				],
			],
			[getTableName(collectionPreviewTemplates), []],
		])
		const filter = (table: string, condition?: SQL) => {
			if (failHints && table === getTableName(content)) throw new Error('hint failure')
			const query = condition ? dialect.sqlToQuery(condition) : null
			return (tables.get(table) ?? []).filter(
				(row) =>
					!query ||
					Array.from(query.sql.matchAll(/"[^"]+"\."([^"]+)" = \$(\d+)/g)).every(
						(match) => row[match[1]] === query.params[Number(match[2]) - 1],
					),
			)
		}
		const db = {
			select: () => ({
				from: (table: Parameters<typeof getTableName>[0]) => {
					let condition: SQL | undefined
					let maximum = Number.POSITIVE_INFINITY
					const builder = {
						where: (value: SQL) => {
							condition = value
							return builder
						},
						limit: (value: number) => {
							maximum = value
							return builder
						},
						// biome-ignore lint/suspicious/noThenProperty: Drizzle select builders intentionally support await.
						then: (resolve: (rows: unknown[]) => unknown, reject: (error: unknown) => unknown) =>
							Promise.resolve()
								.then(() => filter(getTableName(table), condition).slice(0, maximum))
								.then(resolve, reject),
					}
					return builder
				},
			}),
			insert: () => ({
				values: (values: Record<string, unknown>) => ({
					onConflictDoUpdate: () => ({
						returning: async () => {
							if (failWrite) throw new Error('private HTML must never reach diagnostics')
							writes(values)
							tables.set(getTableName(collectionPreviewTemplates), [values])
							return [values]
						},
					}),
				}),
			}),
			delete: () => ({
				where: async () => {
					writes('delete')
					tables.set(getTableName(collectionPreviewTemplates), [])
				},
			}),
		}
		app = Fastify()
		app.decorate('db', db as unknown as Database)
		app.decorate('authenticate', async (request, reply) => {
			const role = request.headers.authorization
			if (!role) {
				reply.status(401).send({ error: 'Authentication required' })
				return
			}
			request.user = { id: role, name: role, email: `${role}@example.com`, role: 'editor' }
		})
		await app.register(rateLimit, { max: 200, timeWindow: '1 minute' })
		await app.register(projectPlugin)
		await app.register(collectionPreviewTemplateRoutes, { prefix: '/api/v1/collections' })
		await app.ready()
	})
	afterEach(async () => {
		await app.close()
	})
	it('enforces real project-role prehandlers before capture or writes', async () => {
		expect((await app.inject({ url: path() })).statusCode).toBe(401)
		for (const role of ['viewer', 'editor']) {
			expect((await app.inject({ url: path(), headers: headers(role) })).statusCode).toBe(200)
			for (const method of ['POST', 'DELETE'] as const) {
				expect(
					(
						await app.inject({
							method,
							url: path(),
							headers: headers(role),
							...(method === 'POST' ? { payload: { url: URL } } : {}),
						})
					).statusCode,
				).toBe(403)
			}
		}
		expect(capture).not.toHaveBeenCalled()
		expect(writes).not.toHaveBeenCalled()
	})
	it('checks tenant ownership and real collection allowlists before exposing templates', async () => {
		for (const method of ['GET', 'POST', 'DELETE'] as const) {
			expect(
				(
					await app.inject({
						method,
						url: path(FOREIGN),
						headers: headers(),
						...(method === 'POST' ? { payload: { url: URL } } : {}),
					})
				).statusCode,
			).toBe(404)
		}
		expect((await app.inject({ url: path(), headers: headers('restricted') })).statusCode).toBe(403)
		expect(
			(await app.inject({ url: path(ALLOWED), headers: headers('restricted') })).statusCode,
		).toBe(200)
		expect(capture).not.toHaveBeenCalled()
		expect(writes).not.toHaveBeenCalled()
	})
	it('saves/replaces/deletes the complete result and resolves normalized record hints', async () => {
		const first = await app.inject({
			method: 'POST',
			url: path(),
			headers: headers(),
			payload: { url: URL },
		})
		expect(first.statusCode).toBe(200)
		expect(capture).toHaveBeenCalledWith(URL, {
			selectors: undefined,
			hints: { title: 'Known title', bodyText: 'Known prose link.' },
			// No Browser Run token in the test environment.
			render: null,
		})
		expect(first.json().template).toMatchObject({ ...captured, collectionId: CID, selectors: null })
		expect(first.json().template.capturedBy).toBeUndefined()
		capture.mockResolvedValue({ ...captured, html: '<html>replacement</html>' })
		expect(
			(await app.inject({ method: 'POST', url: path(), headers: headers(), payload: { url: URL } }))
				.statusCode,
		).toBe(200)
		expect(
			(await app.inject({ url: path(), headers: headers('viewer') })).json().template.html,
		).toContain('replacement')
		expect(
			(await app.inject({ method: 'DELETE', url: path(), headers: headers() })).statusCode,
		).toBe(204)
		expect((await app.inject({ url: path(), headers: headers('editor') })).json()).toEqual({
			template: null,
		})
	})
	it('keeps prior state after a capture error, reports public code and sanitizes failure logs', async () => {
		const { PreviewCaptureError } = await import('./preview-template.js')
		const warn = vi.spyOn(app.log, 'warn')
		capture.mockRejectedValue(new PreviewCaptureError('FETCH_FAILED'))
		const result = await app.inject({
			method: 'POST',
			url: path(),
			headers: headers(),
			payload: { url: 'https://user:secret@example.com/path?token=secret' },
		})
		expect(result.statusCode).toBe(502)
		expect(result.json().code).toBe('FETCH_FAILED')
		expect(writes).not.toHaveBeenCalled()
		expect(warn).toHaveBeenCalledWith(
			{ code: 'FETCH_FAILED', host: 'example.com' },
			'Preview capture failed',
		)
		expect(JSON.stringify(warn.mock.calls)).not.toContain('secret')
	})
	it('treats failed hints as optional and returns a sanitized persistence failure', async () => {
		failHints = true
		failWrite = true
		const warn = vi.spyOn(app.log, 'warn')
		const result = await app.inject({
			method: 'POST',
			url: path(),
			headers: headers(),
			payload: { url: URL },
		})
		expect(capture).toHaveBeenCalledWith(URL, {
			hints: undefined,
			selectors: undefined,
			render: null,
		})
		expect(result.statusCode).toBe(500)
		expect(result.body).not.toContain('private HTML')
		expect(warn).toHaveBeenCalledWith(
			{ code: 'PERSIST_FAILED', host: 'example.com' },
			'Preview capture failed',
		)
	})
	it('validates route input and enforces ten captures per minute', async () => {
		expect(
			(
				await app.inject({
					method: 'POST',
					url: path(),
					headers: headers(),
					payload: { url: URL, selectors: { body: 42 } },
				})
			).statusCode,
		).toBe(400)
		expect(capture).not.toHaveBeenCalled()
		for (let i = 0; i < 9; i++)
			expect(
				(
					await app.inject({
						method: 'POST',
						url: path(),
						headers: headers(),
						payload: { url: URL },
					})
				).statusCode,
			).toBe(200)
		expect(
			(await app.inject({ method: 'POST', url: path(), headers: headers(), payload: { url: URL } }))
				.statusCode,
		).toBe(429)
		expect(capture).toHaveBeenCalledTimes(9)
	})
	describe('with a Browser Run token configured', () => {
		const TOKEN = 'browser-run-token-must-not-leak'
		// Set before the outer beforeEach builds the app: the route reads the env once.
		beforeAll(() => {
			vi.stubEnv('CLOUDFLARE_BROWSER_RUN_API_TOKEN', TOKEN)
			vi.stubEnv('CLOUDFLARE_BROWSER_RUN_ACCOUNT_ID', 'acct')
		})
		afterAll(() => {
			vi.unstubAllEnvs()
		})
		afterEach(() => {
			vi.unstubAllGlobals()
		})

		it.each([
			[
				'logs the host, status and browser time of a page it loads',
				new Response(
					JSON.stringify({ success: true, result: '<html></html>', meta: { status: 200 } }),
					{
						headers: { 'content-type': 'application/json', 'x-browser-ms-used': '4200' },
					},
				),
				'info',
				{ host: 'example.com', status: 200, browserMs: 4200 },
			],
			[
				'logs why loading failed when the token is refused',
				new Response(JSON.stringify({ success: false }), { status: 403 }),
				'warn',
				{ host: 'example.com', reason: 'unavailable' },
			],
		] as const)('passes the capture a browser renderer that %s', async (_label, reply, level, logged) => {
			const fetchMock = vi.fn(async () => reply)
			vi.stubGlobal('fetch', fetchMock)
			const log = vi.spyOn(app.log, level)
			capture.mockImplementation(async (url: string, options: { render?: unknown }) => {
				expect(typeof options.render).toBe('function')
				const render = options.render as (u: string, s: AbortSignal) => Promise<unknown>
				await render(url, new AbortController().signal).catch(() => {})
				return captured
			})
			await app.inject({ method: 'POST', url: path(), headers: headers(), payload: { url: URL } })
			expect(fetchMock).toHaveBeenCalledOnce()
			expect(log).toHaveBeenCalledWith(logged, expect.any(String))
			// Only the renderer's own lines: Fastify's request log isn't this route's doing.
			const logs = JSON.stringify(
				log.mock.calls.filter(([, message]) => /browser/i.test(String(message))),
			)
			expect(logs).not.toContain(TOKEN)
			expect(logs).not.toContain('/articles/sample')
		})
	})
})
