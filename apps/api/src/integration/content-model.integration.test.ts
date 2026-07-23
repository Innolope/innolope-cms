import { randomUUID } from 'node:crypto'
import { collections, projectMembers, projects, users } from '@innolope/db'
import { eq } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createJwt } from '../plugins/auth.js'
import { buildTestApp, hasTestDb } from '../test/harness.js'

/**
 * Content-model contract: markdown is the OPTIONAL prose body, metadata is the
 * single source of truth for structured fields, and YAML frontmatter pasted
 * into markdown is normalized away (stripped into metadata) on write.
 */
describe.skipIf(!hasTestDb)(
	'content model: optional markdown + frontmatter (real Postgres)',
	() => {
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
				.values({ email: `model-${short}@example.com`, name: 'Model Tester', role: 'admin' })
				.returning()
			userId = user.id
			const [project] = await app.db
				.insert(projects)
				.values({ name: 'Model Test', slug: `model-${short}`, ownerId: user.id })
				.returning()
			projectId = project.id
			await app.db.insert(projectMembers).values({ projectId, userId: user.id, role: 'admin' })
			const [col] = await app.db
				.insert(collections)
				.values({
					projectId,
					name: 'things',
					label: 'Things',
					fields: [
						{ name: 'title', type: 'text' },
						{ name: 'rating', type: 'number' },
					],
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

		it('creates a data-only record without any markdown', async () => {
			const res = await app.inject({
				method: 'POST',
				url: '/api/v1/content',
				headers: authed(),
				payload: {
					collectionId,
					slug: 'data-only-record',
					metadata: { title: 'Data Only', rating: 5 },
				},
			})
			expect(res.statusCode).toBe(201)
			const body = res.json()
			expect(body.markdown).toBe('')
			expect(body.metadata).toEqual({ title: 'Data Only', rating: 5 })
		})

		it('strips YAML frontmatter into metadata on create (explicit metadata wins)', async () => {
			const res = await app.inject({
				method: 'POST',
				url: '/api/v1/content',
				headers: authed(),
				payload: {
					collectionId,
					slug: 'frontmattered-record',
					markdown: '---\ntitle: From Frontmatter\nrating: 3\n---\n\n# Hello\n\nBody.',
					metadata: { title: 'Explicit Title' },
				},
			})
			expect(res.statusCode).toBe(201)
			const body = res.json()
			expect(body.markdown).not.toContain('---')
			expect(body.markdown).toContain('# Hello')
			expect(body.metadata.title).toBe('Explicit Title')
			expect(body.metadata.rating).toBe(3)
		})

		it('normalizes frontmatter on update too', async () => {
			const created = await app.inject({
				method: 'POST',
				url: '/api/v1/content',
				headers: authed(),
				payload: { collectionId, slug: 'update-normalize', metadata: { title: 'Before' } },
			})
			expect(created.statusCode).toBe(201)
			const id = created.json().id

			const updated = await app.inject({
				method: 'PUT',
				url: `/api/v1/content/${id}`,
				headers: authed(),
				payload: { markdown: '---\nrating: 4\n---\n\nUpdated body.' },
			})
			expect(updated.statusCode).toBe(200)
			const body = updated.json()
			expect(body.markdown.trim()).toBe('Updated body.')
			expect(body.metadata.rating).toBe(4)
			expect(body.metadata.title).toBe('Before') // merged with current, not replaced
		})
	},
)
