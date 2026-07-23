import { randomUUID } from 'node:crypto'
import { collections, projectMembers, projects, users } from '@innolope/db'
import { eq } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createJwt } from '../plugins/auth.js'
import { buildTestApp, hasTestDb } from '../test/harness.js'

const UK_MARKDOWN = `# Борщ

Це стаття про приготування борщу. Борщ — традиційна українська страва, яку готують з буряка, капусти та інших овочів. Подавайте зі сметаною та пампушками.`

describe.skipIf(!hasTestDb)('content locale handling (real Postgres)', () => {
	let app: FastifyInstance
	let token: string
	let projectId: string
	let collectionId: string
	let userId: string

	const authed = () => ({ authorization: `Bearer ${token}`, 'x-project-id': projectId })

	beforeAll(async () => {
		app = await buildTestApp()
		const short = randomUUID().slice(0, 8)
		const [user] = await app.db
			.insert(users)
			.values({ email: `locale-${short}@example.com`, name: 'Locale Tester', role: 'admin' })
			.returning()
		userId = user.id
		const [project] = await app.db
			.insert(projects)
			.values({
				name: 'Locale Test',
				slug: `locale-${short}`,
				ownerId: user.id,
				settings: { locales: ['en', 'uk'], defaultLocale: 'en', mediaAdapter: 'local' },
			})
			.returning()
		projectId = project.id
		await app.db.insert(projectMembers).values({ projectId, userId: user.id, role: 'admin' })
		const [col] = await app.db
			.insert(collections)
			.values({
				projectId,
				name: 'posts',
				label: 'Posts',
				fields: [{ name: 'title', type: 'text' }],
			})
			.returning()
		collectionId = col.id
		token = await createJwt({ id: user.id, email: user.email, name: user.name, role: 'admin' })
	})

	afterAll(async () => {
		if (app && projectId) await app.db.delete(projects).where(eq(projects.id, projectId))
		if (app && userId) await app.db.delete(users).where(eq(users.id, userId))
		await app?.close()
	})

	it('rejects a locale that is not configured for the project', async () => {
		const res = await app.inject({
			method: 'POST',
			url: '/api/v1/content',
			headers: authed(),
			payload: { collectionId, slug: 'fr-post', markdown: '# Bonjour', locale: 'fr' },
		})
		expect(res.statusCode).toBe(400)
		const body = res.json()
		expect(body.error).toContain('"fr" is not configured')
		expect(body.locales).toEqual(['en', 'uk'])
		expect(body.defaultLocale).toBe('en')
	})

	it('warns when Cyrillic content is filed under the default "en" locale', async () => {
		const res = await app.inject({
			method: 'POST',
			url: '/api/v1/content',
			headers: authed(),
			payload: {
				collectionId,
				slug: 'borshch-en-mistake',
				markdown: UK_MARKDOWN,
				metadata: { title: 'Борщ' },
			},
		})
		expect(res.statusCode).toBe(201)
		const body = res.json()
		expect(body.locale).toBe('en') // default applied, write not blocked
		expect(body.languageWarning).toContain('"uk"')
	})

	it('does not warn when the locale matches the content language', async () => {
		const res = await app.inject({
			method: 'POST',
			url: '/api/v1/content',
			headers: authed(),
			payload: {
				collectionId,
				slug: 'borshch-uk',
				markdown: UK_MARKDOWN,
				metadata: { title: 'Борщ' },
				locale: 'uk',
			},
		})
		expect(res.statusCode).toBe(201)
		expect(res.json().languageWarning).toBeUndefined()
	})

	it('reports per-item locale problems and warnings in bulk dryRun', async () => {
		const res = await app.inject({
			method: 'POST',
			url: '/api/v1/content/bulk',
			headers: authed(),
			payload: {
				dryRun: true,
				items: [
					{ collectionId, slug: 'bulk-fr', markdown: '# Bonjour', locale: 'fr' },
					{ collectionId, slug: 'bulk-uk-as-en', markdown: UK_MARKDOWN },
				],
			},
		})
		expect(res.statusCode).toBe(200)
		const body = res.json()
		expect(body.errors).toHaveLength(1)
		expect(body.errors[0].errors[0].field).toBe('locale')
		expect(body.warnings).toHaveLength(1)
		expect(body.warnings[0].index).toBe(1)
	})
})
