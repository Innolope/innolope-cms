import { randomUUID } from 'node:crypto'
import { apiKeys, content, projectMembers, projects, users } from '@innolope/db'
import { eq, type SQL, sql } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createJwt, hashApiKey } from '../plugins/auth.js'
import { buildTestApp, hasTestDb } from '../test/harness.js'

// Outbound hosts the guard should refuse (hostname only). Everything else resolves "public".
const guard = vi.hoisted(() => ({ blockedHosts: new Set<string>() }))

// Keep the real module (the rest of the app imports other helpers from it) but never touch DNS
// or the network: validatePublicUrl answers "fine" unless a test blocked the host, and safeFetch
// hands the request straight to the stubbed global fetch.
vi.mock('../adapters/connection-guard.js', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../adapters/connection-guard.js')>()
	return {
		...actual,
		validatePublicUrl: async (rawUrl: string) => {
			try {
				return guard.blockedHosts.has(new URL(rawUrl).hostname)
					? 'URL resolves to a private address'
					: null
			} catch {
				return null
			}
		},
		safeFetch: (url: string, init?: RequestInit) => fetch(url, init),
	}
})

const ENDPOINT = 'https://api.indexnow.org/indexnow'
const MINUTE = 60_000
const HOUR = 60 * MINUTE

type Reply = { status?: number; headers?: Record<string, string>; body?: string; throws?: string }
type Post = {
	headers: Headers
	body: { host: string; key: string; keyLocation: string; urlList: string[] }
}

/** What the stubbed network serves and records. Reset before every test. */
const world = {
	keyFile: 'ok' as 'ok' | '404' | 'wrong',
	/** Consumed one per IndexNow POST, in order; an empty queue answers 200. */
	replies: [] as Reply[],
	posts: [] as Post[],
	keyGets: [] as string[],
	/** 'KEY' / 'POST' in the order the worker made the requests. */
	order: [] as string[],
}

function resetWorld() {
	world.keyFile = 'ok'
	world.replies = []
	world.posts = []
	world.keyGets = []
	world.order = []
}

const fetchStub = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
	const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
	const method = (init?.method ?? 'GET').toUpperCase()
	if (method === 'POST' && url === ENDPOINT) {
		world.order.push('POST')
		world.posts.push({
			headers: new Headers(init?.headers),
			body: JSON.parse(String(init?.body)),
		})
		const reply = world.replies.shift() ?? {}
		if (reply.throws) throw new Error(reply.throws)
		return new Response(reply.body ?? '', { status: reply.status ?? 200, headers: reply.headers })
	}
	if (method === 'GET' && new URL(url).pathname.endsWith('.txt')) {
		world.order.push('KEY')
		world.keyGets.push(url)
		if (world.keyFile === '404') return new Response('Not found', { status: 404 })
		// A key file is named after its key, so serving "<key>" for ".../<key>.txt" is the
		// correct file for whichever key the project currently holds.
		const stem =
			new URL(url).pathname
				.split('/')
				.pop()
				?.replace(/\.txt$/, '') ?? ''
		return new Response(world.keyFile === 'wrong' ? 'not-the-key' : stem, { status: 200 })
	}
	return new Response('', { status: 404 })
})

interface Site {
	projectId: string
	userId: string
	host: string
	/** The template the news collection was created with, null for none. */
	template: string | null
	collectionId: string
	token: string
	headers: Record<string, string>
	/** Distinct client address per site: the app rate-limits to 200 requests/minute per IP. */
	ip: string
	/** The project's IndexNow key once IndexNow was enabled. */
	key: string
}

interface IndexNowStatus {
	settings: { enabled: boolean; key: string | null; keyLocation: string | null }
	keyFiles: Array<{ host: string; url: string; path: string }>
	collections: Array<{
		id: string
		name: string
		label: string
		publicUrlTemplate: string
		pending: number
		waiting: number
		lastSubmission: null | {
			status: string
			statusCode: number | null
			message: string
			urlCount: number
			trigger: string
			createdAt: string
		}
	}>
	recent: Array<{
		id: string
		collectionId: string
		host: string
		urlCount: number
		sampleUrls: string[]
		status: string
		statusCode: number | null
		message: string
		trigger: string
		createdAt: string
	}>
}

type QueueRow = {
	url: string
	attempts: number
	nextAttemptMs: number
	lastError: string | null
	reason: string
}

describe.skipIf(!hasTestDb)('IndexNow (real Postgres)', () => {
	vi.setConfig({ testTimeout: 30_000 })

	let app: FastifyInstance
	let queue: typeof import('../services/indexnow-queue.js')
	let scheduler: typeof import('../services/scheduled-publisher.js')
	const sites: Site[] = []
	const extraUserIds: string[] = []
	const savedEnv: Record<string, string | undefined> = {}
	let nextIp = 1

	const ENV_KEYS = ['INDEXNOW_TICK_MS', 'INDEXNOW_DEBOUNCE_MS', 'INDEXNOW_ENDPOINT']

	// ── helpers ────────────────────────────────────────────────────────────────

	const newSlug = () => `p-${randomUUID().slice(0, 8)}`
	const urlOf = (site: Site, slug: string) => `https://${site.host}/news/${slug}/`
	/** A `now` comfortably past the debounce window. */
	const later = (ms = 10 * MINUTE) => new Date(Date.now() + ms)
	const sorted = (list: string[]) => [...list].sort()

	function api(
		site: Site,
		method: 'GET' | 'POST' | 'PUT' | 'DELETE',
		url: string,
		payload?: Record<string, unknown>,
		headers: Record<string, string> = site.headers,
	) {
		return app.inject({ method, url, headers, payload, remoteAddress: site.ip })
	}

	async function rows<T>(query: SQL): Promise<T[]> {
		return (await app.db.execute(query)) as unknown as T[]
	}

	async function queueRows(projectId: string): Promise<QueueRow[]> {
		const found = await rows<{
			url: string
			attempts: number | string
			nextAttemptMs: number | string
			lastError: string | null
			reason: string
		}>(sql`SELECT url, attempts, (extract(epoch from "nextAttemptAt") * 1000)::float8 AS "nextAttemptMs",
				"lastError", reason FROM indexnow_queue WHERE "projectId" = ${projectId} ORDER BY url`)
		return found.map((r) => ({
			...r,
			attempts: Number(r.attempts),
			nextAttemptMs: Number(r.nextAttemptMs),
		}))
	}

	const queuedUrls = async (site: Site) =>
		(await queueRows(site.projectId)).map((r) => r.url).sort()

	async function clearQueue(projectId: string) {
		await app.db.execute(sql`DELETE FROM indexnow_queue WHERE "projectId" = ${projectId}`)
	}

	const settle = () => queue.settleIndexNowEnqueues()
	const flush = (now: Date, opts: { maxUrlsPerRequest?: number } = {}) =>
		queue.flushIndexNowQueue(app, { now, ...opts })
	const postsFor = (site: Site) => world.posts.filter((p) => p.body.host === site.host)
	const sentUrls = (site: Site) => postsFor(site).flatMap((p) => p.body.urlList)

	async function status(site: Site): Promise<IndexNowStatus> {
		const res = await api(site, 'GET', '/api/v1/indexnow')
		expect(res.statusCode).toBe(200)
		return res.json()
	}

	async function putSettings(site: Site, body: Record<string, unknown>) {
		return api(site, 'PUT', '/api/v1/indexnow', body)
	}

	async function createUser(label: string) {
		const short = randomUUID().slice(0, 8)
		const [user] = await app.db
			.insert(users)
			.values({
				email: `indexnow-${label}-${short}@example.com`,
				name: `IndexNow ${label}`,
				role: 'editor',
			})
			.returning()
		extraUserIds.push(user.id)
		const token = await createJwt({
			id: user.id,
			email: user.email,
			name: user.name,
			role: 'editor',
		})
		return { user, token }
	}

	/** Seed a project owned by a fresh user, with one `news` collection and IndexNow switched on. */
	async function seedSite(
		opts: { template?: string | null; enable?: boolean } = {},
	): Promise<Site> {
		const short = randomUUID().slice(0, 8)
		const host = `site-${short}.example.com`
		const template = opts.template === undefined ? `https://${host}/news/{slug}/` : opts.template
		const { user, token } = await createUser('owner')
		const [project] = await app.db
			.insert(projects)
			.values({ name: 'IndexNow', slug: `indexnow-${short}`, ownerId: user.id })
			.returning()
		await app.db
			.insert(projectMembers)
			.values({ projectId: project.id, userId: user.id, role: 'owner' })
		const n = nextIp++
		const site: Site = {
			projectId: project.id,
			userId: user.id,
			host,
			template,
			collectionId: '',
			token,
			headers: { authorization: `Bearer ${token}`, 'x-project-id': project.id },
			ip: `10.7.${Math.floor(n / 250)}.${(n % 250) + 1}`,
			key: '',
		}
		sites.push(site)

		const created = await api(site, 'POST', '/api/v1/collections', {
			name: 'news',
			label: 'News',
			fields: [{ name: 'title', type: 'text' }],
			...(template ? { settings: { publicUrlTemplate: template } } : {}),
		})
		expect(created.statusCode).toBe(201)
		site.collectionId = created.json().id

		if (opts.enable !== false) {
			const enabled = await putSettings(site, { enabled: true })
			expect(enabled.statusCode).toBe(200)
			site.key = enabled.json().settings.key
		}
		return site
	}

	async function addMember(site: Site, role: 'viewer' | 'editor' | 'admin') {
		const { user, token } = await createUser(role)
		await app.db.insert(projectMembers).values({ projectId: site.projectId, userId: user.id, role })
		return { authorization: `Bearer ${token}`, 'x-project-id': site.projectId }
	}

	async function createApiKey(site: Site, permissions: string[]) {
		const raw = `ink_${randomUUID().replace(/-/g, '')}`
		await app.db.insert(apiKeys).values({
			projectId: site.projectId,
			name: 'indexnow test key',
			keyHash: hashApiKey(raw),
			keyPrefix: raw.slice(0, 12),
			userId: site.userId,
			permissions,
		})
		return { authorization: `Bearer ${raw}` }
	}

	/** Insert a record straight into the table: no event, so nothing is queued. */
	async function seedContent(
		site: Site,
		recordStatus: 'draft' | 'published' | 'archived' | 'scheduled',
		over: { slug?: string | null; collectionId?: string } = {},
	) {
		const slug = over.slug === undefined ? newSlug() : over.slug
		const [row] = await app.db
			.insert(content)
			.values({
				projectId: site.projectId,
				collectionId: over.collectionId ?? site.collectionId,
				slug,
				status: recordStatus,
				markdown: '# Seed',
				html: '<h1>Seed</h1>',
				metadata: { title: slug ?? 'untitled' },
				publishedAt:
					recordStatus === 'published'
						? new Date()
						: recordStatus === 'scheduled'
							? new Date(Date.now() - MINUTE)
							: null,
			})
			.returning()
		return { id: row.id, slug: slug as string }
	}

	/** Publish a seeded draft through the API and flush it out, then forget the traffic. */
	async function publishAndFlush(site: Site, flushAt = later()) {
		const { id, slug } = await seedContent(site, 'draft')
		const res = await api(site, 'POST', `/api/v1/content/${id}/publish`)
		expect(res.statusCode).toBe(200)
		await settle()
		const result = await flush(flushAt)
		return { id, slug, result }
	}

	// ── lifecycle ──────────────────────────────────────────────────────────────

	beforeAll(async () => {
		for (const name of ENV_KEYS) savedEnv[name] = process.env[name]
		// The test drives the worker itself; the background timer stays off.
		process.env.INDEXNOW_TICK_MS = '0'
		process.env.INDEXNOW_DEBOUNCE_MS = String(MINUTE)
		delete process.env.INDEXNOW_ENDPOINT

		app = await buildTestApp()
		queue = await import('../services/indexnow-queue.js')
		scheduler = await import('../services/scheduled-publisher.js')

		vi.stubGlobal('fetch', fetchStub)
		// Drain anything an aborted earlier run left due, so this run's counts are its own.
		await queue.flushIndexNowQueue(app, { now: new Date(Date.now() + 24 * HOUR) })
	})

	beforeEach(() => {
		resetWorld()
		guard.blockedHosts.clear()
	})

	afterEach(async () => {
		await queue.settleIndexNowEnqueues()
		// Rows another test left queued must not be flushed by the next one.
		for (const site of sites) await clearQueue(site.projectId)
	})

	afterAll(async () => {
		vi.unstubAllGlobals()
		for (const name of ENV_KEYS) {
			if (savedEnv[name] === undefined) delete process.env[name]
			else process.env[name] = savedEnv[name]
		}
		if (app) {
			for (const site of sites) {
				await clearQueue(site.projectId)
				try {
					await app.db.execute(
						sql`DELETE FROM indexnow_submissions WHERE "projectId" = ${site.projectId}`,
					)
				} catch {
					// the submissions log cascades from the project; nothing else to clean
				}
				await app.db.delete(projects).where(eq(projects.id, site.projectId))
			}
			for (const id of [...sites.map((s) => s.userId), ...extraUserIds]) {
				await app.db.delete(users).where(eq(users.id, id))
			}
		}
		await app?.close()
	})

	// ── settings API ───────────────────────────────────────────────────────────

	describe('PUT /api/v1/indexnow', () => {
		it.each([
			['enabling', { enabled: true }, true],
			['disabling', { enabled: false }, false],
			// spec: an omitted `enabled` stays off
			['an empty body', {}, false],
		])('generates a 32-hex key on the first PUT (%s) and answers with the GET body', async (_label, body, enabled) => {
			const site = await seedSite({ enable: false })

			const res = await putSettings(site, body)

			expect(res.statusCode).toBe(200)
			const { settings } = res.json() as IndexNowStatus
			expect(settings.key).toMatch(/^[0-9a-f]{32}$/)
			expect(settings.enabled).toBe(enabled)
			expect(res.json()).toEqual(await status(site))
		})

		it('keeps the key on later PUTs and stores a custom key, enabled flag and key location', async () => {
			const site = await seedSite()
			const { key } = site

			const again = await putSettings(site, { enabled: true })
			expect(again.json().settings.key).toBe(key)

			const custom = await putSettings(site, {
				key: 'my-custom-key-123',
				keyLocation: `https://${site.host}/verify/my-custom-key-123.txt`,
				enabled: false,
			})
			expect(custom.statusCode).toBe(200)
			expect(custom.json().settings).toEqual({
				enabled: false,
				key: 'my-custom-key-123',
				keyLocation: `https://${site.host}/verify/my-custom-key-123.txt`,
			})
			expect((await status(site)).settings).toEqual(custom.json().settings)
		})

		it.each([
			['a key shorter than 8 characters', { key: 'short' }],
			['a key with a space', { key: 'has a space in it' }],
			['a key with a dot', { key: 'abcdefgh.txt' }],
			['a key longer than 128 characters', { key: 'a'.repeat(129) }],
			['a key location that is not a URL', { keyLocation: 'not a url' }],
			['a key location with another scheme', { keyLocation: 'ftp://example.com/k.txt' }],
			['a relative key location', { keyLocation: '/news/k.txt' }],
		])('rejects %s with 400 and stores nothing', async (_label, body) => {
			const site = await seedSite()
			const before = (await status(site)).settings

			const res = await putSettings(site, body)

			expect(res.statusCode).toBe(400)
			expect(typeof res.json().error).toBe('string')
			expect((await status(site)).settings).toEqual(before)
		})

		it('rejects a key location the outbound URL guard refuses', async () => {
			const site = await seedSite()
			guard.blockedHosts.add('internal.example.com')

			const res = await putSettings(site, { keyLocation: 'https://internal.example.com/k.txt' })

			expect(res.statusCode).toBe(400)
			expect(typeof res.json().error).toBe('string')
			expect((await status(site)).settings.keyLocation).toBeNull()
		})

		it.each([null, ''])('clears the key location with %j', async (cleared) => {
			const site = await seedSite()
			const set = await putSettings(site, {
				keyLocation: `https://${site.host}/news/${site.key}.txt`,
			})
			expect(set.json().settings.keyLocation).toBe(`https://${site.host}/news/${site.key}.txt`)

			const res = await putSettings(site, { keyLocation: cleared })

			expect(res.statusCode).toBe(200)
			expect(res.json().settings.keyLocation).toBeNull()
		})

		it.each([
			['follows the new key when the location is named after the old key', 'news', true],
			// spec: any other file name is left exactly as stored
			['leaves a location with another file name alone', 'verification', false],
		])('regenerateKey %s', async (_label, file, follows) => {
			const site = await seedSite()
			const oldKey = site.key
			const name = follows ? oldKey : file
			const location = `https://${site.host}/news/${name}.txt`
			expect((await putSettings(site, { keyLocation: location })).statusCode).toBe(200)

			const res = await putSettings(site, { regenerateKey: true })

			expect(res.statusCode).toBe(200)
			const { key, keyLocation } = res.json().settings
			expect(key).toMatch(/^[0-9a-f]{32}$/)
			expect(key).not.toBe(oldKey)
			expect(keyLocation).toBe(follows ? `https://${site.host}/news/${key}.txt` : location)
		})

		it.each([
			[
				'a stale IndexNow block',
				{ settings: { indexNow: { enabled: false, key: 'attackers-key-123' } } },
			],
			['a save that leaves IndexNow out', { settings: { requireReview: false } }],
		])('is not changed by PUT /api/v1/projects/:id with %s', async (_label, body) => {
			const site = await seedSite()
			const [before] = await app.db.select().from(projects).where(eq(projects.id, site.projectId))
			const storedBefore = (before.settings as Record<string, unknown>).indexNow
			expect(storedBefore).toMatchObject({ enabled: true, key: site.key })

			const res = await api(site, 'PUT', `/api/v1/projects/${site.projectId}`, body)

			// spec: the form's save still succeeds, the IndexNow block in it is ignored
			expect(res.statusCode).toBe(200)
			const [after] = await app.db.select().from(projects).where(eq(projects.id, site.projectId))
			expect((after.settings as Record<string, unknown>).indexNow).toEqual(storedBefore)
			expect((await status(site)).settings).toMatchObject({ enabled: true, key: site.key })
		})

		it('lets viewers read the settings but not change them', async () => {
			const site = await seedSite()
			const viewer = await addMember(site, 'viewer')

			expect((await api(site, 'GET', '/api/v1/indexnow', undefined, viewer)).statusCode).toBe(200)
			expect(
				(await api(site, 'PUT', '/api/v1/indexnow', { enabled: false }, viewer)).statusCode,
			).toBe(403)
			expect(
				(await api(site, 'POST', '/api/v1/indexnow/verify', undefined, viewer)).statusCode,
			).toBe(403)
			expect((await status(site)).settings.enabled).toBe(true)
		})
	})

	// ── key-file contract ──────────────────────────────────────────────────────

	describe('GET /api/v1/indexnow/key', () => {
		it('works with a read-only API key and returns the documented shape under /news/', async () => {
			const site = await seedSite()
			const keyLocation = `https://${site.host}/news/${site.key}.txt`
			expect((await putSettings(site, { keyLocation })).statusCode).toBe(200)
			const readOnly = await createApiKey(site, ['content:read'])

			const res = await api(site, 'GET', '/api/v1/indexnow/key', undefined, readOnly)

			expect(res.statusCode).toBe(200)
			expect(res.json()).toEqual({
				enabled: true,
				key: site.key,
				keyLocation,
				keyFile: { path: `/news/${site.key}.txt`, content: site.key },
				hosts: [{ host: site.host, keyLocation }],
			})
		})

		it('answers the empty shape while no key is configured', async () => {
			const site = await seedSite({ enable: false })

			const res = await api(site, 'GET', '/api/v1/indexnow/key')

			expect(res.statusCode).toBe(200)
			expect(res.json()).toEqual({
				enabled: false,
				key: null,
				keyLocation: null,
				keyFile: null,
				hosts: [],
			})
		})

		it('reports a null keyLocation and /<key>.txt when no location is stored', async () => {
			const site = await seedSite()

			const res = await api(site, 'GET', '/api/v1/indexnow/key')

			expect(res.json()).toEqual({
				enabled: true,
				key: site.key,
				keyLocation: null,
				keyFile: { path: `/${site.key}.txt`, content: site.key },
				hosts: [{ host: site.host, keyLocation: `https://${site.host}/${site.key}.txt` }],
			})
		})

		it('lists each distinct template host plus the key location host', async () => {
			const site = await seedSite()
			const other = `other-${randomUUID().slice(0, 8)}.example.com`
			const keyHost = `keys-${randomUUID().slice(0, 8)}.example.com`
			const second = await api(site, 'POST', '/api/v1/collections', {
				name: 'docs',
				label: 'Docs',
				fields: [{ name: 'title', type: 'text' }],
				settings: { publicUrlTemplate: `https://${other}/docs/{slug}` },
			})
			expect(second.statusCode).toBe(201)
			const third = await api(site, 'POST', '/api/v1/collections', {
				name: 'blog',
				label: 'Blog',
				fields: [{ name: 'title', type: 'text' }],
				// the same host as `news`: must not be listed twice
				settings: { publicUrlTemplate: `https://${site.host}/blog/{slug}` },
			})
			expect(third.statusCode).toBe(201)
			expect(
				(await putSettings(site, { keyLocation: `https://${keyHost}/news/${site.key}.txt` }))
					.statusCode,
			).toBe(200)

			const res = await api(site, 'GET', '/api/v1/indexnow/key')

			const hosts = (res.json().hosts as Array<{ host: string; keyLocation: string }>).sort(
				(a, b) => a.host.localeCompare(b.host),
			)
			expect(hosts).toEqual(
				[site.host, other, keyHost]
					.sort()
					.map((host) => ({ host, keyLocation: `https://${host}/news/${site.key}.txt` })),
			)
		})

		it('lets a read-only API key read the status but neither change settings nor verify', async () => {
			const site = await seedSite()
			const readOnly = await createApiKey(site, ['content:read'])

			expect((await api(site, 'GET', '/api/v1/indexnow', undefined, readOnly)).statusCode).toBe(200)
			expect(
				(await api(site, 'PUT', '/api/v1/indexnow', { enabled: false }, readOnly)).statusCode,
			).toBe(403)
			expect(
				(await api(site, 'POST', '/api/v1/indexnow/verify', undefined, readOnly)).statusCode,
			).toBe(403)
			expect((await status(site)).settings.enabled).toBe(true)
		})
	})

	// ── collection URL template ────────────────────────────────────────────────

	describe('collection publicUrlTemplate', () => {
		it('is exposed through collection settings, which default to {}', async () => {
			const bare = await seedSite({ template: null })
			const withTemplate = await seedSite()

			const none = await api(bare, 'GET', `/api/v1/collections/${bare.collectionId}`)
			const some = await api(
				withTemplate,
				'GET',
				`/api/v1/collections/${withTemplate.collectionId}`,
			)

			expect(none.json().settings).toEqual({})
			expect(some.json().settings).toEqual({ publicUrlTemplate: withTemplate.template })
		})

		it.each([null, ''])('is removed by PUT with %j', async (cleared) => {
			const site = await seedSite()

			const res = await api(site, 'PUT', `/api/v1/collections/${site.collectionId}`, {
				settings: { publicUrlTemplate: cleared },
			})

			expect(res.statusCode).toBe(200)
			const after = await api(site, 'GET', `/api/v1/collections/${site.collectionId}`)
			// spec: "removes the template" - absent (or null) in the stored settings
			expect(after.json().settings.publicUrlTemplate ?? null).toBeNull()
			expect((await status(site)).collections).toEqual([])
		})

		it.each([
			['an unknown placeholder', 'https://example.com/{title}/{slug}'],
			['neither {slug} nor {id}', 'https://example.com/news/'],
			['a non-http scheme', 'ftp://example.com/{slug}'],
			['a root-relative path', '/news/{slug}'],
			['a placeholder in the host', 'https://{locale}.example.com/{slug}'],
		])('rejects a template with %s on create and on update', async (_label, template) => {
			const site = await seedSite()

			const created = await api(site, 'POST', '/api/v1/collections', {
				name: `bad_${randomUUID().slice(0, 6)}`,
				label: 'Bad',
				fields: [{ name: 'title', type: 'text' }],
				settings: { publicUrlTemplate: template },
			})
			expect(created.statusCode).toBe(400)
			expect(typeof created.json().error).toBe('string')

			const updated = await api(site, 'PUT', `/api/v1/collections/${site.collectionId}`, {
				settings: { publicUrlTemplate: template },
			})
			expect(updated.statusCode).toBe(400)
			expect(typeof updated.json().error).toBe('string')
			const after = await api(site, 'GET', `/api/v1/collections/${site.collectionId}`)
			expect(after.json().settings.publicUrlTemplate).toBe(site.template)
		})

		it('rejects a template whose host the outbound URL guard refuses', async () => {
			const site = await seedSite()
			const blocked = `blocked-${randomUUID().slice(0, 8)}.example.com`
			guard.blockedHosts.add(blocked)

			const res = await api(site, 'PUT', `/api/v1/collections/${site.collectionId}`, {
				settings: { publicUrlTemplate: `https://${blocked}/news/{slug}/` },
			})

			expect(res.statusCode).toBe(400)
			expect(typeof res.json().error).toBe('string')
		})
	})

	// ── content events queue URLs ──────────────────────────────────────────────

	describe('content events', () => {
		const PUBLISH_PATHS: Array<[string, (site: Site) => Promise<string>]> = [
			[
				'POST /content with status published',
				async (site) => {
					const slug = newSlug()
					const res = await api(site, 'POST', '/api/v1/content', {
						collectionId: site.collectionId,
						slug,
						markdown: '# Hello',
						metadata: { title: slug },
						status: 'published',
					})
					expect(res.statusCode).toBe(201)
					return slug
				},
			],
			[
				'POST /content/:id/publish',
				async (site) => {
					const { id, slug } = await seedContent(site, 'draft')
					const res = await api(site, 'POST', `/api/v1/content/${id}/publish`)
					expect(res.statusCode).toBe(200)
					return slug
				},
			],
			[
				'PUT /content/:id with status published',
				async (site) => {
					const { id, slug } = await seedContent(site, 'draft')
					const res = await api(site, 'PUT', `/api/v1/content/${id}`, { status: 'published' })
					expect(res.statusCode).toBe(200)
					return slug
				},
			],
			[
				'PUT /content/bulk with status published',
				async (site) => {
					const { id, slug } = await seedContent(site, 'draft')
					const res = await api(site, 'PUT', '/api/v1/content/bulk', {
						items: [{ id, status: 'published' }],
					})
					expect(res.statusCode).toBe(200)
					return slug
				},
			],
			[
				'POST /content/bulk with status published',
				async (site) => {
					const slug = newSlug()
					const res = await api(site, 'POST', '/api/v1/content/bulk', {
						items: [
							{
								collectionId: site.collectionId,
								slug,
								markdown: '# Hello',
								metadata: { title: slug },
								status: 'published',
							},
						],
					})
					expect(res.statusCode).toBeLessThan(300)
					return slug
				},
			],
			[
				'the scheduled publisher',
				async (site) => {
					const { slug } = await seedContent(site, 'scheduled')
					await scheduler.publishDueContent(app)
					return slug
				},
			],
		]

		it.each(
			PUBLISH_PATHS,
		)('a publish through %s queues exactly its URL and sends one request', async (_label, publish) => {
			const site = await seedSite()

			const slug = await publish(site)
			await settle()

			expect(await queuedUrls(site)).toEqual([urlOf(site, slug)])
			expect(await flush(later())).toEqual({ requests: 1, submitted: 1 })
			expect(postsFor(site)).toHaveLength(1)
			const [post] = postsFor(site)
			expect(post.body).toEqual({
				host: site.host,
				key: site.key,
				keyLocation: `https://${site.host}/${site.key}.txt`,
				urlList: [urlOf(site, slug)],
			})
			expect(post.headers.get('content-type')).toBe('application/json; charset=utf-8')
			expect(await queuedUrls(site)).toEqual([])
		})

		it('verifies the key file with a GET of its location right before the request', async () => {
			const site = await seedSite()

			await publishAndFlush(site)

			expect(world.keyGets).toContain(`https://${site.host}/${site.key}.txt`)
			expect(world.order.slice(-2)).toEqual(['KEY', 'POST'])
		})

		it.each([
			['publish', 'draft'],
			['unpublish', 'published'],
			['archive', 'published'],
			['delete', 'published'],
		] as const)('bulk-action %s queues the URL of every record it touches', async (action, seedStatus) => {
			const site = await seedSite()
			const a = await seedContent(site, seedStatus)
			const b = await seedContent(site, seedStatus)

			const res = await api(site, 'POST', '/api/v1/content/bulk-action', {
				action,
				ids: [a.id, b.id],
			})
			expect(res.statusCode).toBe(200)
			expect(res.json().succeeded).toBe(2)
			await settle()

			const expected = sorted([urlOf(site, a.slug), urlOf(site, b.slug)])
			expect(await queuedUrls(site)).toEqual(expected)
			await flush(later())
			expect(postsFor(site)).toHaveLength(1)
			expect(sorted(sentUrls(site))).toEqual(expected)
		})

		const TRANSITIONS: Array<
			[
				string,
				(site: Site, record: { id: string; slug: string }) => Promise<{ statusCode: number }>,
				(site: Site, slug: string) => string[],
			]
		> = [
			[
				'an edit of a published record queues its URL',
				(site, r) => api(site, 'PUT', `/api/v1/content/${r.id}`, { markdown: '# Edited' }),
				(site, slug) => [urlOf(site, slug)],
			],
			[
				'an unpublish (published to draft) queues its URL',
				(site, r) => api(site, 'PUT', `/api/v1/content/${r.id}`, { status: 'draft' }),
				(site, slug) => [urlOf(site, slug)],
			],
			[
				'an archive queues its URL',
				(site, r) => api(site, 'PUT', `/api/v1/content/${r.id}`, { status: 'archived' }),
				(site, slug) => [urlOf(site, slug)],
			],
			[
				'a delete queues its URL',
				(site, r) => api(site, 'DELETE', `/api/v1/content/${r.id}`),
				(site, slug) => [urlOf(site, slug)],
			],
			[
				'a slug change queues the old and the new URL',
				(site, r) => api(site, 'PUT', `/api/v1/content/${r.id}`, { slug: `${r.slug}-renamed` }),
				(site, slug) => [urlOf(site, slug), urlOf(site, `${slug}-renamed`)],
			],
		]

		it.each(TRANSITIONS)('%s', async (_label, act, expectedUrls) => {
			const site = await seedSite()
			const record = await seedContent(site, 'published')

			const res = await act(site, record)
			expect(res.statusCode).toBeLessThan(300)
			await settle()

			const expected = sorted(expectedUrls(site, record.slug))
			expect(await queuedUrls(site)).toEqual(expected)
			await flush(later())
			expect(postsFor(site)).toHaveLength(1)
			expect(sorted(sentUrls(site))).toEqual(expected)
		})

		it('queues a URL once however often the record changes before the flush', async () => {
			const site = await seedSite()
			const record = await seedContent(site, 'published')

			for (const markdown of ['# One', '# Two', '# Three']) {
				const res = await api(site, 'PUT', `/api/v1/content/${record.id}`, { markdown })
				expect(res.statusCode).toBe(200)
				await settle()
			}

			expect(await queuedUrls(site)).toEqual([urlOf(site, record.slug)])
			await flush(later())
			expect(sentUrls(site)).toEqual([urlOf(site, record.slug)])
		})

		it('never queues anything for drafts', async () => {
			const site = await seedSite()

			const created = await api(site, 'POST', '/api/v1/content', {
				collectionId: site.collectionId,
				slug: newSlug(),
				markdown: '# Draft',
				metadata: { title: 'Draft' },
			})
			expect(created.statusCode).toBe(201)
			const id = created.json().id
			expect(
				(await api(site, 'PUT', `/api/v1/content/${id}`, { markdown: '# Edited draft' }))
					.statusCode,
			).toBe(200)
			expect(
				(
					await api(site, 'PUT', `/api/v1/content/${id}`, {
						status: 'scheduled',
						publishedAt: new Date(Date.now() + 24 * HOUR).toISOString(),
					})
				).statusCode,
			).toBe(200)
			expect((await api(site, 'DELETE', `/api/v1/content/${id}`)).statusCode).toBe(204)
			await settle()

			expect(await queuedUrls(site)).toEqual([])
			expect(await flush(later())).toEqual({ requests: 0, submitted: 0 })
			expect(postsFor(site)).toHaveLength(0)
		})

		it.each([
			['IndexNow was never enabled', { template: undefined, enable: false }],
			['the collection has no URL template', { template: null, enable: true }],
		])('queues nothing when %s', async (_label, opts) => {
			const site = await seedSite(opts)

			const { id } = await seedContent(site, 'draft')
			expect((await api(site, 'POST', `/api/v1/content/${id}/publish`)).statusCode).toBe(200)
			await settle()

			expect(await queuedUrls(site)).toEqual([])
			await flush(later())
			expect(postsFor(site)).toHaveLength(0)
		})

		it('drops queued URLs without a request when IndexNow is switched off before the flush', async () => {
			const site = await seedSite()
			const { id } = await seedContent(site, 'draft')
			expect((await api(site, 'POST', `/api/v1/content/${id}/publish`)).statusCode).toBe(200)
			await settle()
			expect(await queuedUrls(site)).toHaveLength(1)
			expect((await putSettings(site, { enabled: false })).statusCode).toBe(200)

			await flush(later())

			expect(postsFor(site)).toHaveLength(0)
			expect(await queuedUrls(site)).toEqual([])
		})
	})

	// ── the worker ─────────────────────────────────────────────────────────────

	describe('flushIndexNowQueue', () => {
		it('sends nothing before the debounce window has elapsed, then sends the URL', async () => {
			const site = await seedSite()
			const { id, slug } = await seedContent(site, 'draft')
			expect((await api(site, 'POST', `/api/v1/content/${id}/publish`)).statusCode).toBe(200)
			await settle()

			expect(await flush(new Date())).toEqual({ requests: 0, submitted: 0 })

			expect(postsFor(site)).toHaveLength(0)
			expect(await queuedUrls(site)).toEqual([urlOf(site, slug)])
			await flush(later())
			expect(sentUrls(site)).toEqual([urlOf(site, slug)])
		})

		it('sends URLs queued within the debounce window as one request', async () => {
			const site = await seedSite()
			const first = await seedContent(site, 'draft')
			const second = await seedContent(site, 'draft')
			expect((await api(site, 'POST', `/api/v1/content/${first.id}/publish`)).statusCode).toBe(200)
			await settle()
			await new Promise((resolve) => setTimeout(resolve, 25))
			expect((await api(site, 'POST', `/api/v1/content/${second.id}/publish`)).statusCode).toBe(200)
			await settle()
			const queued = await queueRows(site.projectId)
			expect(queued).toHaveLength(2)

			// Just past the first URL's due time: the second one is still inside its own
			// debounce window but is fresh (never attempted), so it travels with the first.
			const now = new Date(Math.min(...queued.map((r) => r.nextAttemptMs)) + 1)
			await flush(now)

			expect(postsFor(site)).toHaveLength(1)
			expect(sorted(sentUrls(site))).toEqual(
				sorted([urlOf(site, first.slug), urlOf(site, second.slug)]),
			)
			expect(await queuedUrls(site)).toEqual([])
		})

		it.each([
			[
				'a 429 with Retry-After',
				{ status: 429, headers: { 'Retry-After': '120' }, body: 'slow down' } as Reply,
				120_000,
			],
			['a 503', { status: 503, body: 'unavailable' } as Reply, 60_000],
			['a network error', { throws: 'connect ECONNRESET' } as Reply, 60_000],
		])('keeps the row and schedules a later attempt after %s, then succeeds', async (_label, reply, delay) => {
			const site = await seedSite()
			const { id, slug } = await seedContent(site, 'draft')
			expect((await api(site, 'POST', `/api/v1/content/${id}/publish`)).statusCode).toBe(200)
			await settle()
			world.replies.push(reply)
			const t1 = later()

			await flush(t1)

			expect(postsFor(site)).toHaveLength(1)
			const [row] = await queueRows(site.projectId)
			expect(row.url).toBe(urlOf(site, slug))
			expect(row.attempts).toBe(1)
			expect(row.nextAttemptMs).toBeGreaterThan(t1.getTime())
			expect(Math.abs(row.nextAttemptMs - (t1.getTime() + delay))).toBeLessThanOrEqual(1000)

			// Not due yet: no new request.
			await flush(new Date(t1.getTime() + delay - 30_000))
			expect(postsFor(site)).toHaveLength(1)

			// Due: the same URL goes out again and the row is gone.
			await flush(new Date(t1.getTime() + delay + MINUTE))
			expect(postsFor(site)).toHaveLength(2)
			expect(postsFor(site)[1].body.urlList).toEqual([urlOf(site, slug)])
			expect(await queuedUrls(site)).toEqual([])
			const after = await status(site)
			expect(after.collections[0].lastSubmission).toMatchObject({
				status: 'success',
				statusCode: 200,
			})
			expect(after.recent.map((r) => r.status)).toEqual(
				expect.arrayContaining(['retrying', 'success']),
			)
		})

		it('gives up after six failed attempts and logs a failure', async () => {
			const site = await seedSite()
			const { id } = await seedContent(site, 'draft')
			expect((await api(site, 'POST', `/api/v1/content/${id}/publish`)).statusCode).toBe(200)
			await settle()
			world.replies.push(...Array.from({ length: 6 }, () => ({ status: 503, body: 'down' })))
			const start = Date.now()

			for (let attempt = 1; attempt <= 5; attempt++) {
				// 7 hours apart: past the longest back-off (6 hours), so the row is always due.
				await flush(new Date(start + attempt * 7 * HOUR))
				const [row] = await queueRows(site.projectId)
				expect(row.attempts).toBe(attempt)
			}
			await flush(new Date(start + 6 * 7 * HOUR))

			expect(postsFor(site)).toHaveLength(6)
			expect(await queuedUrls(site)).toEqual([])
			const after = await status(site)
			expect(after.collections[0].lastSubmission).toMatchObject({
				status: 'failed',
				statusCode: 503,
			})
			// nothing is left to send
			await flush(new Date(start + 100 * HOUR))
			expect(postsFor(site)).toHaveLength(6)
		})

		it('drops the rows and logs a failed submission on a 422', async () => {
			const site = await seedSite()
			const { id } = await seedContent(site, 'draft')
			expect((await api(site, 'POST', `/api/v1/content/${id}/publish`)).statusCode).toBe(200)
			await settle()
			world.replies.push({ status: 422, body: 'URLs do not belong to the host' })

			await flush(later())

			expect(postsFor(site)).toHaveLength(1)
			expect(await queuedUrls(site)).toEqual([])
			const after = await status(site)
			expect(after.collections[0].lastSubmission).toMatchObject({
				status: 'failed',
				statusCode: 422,
			})
			expect(after.recent[0]).toMatchObject({ status: 'failed', statusCode: 422, urlCount: 1 })
			// a failure is final: a later flush sends nothing
			await flush(later(2 * HOUR))
			expect(postsFor(site)).toHaveLength(1)
		})

		it.each([
			['returns 404', '404' as const],
			['serves a different key', 'wrong' as const],
		])('submits nothing while the key file %s, keeps the rows and shows them as waiting', async (_label, mode) => {
			const site = await seedSite()
			world.keyFile = mode
			const { id, slug } = await seedContent(site, 'draft')
			expect((await api(site, 'POST', `/api/v1/content/${id}/publish`)).statusCode).toBe(200)
			await settle()
			const t1 = later()

			expect(await flush(t1)).toEqual({ requests: 0, submitted: 0 })

			expect(world.posts).toHaveLength(0)
			const [row] = await queueRows(site.projectId)
			expect(row.url).toBe(urlOf(site, slug))
			expect(row.lastError).toBeTruthy()
			expect(row.nextAttemptMs).toBeGreaterThan(t1.getTime())
			expect((await status(site)).collections[0].waiting).toBeGreaterThan(0)

			// Once the file is served again the URL goes out.
			world.keyFile = 'ok'
			await flush(new Date(t1.getTime() + 30 * MINUTE))
			expect(sentUrls(site)).toEqual([urlOf(site, slug)])
			expect(await queuedUrls(site)).toEqual([])
		})

		it('checks the key file again on every flush, so a file that disappears stops later submissions', async () => {
			const site = await seedSite()
			await publishAndFlush(site)
			expect(postsFor(site)).toHaveLength(1)
			const getsAfterFirst = world.keyGets.length
			expect(getsAfterFirst).toBeGreaterThanOrEqual(1)

			world.keyFile = '404'
			const second = await seedContent(site, 'draft')
			expect((await api(site, 'POST', `/api/v1/content/${second.id}/publish`)).statusCode).toBe(200)
			await settle()
			await flush(later(20 * MINUTE))

			expect(world.keyGets.length).toBeGreaterThan(getsAfterFirst)
			expect(postsFor(site)).toHaveLength(1)
			expect(await queuedUrls(site)).toEqual([urlOf(site, second.slug)])

			world.keyFile = 'ok'
			await flush(later(40 * MINUTE))
			expect(postsFor(site)).toHaveLength(2)
			expect(postsFor(site)[1].body.urlList).toEqual([urlOf(site, second.slug)])
		})
	})

	// ── resubmit ───────────────────────────────────────────────────────────────

	describe('POST /api/v1/indexnow/collections/:id/resubmit', () => {
		async function seedMixed(site: Site) {
			const published = [
				await seedContent(site, 'published'),
				await seedContent(site, 'published'),
				await seedContent(site, 'published'),
			]
			await seedContent(site, 'draft')
			await seedContent(site, 'archived')
			await seedContent(site, 'published', { slug: null })
			return published
		}

		it('queues the URL of every published record only, due immediately', async () => {
			const site = await seedSite()
			const published = await seedMixed(site)

			const res = await api(
				site,
				'POST',
				`/api/v1/indexnow/collections/${site.collectionId}/resubmit`,
			)

			expect(res.statusCode).toBe(200)
			// 3 published records with a slug; the published record without one yields no URL
			expect(res.json()).toEqual({ queued: 3, skipped: 1 })
			const queued = await queueRows(site.projectId)
			expect(sorted(queued.map((r) => r.url))).toEqual(
				sorted(published.map((r) => urlOf(site, r.slug))),
			)
			expect(queued.every((r) => r.reason === 'resubmit' && r.attempts === 0)).toBe(true)

			// Due right away: far inside the 60 s debounce window a change would have waited out.
			await flush(later(5_000))
			expect(postsFor(site)).toHaveLength(1)
			expect(sorted(sentUrls(site))).toEqual(sorted(published.map((r) => urlOf(site, r.slug))))
			expect((await status(site)).collections[0].lastSubmission).toMatchObject({
				status: 'success',
				trigger: 'resubmit',
				urlCount: 3,
			})
		})

		it('splits a flush at maxUrlsPerRequest', async () => {
			const site = await seedSite()
			const published = await seedMixed(site)
			expect(
				(await api(site, 'POST', `/api/v1/indexnow/collections/${site.collectionId}/resubmit`))
					.statusCode,
			).toBe(200)

			// spec: `submitted` counts the URLs delivered, `requests` the POSTs made
			expect(await flush(later(5_000), { maxUrlsPerRequest: 2 })).toEqual({
				requests: 2,
				submitted: 3,
			})

			expect(postsFor(site)).toHaveLength(2)
			expect(
				postsFor(site)
					.map((p) => p.body.urlList.length)
					.sort(),
			).toEqual([1, 2])
			expect(sorted(sentUrls(site))).toEqual(sorted(published.map((r) => urlOf(site, r.slug))))
			expect(await queuedUrls(site)).toEqual([])
		})

		it.each([
			[
				'a collection id that does not exist',
				async () => {
					const site = await seedSite()
					return { site, id: randomUUID(), headers: site.headers, expected: 404 }
				},
			],
			[
				'a collection of another project',
				async () => {
					const site = await seedSite()
					const other = await seedSite()
					return { site, id: other.collectionId, headers: site.headers, expected: 404 }
				},
			],
			[
				'a project with IndexNow disabled',
				async () => {
					const site = await seedSite()
					await putSettings(site, { enabled: false })
					return { site, id: site.collectionId, headers: site.headers, expected: 400 }
				},
			],
			[
				'a collection without a URL template',
				async () => {
					const site = await seedSite({ template: null })
					return { site, id: site.collectionId, headers: site.headers, expected: 400 }
				},
			],
			[
				'a viewer',
				async () => {
					const site = await seedSite()
					return {
						site,
						id: site.collectionId,
						headers: await addMember(site, 'viewer'),
						expected: 403,
					}
				},
			],
		])('answers %s with its error status and queues nothing', async (_label, setup) => {
			const { site, id, headers, expected } = await setup()
			await seedContent(site, 'published')

			const res = await api(
				site,
				'POST',
				`/api/v1/indexnow/collections/${id}/resubmit`,
				undefined,
				headers,
			)

			expect(res.statusCode).toBe(expected)
			if (expected !== 403) expect(typeof res.json().error).toBe('string')
			expect(await queuedUrls(site)).toEqual([])
		})
	})

	// ── status and verification ────────────────────────────────────────────────

	describe('GET /api/v1/indexnow', () => {
		it('shows pending work, then the last successful submission after a good flush', async () => {
			const site = await seedSite()
			// a collection without a template must not be listed
			const plain = await api(site, 'POST', '/api/v1/collections', {
				name: 'notes',
				label: 'Notes',
				fields: [{ name: 'title', type: 'text' }],
			})
			expect(plain.statusCode).toBe(201)
			const { id, slug } = await seedContent(site, 'draft')
			expect((await api(site, 'POST', `/api/v1/content/${id}/publish`)).statusCode).toBe(200)
			await settle()

			const before = await status(site)
			expect(before.settings).toEqual({ enabled: true, key: site.key, keyLocation: null })
			expect(before.keyFiles).toEqual([
				{
					host: site.host,
					url: `https://${site.host}/${site.key}.txt`,
					path: `/${site.key}.txt`,
				},
			])
			expect(before.collections).toHaveLength(1)
			expect(before.collections[0]).toMatchObject({
				id: site.collectionId,
				name: 'news',
				label: 'News',
				publicUrlTemplate: site.template,
				pending: 1,
				waiting: 0,
				lastSubmission: null,
			})
			expect(before.recent).toEqual([])

			await flush(later())

			const after = await status(site)
			expect(after.collections[0]).toMatchObject({ pending: 0, waiting: 0 })
			expect(after.collections[0].lastSubmission).toMatchObject({
				status: 'success',
				statusCode: 200,
				urlCount: 1,
				trigger: 'change',
			})
			expect(typeof after.collections[0].lastSubmission?.message).toBe('string')
			expect(Number.isNaN(Date.parse(after.collections[0].lastSubmission?.createdAt ?? ''))).toBe(
				false,
			)
			expect(after.recent).toHaveLength(1)
			expect(after.recent[0]).toMatchObject({
				collectionId: site.collectionId,
				host: site.host,
				urlCount: 1,
				sampleUrls: [urlOf(site, slug)],
				status: 'success',
				statusCode: 200,
				trigger: 'change',
			})
		})
	})

	describe('POST /api/v1/indexnow/verify', () => {
		it('reports one result per host and fetches the key file fresh on every call', async () => {
			const site = await seedSite()
			const location = `https://${site.host}/${site.key}.txt`

			const ok = await api(site, 'POST', '/api/v1/indexnow/verify')
			expect(ok.statusCode).toBe(200)
			expect(ok.json()).toEqual({
				results: [
					{
						host: site.host,
						keyLocation: location,
						ok: true,
						statusCode: 200,
						message: expect.any(String),
					},
				],
			})
			expect(world.keyGets).toEqual([location])

			world.keyFile = '404'
			const missing = await api(site, 'POST', '/api/v1/indexnow/verify')
			expect(missing.statusCode).toBe(200)
			expect(missing.json().results).toEqual([
				{
					host: site.host,
					keyLocation: location,
					ok: false,
					statusCode: 404,
					message: expect.any(String),
				},
			])
			expect(world.keyGets).toEqual([location, location])
		})
	})
})
