import { createHash, randomUUID } from 'node:crypto'
import {
	collections,
	content,
	ensureTables,
	media,
	projectMembers,
	projects,
	users,
} from '@innolope/db'
import { and, eq, inArray, sql } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createJwt } from '../plugins/auth.js'
import { buildTestApp, hasTestDb, TEST_DB_URL } from '../test/harness.js'

// Simulate failures at the fetch boundary without changing production SSRF policy.
vi.mock('../adapters/connection-guard.js', async (importOriginal) => ({
	...(await importOriginal<typeof import('../adapters/connection-guard.js')>()),
	safeFetch: (url: string, init?: RequestInit) => {
		if (url.includes('timeout')) throw new Error('Source timeout')
		if (url.includes('private-redirect')) throw new Error('Blocked private address on redirect')
		if (url.includes('redirect-loop')) throw new Error('Too many redirects')
		return fetch(url, init)
	},
}))

// A complete, decodable 1x1 PNG; no external fixture or network is required.
const png = Buffer.from(
	'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/aV8AAAAASUVORK5CYII=',
	'base64',
)

describe.skipIf(!hasTestDb)('library upload without a license', { timeout: 30_000 }, () => {
	let app: FastifyInstance
	let projectId: string
	let userId: string
	let token: string
	const oldCloud = process.env.CLOUD_MODE
	const oldLicense = process.env.INNOLOPE_LICENSE_KEY

	beforeAll(async () => {
		// License is an instance-wide singleton: never alter a shared database row.
		const db = postgres(TEST_DB_URL ?? '', { onnotice: () => {} })
		try {
			const [existing] =
				await db`SELECT count(*)::int AS count FROM license_settings WHERE "licenseKey" IS NOT NULL`
			if (existing.count !== 0)
				throw new Error(
					'Unlicensed fixture requires an isolated test database with no stored license',
				)
		} finally {
			await db.end()
		}
		process.env.CLOUD_MODE = 'false'
		delete process.env.INNOLOPE_LICENSE_KEY
		vi.resetModules()
		app = await buildTestApp()
		const short = randomUUID().slice(0, 8)
		const [user] = await app.db
			.insert(users)
			.values({ email: `unlicensed-${short}@test.local`, name: 'Owner', role: 'editor' })
			.returning()
		userId = user.id
		const [project] = await app.db
			.insert(projects)
			.values({ name: 'Unlicensed media', slug: `unlicensed-${short}`, ownerId: userId })
			.returning()
		projectId = project.id
		await app.db.insert(projectMembers).values({ projectId, userId, role: 'owner' })
		token = await createJwt({ id: userId, email: user.email, name: user.name, role: user.role })
	})

	afterAll(async () => {
		if (projectId) await app.db.delete(projects).where(eq(projects.id, projectId))
		if (userId) await app.db.delete(users).where(eq(users.id, userId))
		await app?.close()
		if (oldCloud === undefined) delete process.env.CLOUD_MODE
		else process.env.CLOUD_MODE = oldCloud
		if (oldLicense === undefined) delete process.env.INNOLOPE_LICENSE_KEY
		else process.env.INNOLOPE_LICENSE_KEY = oldLicense
	})

	it('explains and denies a library upload without media integrations (F06)', async () => {
		const headers = { authorization: `Bearer ${token}`, 'x-project-id': projectId }
		const target = await app.inject({ method: 'GET', url: '/api/v1/media/upload-target', headers })
		expect(target.statusCode, target.body).toBe(200)
		expect(target.json().resolved.kind).toBe('library')
		expect(target.json().canUpload).toBe(false)
		expect(target.json().problem).toMatch(/licen[cs]|media.integrations/i)
		const result = await app.inject({
			method: 'POST',
			url: '/api/v1/media/ingest',
			headers,
			payload: { data: png.toString('base64'), mimeType: 'image/png' },
		})
		expect(result.statusCode).toBe(403)
		expect(result.body).toMatch(/licen[cs]|media.integrations/i)
	})
})

describe.skipIf(!hasTestDb)('agent media ingest (real Postgres)', { timeout: 30_000 }, () => {
	let app: FastifyInstance
	let projectId: string
	let otherProjectId: string
	let ownerId: string
	let viewerId: string
	let ownerToken: string
	let viewerToken: string
	let uploads = 0
	let failProvider = false
	const originalFetch = globalThis.fetch
	const headers = (token = ownerToken, project = projectId) => ({
		authorization: `Bearer ${token}`,
		'x-project-id': project,
	})
	const ingest = (payload: Record<string, unknown>, token = ownerToken, project = projectId) =>
		app.inject({
			method: 'POST',
			url: '/api/v1/media/ingest',
			headers: headers(token, project),
			payload,
		})
	const session = (bytes = png.length) =>
		app.inject({
			method: 'POST',
			url: '/api/v1/media/uploads',
			headers: headers(),
			payload: { filename: 'picture.png', mimeType: 'image/png', bytes },
		})
	const pathOf = (url: string) => {
		const parsed = new URL(url)
		return `${parsed.pathname}${parsed.search}`
	}

	beforeAll(async () => {
		app = await buildTestApp()
		const short = randomUUID().slice(0, 8)
		const [owner, viewer] = await app.db
			.insert(users)
			.values([
				{ email: `media-owner-${short}@test.local`, name: 'Owner', role: 'editor' },
				{ email: `media-viewer-${short}@test.local`, name: 'Viewer', role: 'editor' },
			])
			.returning()
		ownerId = owner.id
		viewerId = viewer.id
		const [project, other] = await app.db
			.insert(projects)
			.values([
				{ name: 'Media', slug: `media-${short}`, ownerId },
				{ name: 'Other media', slug: `media-other-${short}`, ownerId },
			])
			.returning()
		projectId = project.id
		otherProjectId = other.id
		await app.db.insert(projectMembers).values([
			{ projectId, userId: ownerId, role: 'owner' },
			{ projectId: otherProjectId, userId: ownerId, role: 'owner' },
			{ projectId, userId: viewerId, role: 'viewer' },
		])
		ownerToken = await createJwt({
			id: ownerId,
			email: owner.email,
			name: owner.name,
			role: owner.role,
		})
		viewerToken = await createJwt({
			id: viewerId,
			email: viewer.email,
			name: viewer.name,
			role: viewer.role,
		})
		vi.stubGlobal(
			'fetch',
			vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
				const url = String(input instanceof Request ? input.url : input)
				if (url.startsWith('https://api.cloudflare.com/')) {
					uploads++
					if (failProvider)
						return Response.json(
							{ success: false, errors: [{ message: 'provider unavailable' }] },
							{ status: 503 },
						)
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
				if (url.startsWith('https://source.test/')) {
					if (url.endsWith('/403')) return new Response(null, { status: 403 })
					if (url.endsWith('/404')) return new Response(null, { status: 404 })
					if (url.endsWith('/oversize'))
						return new Response(Buffer.alloc(11 * 1024 * 1024), {
							headers: { 'content-length': '1' },
						})
					return new Response(png, { headers: { 'content-type': 'image/png' } })
				}
				return originalFetch(input, init)
			}),
		)
	})

	it.each([
		['403', /403/],
		['404', /404/],
		['timeout', /timeout|timed out/i],
		['redirect-loop', /redirect/i],
		['private-redirect', /private|blocked/i],
		['oversize', /large|limit|size|bytes/i],
	])('reports source failure %s without uploading (F01/F03)', async (path, message) => {
		const before = uploads
		const response = await ingest({ sourceUrl: `https://source.test/${path}` })
		expect(response.statusCode, response.body).toBeGreaterThanOrEqual(400)
		expect(response.body).toMatch(message)
		expect(uploads).toBe(before)
	})

	it('ingests an extensionless source using sniffed bytes', async () => {
		const result = await ingest({ sourceUrl: 'https://source.test/no-extension', force: true })
		expect(result.statusCode, result.body).toBeLessThan(300)
		expect(result.json().mimeType).toBe('image/png')
		expect(result.json().filename).toMatch(/\.png$/)
	})

	afterAll(async () => {
		vi.unstubAllGlobals()
		if (projectId)
			await app.db.delete(projects).where(inArray(projects.id, [projectId, otherProjectId]))
		if (ownerId) await app.db.delete(users).where(inArray(users.id, [ownerId, viewerId]))
		await app?.close()
	})

	it('reports target and permits a viewer to inspect it but not upload (F06)', async () => {
		const target = await app.inject({
			method: 'GET',
			url: '/api/v1/media/upload-target',
			headers: headers(viewerToken),
		})
		expect(target.statusCode).toBe(200)
		expect(target.json().resolved.kind).toBe('library')
		expect(target.json().canUpload).toBe(false)
		const result = await ingest(
			{ data: png.toString('base64'), mimeType: 'image/png' },
			viewerToken,
		)
		expect(result.statusCode).toBe(403)
	})

	it.each([
		['no source', {}],
		['two sources', { data: png.toString('base64'), sourceUrl: 'https://source.test/image' }],
		['unsupported bytes', { data: Buffer.from('not an image').toString('base64') }],
		['invalid base64', { data: 'not base64!!', mimeType: 'image/png' }],
		['empty image', { data: '', mimeType: 'image/png' }],
		[
			'SVG',
			{
				data: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>').toString('base64'),
				mimeType: 'image/svg+xml',
			},
		],
		[
			'corrupt image',
			{
				data: Buffer.from('89504e470d0a1a0a0000', 'hex').toString('base64'),
				mimeType: 'image/png',
			},
		],
		['mismatched type', { data: png.toString('base64'), mimeType: 'image/jpeg' }],
		[
			'over 1 MiB',
			{ data: Buffer.alloc(1024 * 1024 + 1).toString('base64'), mimeType: 'image/png' },
		],
	])('rejects %s without provider upload (F02/F04)', async (_label, payload) => {
		const before = uploads
		const result = await ingest(payload)
		expect(result.statusCode, result.body).toBeGreaterThanOrEqual(400)
		expect(result.statusCode, result.body).toBeLessThan(500)
		expect(result.body.length).toBeGreaterThan(0)
		expect(uploads).toBe(before)
	})

	it('deduplicates concurrent identical ingests and returns a renderable URL (F09)', async () => {
		const before = uploads
		const payload = {
			data: Buffer.concat([png, Buffer.from('parallel')]).toString('base64'),
			mimeType: 'image/png',
			filename: 'picture.png',
		}
		const responses = await Promise.all([ingest(payload), ingest(payload)])
		for (const response of responses) expect(response.statusCode, response.body).toBeLessThan(300)
		const results = responses.map((response) => response.json())
		expect(uploads - before).toBe(1)
		expect(results[0].id).toBe(results[1].id)
		expect(results.map((result) => result.duplicate).sort()).toEqual([false, true])
		expect(results[0].deliveryUrl).toMatch(/^https:\/\/imagedelivery\.net\/[^/]+\/[^/]+\/[^/]+$/)
		expect(results[0].deliveryVerified).toBe(true)
	})

	it('reapplies production DDL safely and preserves required ledger and session columns', async () => {
		await ensureTables(TEST_DB_URL ?? '')
		await ensureTables(TEST_DB_URL ?? '')
		const rows = await app.db.execute(
			sql`SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name IN ('media_ingest_ledger', 'media_upload_sessions')`,
		)
		const columns = Array.from(rows) as Array<{ table_name: string; column_name: string }>
		for (const [tableName, required] of [
			[
				'media_ingest_ledger',
				[
					'projectId',
					'targetKey',
					'sha256',
					'status',
					'claimId',
					'result',
					'mediaId',
					'contentId',
					'externalId',
					'updatedAt',
				],
			],
			[
				'media_upload_sessions',
				[
					'id',
					'projectId',
					'userId',
					'filename',
					'mimeType',
					'bytes',
					'tokenHash',
					'status',
					'expiresAt',
					'data',
					'result',
				],
			],
		] as const) {
			expect(
				columns.filter((row) => row.table_name === tableName).map((row) => row.column_name),
			).toEqual(expect.arrayContaining([...required]))
		}
		const indexes = await app.db.execute(
			sql`SELECT indexdef FROM pg_indexes WHERE schemaname = current_schema() AND tablename = 'media_ingest_ledger'`,
		)
		expect(
			Array.from(indexes).some((row) =>
				/UNIQUE.*projectId.*targetKey.*sha256/i.test(String(row.indexdef)),
			),
		).toBe(true)
	})

	it('takes over a stale pending claim and reuploads after a done record is deleted (F09)', async () => {
		const bytes = Buffer.concat([png, Buffer.from('stale-claim')])
		const sha = createHash('sha256').update(bytes).digest('hex')
		await app.db.execute(
			sql`INSERT INTO media_ingest_ledger ("projectId", "targetKey", sha256, status, "claimId", "updatedAt") VALUES (${projectId}, 'library', ${sha}, 'pending', ${randomUUID()}, now() - interval '6 minutes')`,
		)
		const payload = { data: bytes.toString('base64'), mimeType: 'image/png' }
		const before = uploads
		const first = await ingest(payload)
		expect(first.statusCode, first.body).toBeLessThan(300)
		expect(first.json().duplicate).toBe(false)
		expect(uploads - before).toBe(1)
		await app.db.delete(media).where(eq(media.id, first.json().id))
		const again = await ingest(payload)
		expect(again.statusCode, again.body).toBeLessThan(300)
		expect(again.json().duplicate).toBe(false)
		expect(again.json().id).not.toBe(first.json().id)
		expect(uploads - before).toBe(2)
	})

	it('force bypasses dedupe and separate projects have independent receipts (F09)', async () => {
		const bytes = Buffer.concat([png, Buffer.from('scope-and-force')])
		const payload = { data: bytes.toString('base64'), mimeType: 'image/png' }
		const before = uploads
		const first = await ingest(payload)
		const other = await ingest(payload, ownerToken, otherProjectId)
		const forced = await ingest({ ...payload, force: true })
		for (const result of [first, other, forced])
			expect(result.statusCode, result.body).toBeLessThan(300)
		expect(new Set([first.json().id, other.json().id, forced.json().id]).size).toBe(3)
		expect([first.json().duplicate, other.json().duplicate, forced.json().duplicate]).toEqual([
			false,
			false,
			false,
		])
		expect(uploads - before).toBe(3)
	})

	it('validates and persists media upload settings and defaults', async () => {
		const put = (mediaUploads: Record<string, unknown>) =>
			app.inject({
				method: 'PUT',
				url: `/api/v1/projects/${projectId}`,
				headers: headers(),
				payload: { settings: { mediaUploads } },
			})
		for (const invalid of [
			{ target: 'collection' },
			{ target: 'library', fields: { alt: 'bad.column' } },
			{ target: 'library', deliveryVariant: '../private' },
		]) {
			const response = await put(invalid)
			expect(response.statusCode, response.body).toBe(400)
		}
		const valid = { target: 'library', fields: { alt: 'altText' }, deliveryVariant: 'public' }
		const response = await put(valid)
		expect(response.statusCode, response.body).toBe(200)
		const [project] = await app.db.select().from(projects).where(eq(projects.id, projectId))
		expect((project.settings as unknown as Record<string, unknown>).mediaUploads).toMatchObject(
			valid,
		)
		const target = await app.inject({
			method: 'GET',
			url: '/api/v1/media/upload-target',
			headers: headers(),
		})
		expect(target.json().setting).toMatchObject({ ...valid, collectionId: null })
	})

	it('edits library alt text and rejects a stale expected hash', async () => {
		const bytes = Buffer.concat([png, Buffer.from('library-alt')])
		const uploaded = await ingest({
			data: bytes.toString('base64'),
			mimeType: 'image/png',
			alt: 'Initial',
		})
		expect(uploaded.statusCode, uploaded.body).toBeLessThan(300)
		const id = uploaded.json().id
		const update = (payload: Record<string, unknown>) =>
			app.inject({ method: 'PATCH', url: `/api/v1/media/items/${id}`, headers: headers(), payload })
		const edited = await update({ alt: 'Updated' })
		expect(edited.statusCode, edited.body).toBeLessThan(300)
		const conflict = await update({ alt: 'Stale', expectedHash: `sha256:${'0'.repeat(64)}` })
		expect(conflict.statusCode, conflict.body).toBe(409)
		const [row] = await app.db.select().from(media).where(eq(media.id, id))
		expect(row.alt).toBe('Updated')
	})

	it('releases the receipt after a provider failure and retries successfully (F07)', async () => {
		const bytes = Buffer.concat([png, Buffer.from('provider-failure')])
		const sha = createHash('sha256').update(bytes).digest('hex')
		const payload = { data: bytes.toString('base64'), mimeType: 'image/png' }
		failProvider = true
		try {
			const failed = await ingest(payload)
			expect(failed.statusCode, failed.body).toBeGreaterThanOrEqual(400)
			expect(failed.body).toMatch(/provider|upload|cloudflare/i)
			const rows = await app.db.execute(
				sql`SELECT status FROM media_ingest_ledger WHERE "projectId" = ${projectId} AND sha256 = ${sha}`,
			)
			expect(
				Array.from(rows).every((row) => row.status !== 'done' && row.status !== 'pending'),
			).toBe(true)
		} finally {
			failProvider = false
		}
		const retry = await ingest(payload)
		expect(retry.statusCode, retry.body).toBeLessThan(300)
		expect(retry.json().duplicate).toBe(false)
	})

	it('admin multipart upload remains non-deduplicating and creates an agent receipt (F13)', async () => {
		const bytes = Buffer.concat([png, Buffer.from('admin-receipt')])
		const boundary = `media-${randomUUID()}`
		const body = Buffer.concat([
			Buffer.from(
				`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="human.png"\r\nContent-Type: image/png\r\n\r\n`,
			),
			bytes,
			Buffer.from(`\r\n--${boundary}--\r\n`),
		])
		const upload = () =>
			app.inject({
				method: 'POST',
				url: '/api/v1/media/upload',
				headers: { ...headers(), 'content-type': `multipart/form-data; boundary=${boundary}` },
				payload: body,
			})
		const first = await upload()
		expect(first.statusCode, first.body).toBeLessThan(300)
		const agent = await ingest({ data: bytes.toString('base64'), mimeType: 'image/png' })
		expect(agent.statusCode, agent.body).toBeLessThan(300)
		expect(agent.json().duplicate).toBe(true)
		expect(agent.json().id).toBe(first.json().id)
		const second = await upload()
		expect(second.statusCode, second.body).toBeLessThan(300)
		expect(second.json().id).not.toBe(first.json().id)
	})

	it('enforces the capability token, declared length, project and completion state (F10)', async () => {
		const firstBytes = Buffer.concat([png, Buffer.from([1])])
		const replacementBytes = Buffer.concat([png, Buffer.from([2])])
		const created = await session(firstBytes.length)
		expect(created.statusCode, created.body).toBeLessThan(300)
		const data = created.json()
		expect(data.method).toBe('PUT')
		const url = pathOf(data.uploadUrl)
		const badUrl = new URL(data.uploadUrl)
		badUrl.searchParams.set('token', 'wrong')
		const wrong = await app.inject({
			method: 'PUT',
			url: pathOf(badUrl.toString()),
			headers: { 'content-type': 'image/png' },
			payload: png,
		})
		expect([404, 410]).toContain(wrong.statusCode)
		const early = await app.inject({
			method: 'POST',
			url: `/api/v1/media/uploads/${data.uploadId}/complete`,
			headers: headers(),
			payload: {},
		})
		expect(early.statusCode).toBeGreaterThanOrEqual(400)
		const large = await app.inject({
			method: 'PUT',
			url,
			headers: { 'content-type': 'image/png' },
			payload: Buffer.concat([firstBytes, Buffer.from('x')]),
		})
		expect(large.statusCode).toBeGreaterThanOrEqual(400)
		const put = await app.inject({
			method: 'PUT',
			url,
			headers: { 'content-type': 'image/png' },
			payload: firstBytes,
		})
		expect(put.statusCode, put.body).toBe(200)
		expect(put.json().bytes).toBe(firstBytes.length)
		const putAgain = await app.inject({
			method: 'PUT',
			url,
			headers: { 'content-type': 'application/octet-stream' },
			payload: replacementBytes,
		})
		expect(putAgain.statusCode, putAgain.body).toBe(200)
		expect(putAgain.json().sha256).toBe(createHash('sha256').update(replacementBytes).digest('hex'))
		expect(putAgain.json().sha256).not.toBe(put.json().sha256)
		const foreign = await app.inject({
			method: 'POST',
			url: `/api/v1/media/uploads/${data.uploadId}/complete`,
			headers: headers(ownerToken, otherProjectId),
			payload: {},
		})
		expect(foreign.statusCode).toBeGreaterThanOrEqual(400)
		await app.db
			.update(projectMembers)
			.set({ role: 'editor' })
			.where(and(eq(projectMembers.projectId, projectId), eq(projectMembers.userId, viewerId)))
		try {
			const otherUser = await app.inject({
				method: 'POST',
				url: `/api/v1/media/uploads/${data.uploadId}/complete`,
				headers: headers(viewerToken),
				payload: {},
			})
			expect(otherUser.statusCode).toBeGreaterThanOrEqual(400)
		} finally {
			await app.db
				.update(projectMembers)
				.set({ role: 'viewer' })
				.where(and(eq(projectMembers.projectId, projectId), eq(projectMembers.userId, viewerId)))
		}
		const complete = () =>
			app.inject({
				method: 'POST',
				url: `/api/v1/media/uploads/${data.uploadId}/complete`,
				headers: headers(),
				payload: { alt: 'A pixel' },
			})
		const [first, second] = await Promise.all([complete(), complete()])
		expect(first.statusCode, first.body).toBeLessThan(300)
		expect(second.statusCode, second.body).toBeLessThan(300)
		expect(second.json()).toEqual(first.json())
		expect(first.json().sha256).toBe(putAgain.json().sha256)
	})

	it('rejects an expired capability before accepting the body (F10)', async () => {
		const created = await session()
		expect(created.statusCode, created.body).toBeLessThan(300)
		const data = created.json()
		await app.db.execute(
			sql`UPDATE media_upload_sessions SET "expiresAt" = now() - interval '1 minute' WHERE id = ${data.uploadId}`,
		)
		const result = await app.inject({
			method: 'PUT',
			url: pathOf(data.uploadUrl),
			headers: { 'content-type': 'image/png' },
			payload: png,
		})
		expect([404, 410]).toContain(result.statusCode)
		const rows = await app.db.execute(
			sql`SELECT data FROM media_upload_sessions WHERE id = ${data.uploadId}`,
		)
		expect(Array.from(rows).every((row) => row.data == null)).toBe(true)
	})
})

describe.skipIf(!hasTestDb)(
	'collection media ingest (real Postgres source)',
	{ timeout: 30_000 },
	() => {
		let app: FastifyInstance
		let source: postgres.Sql
		let projectId: string
		let userId: string
		let token: string
		let collectionId: string
		let initialSettings: Record<string, unknown>
		const table = `media_src_${randomUUID().slice(0, 8)}`
		const headers = () => ({ authorization: `Bearer ${token}`, 'x-project-id': projectId })

		beforeAll(async () => {
			app = await buildTestApp()
			source = postgres(TEST_DB_URL ?? '', { onnotice: () => {} })
			await source`CREATE TABLE ${source(table)} (id serial PRIMARY KEY, "fullPath" text NOT NULL, filename text UNIQUE, alt text, "mimeType" text, filesize integer, width integer, height integer, "createdAt" timestamptz, "updatedAt" timestamptz)`
			const short = randomUUID().slice(0, 8)
			const [user] = await app.db
				.insert(users)
				.values({ email: `media-external-${short}@test.local`, name: 'Owner', role: 'editor' })
				.returning()
			userId = user.id
			const [project] = await app.db
				.insert(projects)
				.values({
					name: 'External media',
					slug: `media-external-${short}`,
					ownerId: userId,
					settings: {
						externalDb: {
							type: 'postgresql',
							connectionString: TEST_DB_URL,
							accessMode: 'read-write',
							mediaStorage: {
								[table]: {
									adapter: 'cloudflare-images',
									pathColumn: 'fullPath',
									access: 'private',
									credentials: {
										accountId: 'test-account',
										apiToken: 'test-token',
										accountHash: 'test-hash',
									},
								},
							},
						},
					} as never,
				})
				.returning()
			projectId = project.id
			initialSettings = project.settings as unknown as Record<string, unknown>
			await app.db.insert(projectMembers).values({ projectId, userId, role: 'owner' })
			const [collection] = await app.db
				.insert(collections)
				.values({
					projectId,
					name: table,
					label: 'Media',
					source: 'external',
					externalTable: table,
					accessMode: 'read-write',
					fields: [
						{ name: 'fullPath', type: 'text' },
						{ name: 'filename', type: 'text' },
						{ name: 'alt', type: 'text' },
						{ name: 'mimeType', type: 'text' },
						{ name: 'filesize', type: 'number' },
						{ name: 'width', type: 'number' },
						{ name: 'height', type: 'number' },
						{ name: 'createdAt', type: 'date' },
						{ name: 'updatedAt', type: 'date' },
					],
				})
				.returning()
			collectionId = collection.id
			token = await createJwt({ id: userId, email: user.email, name: user.name, role: user.role })
			vi.stubGlobal(
				'fetch',
				vi.fn(async (input: string | URL | Request) => {
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
					if (url.startsWith('https://imagedelivery.net/'))
						return new Response(null, { status: 200 })
					throw new Error(`Unexpected network request: ${url}`)
				}),
			)
		})

		afterAll(async () => {
			vi.unstubAllGlobals()
			if (projectId) await app.db.delete(projects).where(eq(projects.id, projectId))
			if (userId) await app.db.delete(users).where(eq(users.id, userId))
			if (source) {
				await source`DROP TABLE IF EXISTS ${source(table)}`
				await source.end()
			}
			await app?.close()
		})

		it('writes alt and timestamps to the source and returns its relation-ready ID (F12)', async () => {
			const target = await app.inject({
				method: 'GET',
				url: '/api/v1/media/upload-target',
				headers: headers(),
			})
			expect(target.statusCode, target.body).toBe(200)
			expect(target.json().resolved).toMatchObject({
				kind: 'collection',
				collectionId,
				fields: { path: 'fullPath', alt: 'alt' },
			})
			const upload = await app.inject({
				method: 'POST',
				url: '/api/v1/media/ingest',
				headers: headers(),
				payload: {
					data: png.toString('base64'),
					filename: 'chart.png',
					alt: 'Chart alternative text',
					mimeType: 'image/png',
				},
			})
			expect(upload.statusCode, upload.body).toBeLessThan(300)
			const result = upload.json()
			expect(result.target).toMatchObject({ kind: 'collection', collectionId })
			expect(result.externalId).toBeTruthy()
			const [row] =
				await source`SELECT * FROM ${source(table)} WHERE id = ${Number(result.externalId)}`
			expect(row.alt).toBe('Chart alternative text')
			expect(row.fullPath).toBe(result.fullPath)
			expect(row.createdAt).toBeTruthy()
			expect(row.updatedAt).toBeTruthy()
			const [cached] = await app.db.select().from(content).where(eq(content.id, result.id))
			expect(cached.externalId).toBe(result.externalId)
			const edit = await app.inject({
				method: 'PATCH',
				url: `/api/v1/media/items/${result.externalId}`,
				headers: headers(),
				payload: { alt: 'Updated alt' },
			})
			expect(edit.statusCode, edit.body).toBeLessThan(300)
			const [updated] =
				await source`SELECT alt FROM ${source(table)} WHERE id = ${Number(result.externalId)}`
			expect(updated.alt).toBe('Updated alt')
		})

		it('fails closed for ambiguous, read-only and non-writable targets (F05)', async () => {
			const secondName = `${table}_other`
			const [second] = await app.db
				.insert(collections)
				.values({
					projectId,
					name: secondName,
					label: 'Other media',
					source: 'external',
					externalTable: secondName,
					accessMode: 'read-write',
					fields: [{ name: 'fullPath', type: 'text' }],
				})
				.returning()
			const externalDb = initialSettings.externalDb as Record<string, unknown>
			const storage = externalDb.mediaStorage as Record<string, unknown>
			const settings = (
				mediaUploads: Record<string, unknown>,
				mediaStorage: Record<string, unknown>,
			) =>
				({ ...initialSettings, mediaUploads, externalDb: { ...externalDb, mediaStorage } }) as never
			const target = () =>
				app.inject({ method: 'GET', url: '/api/v1/media/upload-target', headers: headers() })
			const ingest = () =>
				app.inject({
					method: 'POST',
					url: '/api/v1/media/ingest',
					headers: headers(),
					payload: { data: png.toString('base64'), mimeType: 'image/png' },
				})
			try {
				await app.db
					.update(projects)
					.set({
						settings: settings({ target: 'auto' }, { ...storage, [secondName]: storage[table] }),
					})
					.where(eq(projects.id, projectId))
				const ambiguous = await target()
				expect(ambiguous.json().resolved.kind).toBeNull()
				expect(ambiguous.json().problem).toMatch(/ambig|multiple|collectionId/i)
				expect(ambiguous.json().candidates.map((item: { id: string }) => item.id)).toEqual(
					expect.arrayContaining([collectionId, second.id]),
				)
				expect((await ingest()).statusCode).toBeGreaterThanOrEqual(400)
				await app.db
					.update(collections)
					.set({ accessMode: 'read-only' })
					.where(eq(collections.id, collectionId))
				await app.db
					.update(projects)
					.set({ settings: settings({ target: 'collection', collectionId }, storage) })
					.where(eq(projects.id, projectId))
				const readonly = await target()
				expect(readonly.json().canUpload).toBe(false)
				expect(readonly.json().problem).toMatch(/read.only/i)
				expect((await ingest()).statusCode).toBeGreaterThanOrEqual(400)
				await app.db
					.update(collections)
					.set({ accessMode: 'read-write' })
					.where(eq(collections.id, collectionId))
				await app.db
					.update(projects)
					.set({
						settings: settings(
							{ target: 'collection', collectionId },
							{ ...storage, [table]: { adapter: 'absolute', pathColumn: 'fullPath' } },
						),
					})
					.where(eq(projects.id, projectId))
				const unwritable = await target()
				expect(unwritable.json().canUpload).toBe(false)
				expect(unwritable.json().problem).toMatch(/writ|storage/i)
				expect((await ingest()).statusCode).toBeGreaterThanOrEqual(400)
			} finally {
				await app.db
					.update(collections)
					.set({ accessMode: 'read-write' })
					.where(eq(collections.id, collectionId))
				await app.db
					.update(projects)
					.set({ settings: initialSettings as never })
					.where(eq(projects.id, projectId))
				await app.db.delete(collections).where(eq(collections.id, second.id))
			}
		})

		it('clears the receipt after external insertion fails, allowing retry (F07)', async () => {
			const bytes = Buffer.concat([png, Buffer.from('external-failure')])
			const sha = createHash('sha256').update(bytes).digest('hex')
			const payload = {
				data: bytes.toString('base64'),
				filename: 'refused.png',
				mimeType: 'image/png',
				alt: 'rejected',
			}
			await source`ALTER TABLE ${source(table)} ADD CONSTRAINT reject_test_alt CHECK (alt IS DISTINCT FROM 'rejected')`
			try {
				const failed = await app.inject({
					method: 'POST',
					url: '/api/v1/media/ingest',
					headers: headers(),
					payload,
				})
				expect(failed.statusCode, failed.body).toBeGreaterThanOrEqual(400)
				const rows = await app.db.execute(
					sql`SELECT status FROM media_ingest_ledger WHERE "projectId" = ${projectId} AND sha256 = ${sha}`,
				)
				expect(
					Array.from(rows).every((row) => row.status !== 'done' && row.status !== 'pending'),
				).toBe(true)
			} finally {
				await source`ALTER TABLE ${source(table)} DROP CONSTRAINT reject_test_alt`
			}
			const retry = await app.inject({
				method: 'POST',
				url: '/api/v1/media/ingest',
				headers: headers(),
				payload,
			})
			expect(retry.statusCode, retry.body).toBeLessThan(300)
			expect(retry.json().duplicate).toBe(false)
		})

		it('retries a source filename unique violation with a distinct name (F08)', async () => {
			await source`INSERT INTO ${source(table)} ("fullPath", filename) VALUES ('https://example.test/existing', 'collision.png')`
			const bytes = Buffer.concat([png, Buffer.from('filename-collision')])
			const result = await app.inject({
				method: 'POST',
				url: '/api/v1/media/ingest',
				headers: headers(),
				payload: {
					data: bytes.toString('base64'),
					mimeType: 'image/png',
					filename: 'collision.png',
				},
			})
			expect(result.statusCode, result.body).toBeLessThan(300)
			expect(result.json().filename).not.toBe('collision.png')
			const rows =
				await source`SELECT filename FROM ${source(table)} WHERE id = ${Number(result.json().externalId)}`
			expect(rows[0].filename).toBe(result.json().filename)
		})

		it('keeps dedupe receipts separate for library and collection targets (F09)', async () => {
			const bytes = Buffer.concat([png, Buffer.from('two-targets')])
			const payload = {
				data: bytes.toString('base64'),
				mimeType: 'image/png',
				filename: 'two-targets.png',
			}
			const ingest = () =>
				app.inject({ method: 'POST', url: '/api/v1/media/ingest', headers: headers(), payload })
			try {
				await app.db
					.update(projects)
					.set({ settings: { ...initialSettings, mediaUploads: { target: 'library' } } as never })
					.where(eq(projects.id, projectId))
				const library = await ingest()
				expect(library.statusCode, library.body).toBeLessThan(300)
				expect(library.json().target.kind).toBe('library')
				await app.db
					.update(projects)
					.set({
						settings: {
							...initialSettings,
							mediaUploads: { target: 'collection', collectionId },
						} as never,
					})
					.where(eq(projects.id, projectId))
				const collection = await ingest()
				expect(collection.statusCode, collection.body).toBeLessThan(300)
				expect(collection.json().target.kind).toBe('collection')
				expect(collection.json().duplicate).toBe(false)
				expect(collection.json().id).not.toBe(library.json().id)
				const duplicate = await ingest()
				expect(duplicate.statusCode, duplicate.body).toBeLessThan(300)
				expect(duplicate.json().id).toBe(collection.json().id)
				expect(duplicate.json().duplicate).toBe(true)
			} finally {
				await app.db
					.update(projects)
					.set({ settings: initialSettings as never })
					.where(eq(projects.id, projectId))
			}
		})

		it('edits an uncached source ID and rejects a stale expected hash (F12)', async () => {
			const [row] =
				await source`INSERT INTO ${source(table)} ("fullPath", filename, alt) VALUES ('https://example.test/uncached.png', 'uncached.png', 'Old alt') RETURNING id`
			const externalId = String(row.id)
			const cached = await app.db
				.select()
				.from(content)
				.where(and(eq(content.collectionId, collectionId), eq(content.externalId, externalId)))
			expect(cached).toHaveLength(0)
			const edit = (payload: Record<string, unknown>) =>
				app.inject({
					method: 'PATCH',
					url: `/api/v1/media/items/${externalId}`,
					headers: headers(),
					payload,
				})
			const updated = await edit({ alt: 'New alt' })
			expect(updated.statusCode, updated.body).toBeLessThan(300)
			const conflict = await edit({ alt: 'Stale alt', expectedHash: `sha256:${'0'.repeat(64)}` })
			expect(conflict.statusCode, conflict.body).toBe(409)
			const [after] = await source`SELECT alt FROM ${source(table)} WHERE id = ${row.id}`
			expect(after.alt).toBe('New alt')
		})

		it('preserves imported admin multipart behavior and records an agent receipt (F13)', async () => {
			const bytes = Buffer.concat([png, Buffer.from('imported-admin-receipt')])
			const boundary = `media-${randomUUID()}`
			const body = Buffer.concat([
				Buffer.from(
					`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="admin-collection.png"\r\nContent-Type: image/png\r\n\r\n`,
				),
				bytes,
				Buffer.from(`\r\n--${boundary}--\r\n`),
			])
			const upload = () =>
				app.inject({
					method: 'POST',
					url: `/api/v1/projects/${projectId}/database/media-upload?collectionId=${collectionId}`,
					headers: { ...headers(), 'content-type': `multipart/form-data; boundary=${boundary}` },
					payload: body,
				})
			const first = await upload()
			expect(first.statusCode, first.body).toBeLessThan(300)
			const created = first.json()
			expect(created.id).toBeTruthy()
			expect(created.externalId).toBeTruthy()
			expect(created.metadata).toMatchObject({
				filename: 'admin-collection.png',
				fullPath: expect.any(String),
			})
			const [sourceRow] =
				await source`SELECT * FROM ${source(table)} WHERE id = ${Number(created.externalId)}`
			expect(sourceRow.fullPath).toBe(created.metadata.fullPath)
			expect(sourceRow.filename).toBe(created.metadata.filename)
			expect(sourceRow.alt).toBeNull()
			expect(sourceRow.createdAt).toBeNull()
			expect(sourceRow.updatedAt).toBeNull()
			const [cached] = await app.db.select().from(content).where(eq(content.id, created.id))
			expect(cached.externalId).toBe(created.externalId)
			const agent = await app.inject({
				method: 'POST',
				url: '/api/v1/media/ingest',
				headers: headers(),
				payload: { data: bytes.toString('base64'), mimeType: 'image/png' },
			})
			expect(agent.statusCode, agent.body).toBeLessThan(300)
			expect(agent.json()).toMatchObject({
				id: created.id,
				externalId: created.externalId,
				duplicate: true,
			})
			const second = await upload()
			expect(second.statusCode, second.body).toBeLessThan(300)
			expect(second.json().id).not.toBe(created.id)
			expect(second.json().externalId).not.toBe(created.externalId)
			expect(second.json().metadata.filename).not.toBe(created.metadata.filename)
			const [secondRow] =
				await source`SELECT filename FROM ${source(table)} WHERE id = ${Number(second.json().externalId)}`
			expect(secondRow.filename).toBe(second.json().metadata.filename)
		})

		it('does not reuse a deleted source record even when its cached content remains (F09)', async () => {
			const bytes = Buffer.concat([png, Buffer.from('deleted-external-record')])
			const payload = {
				data: bytes.toString('base64'),
				mimeType: 'image/png',
				filename: 'deleted-source.png',
			}
			const ingest = () =>
				app.inject({ method: 'POST', url: '/api/v1/media/ingest', headers: headers(), payload })
			const first = await ingest()
			expect(first.statusCode, first.body).toBeLessThan(300)
			const previous = first.json()
			await source`DELETE FROM ${source(table)} WHERE id = ${Number(previous.externalId)}`
			const [stale] = await app.db.select().from(content).where(eq(content.id, previous.id))
			expect(stale.externalId).toBe(previous.externalId)
			const second = await ingest()
			expect(second.statusCode, second.body).toBeLessThan(300)
			expect(second.json().duplicate).toBe(false)
			expect(second.json().externalId).not.toBe(previous.externalId)
			const [replacement] =
				await source`SELECT id FROM ${source(table)} WHERE id = ${Number(second.json().externalId)}`
			expect(replacement).toBeDefined()
		})
	},
)
