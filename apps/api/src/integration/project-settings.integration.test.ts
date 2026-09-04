import { randomUUID } from 'node:crypto'
import { projectMembers, projects, users } from '@innolope/db'
import { eq } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createJwt } from '../plugins/auth.js'
import { buildTestApp, hasTestDb } from '../test/harness.js'

describe.skipIf(!hasTestDb)('project membership and settings guards (real Postgres)', () => {
	let app: FastifyInstance
	let projectId: string
	let ownerId: string
	let adminId: string
	let ownerToken: string
	let adminToken: string

	const as = (token: string) => ({ authorization: `Bearer ${token}`, 'x-project-id': projectId })

	beforeAll(async () => {
		app = await buildTestApp()
		const short = randomUUID().slice(0, 8)
		const [owner] = await app.db
			.insert(users)
			.values({ email: `po-${short}@example.com`, name: 'Owner', role: 'editor' })
			.returning()
		const [admin] = await app.db
			.insert(users)
			.values({ email: `pa-${short}@example.com`, name: 'Admin', role: 'editor' })
			.returning()
		ownerId = owner.id
		adminId = admin.id
		const [p] = await app.db
			.insert(projects)
			.values({ name: 'Guards', slug: `guards-${short}`, ownerId })
			.returning()
		projectId = p.id
		await app.db.insert(projectMembers).values([
			{ projectId, userId: ownerId, role: 'owner' },
			{ projectId, userId: adminId, role: 'admin' },
		])
		ownerToken = await createJwt({ id: ownerId, email: owner.email, name: 'Owner', role: 'editor' })
		adminToken = await createJwt({ id: adminId, email: admin.email, name: 'Admin', role: 'editor' })
	})

	afterAll(async () => {
		await app.db.delete(projects).where(eq(projects.id, projectId))
		await app.db.delete(users).where(eq(users.id, ownerId))
		await app.db.delete(users).where(eq(users.id, adminId))
		await app?.close()
	})

	it('an admin can neither become owner nor demote the owner', async () => {
		const promote = await app.inject({
			method: 'PUT',
			url: `/api/v1/projects/${projectId}/members/${adminId}`,
			headers: as(adminToken),
			payload: { role: 'owner' },
		})
		expect(promote.statusCode).toBe(403)
		const demote = await app.inject({
			method: 'PUT',
			url: `/api/v1/projects/${projectId}/members/${ownerId}`,
			headers: as(adminToken),
			payload: { role: 'viewer' },
		})
		expect(demote.statusCode).toBe(403)
		const rows = await app.db
			.select({ userId: projectMembers.userId, role: projectMembers.role })
			.from(projectMembers)
			.where(eq(projectMembers.projectId, projectId))
		expect(rows.find((r) => r.userId === adminId)?.role).toBe('admin')
		expect(rows.find((r) => r.userId === ownerId)?.role).toBe('owner')
	})

	it('the last owner cannot be demoted even by themselves', async () => {
		const res = await app.inject({
			method: 'PUT',
			url: `/api/v1/projects/${projectId}/members/${ownerId}`,
			headers: as(ownerToken),
			payload: { role: 'admin' },
		})
		expect(res.statusCode).toBe(400)
	})

	it('refuses a saved connection string that targets a private address', async () => {
		const res = await app.inject({
			method: 'PUT',
			url: `/api/v1/projects/${projectId}`,
			headers: as(ownerToken),
			payload: {
				settings: {
					externalDb: {
						type: 'postgresql',
						connectionString: 'postgres://u:p@127.0.0.1:5432/postgres',
						tables: ['t'],
					},
				},
			},
		})
		expect(res.statusCode).toBe(400)
		const [row] = await app.db.select().from(projects).where(eq(projects.id, projectId))
		expect((row.settings as Record<string, unknown>).externalDb).toBeUndefined()
	})

	it('refuses a cover template URL on a private address and hides the token', async () => {
		const bad = await app.inject({
			method: 'PUT',
			url: `/api/v1/projects/${projectId}`,
			headers: as(ownerToken),
			payload: {
				settings: { covers: { templateUrl: 'http://169.254.169.254/x', templateToken: 't' } },
			},
		})
		expect(bad.statusCode).toBe(400)
		const ok = await app.inject({
			method: 'PUT',
			url: `/api/v1/projects/${projectId}`,
			headers: as(ownerToken),
			payload: {
				settings: { covers: { templateUrl: 'https://example.com/t', templateToken: 'bearer-x' } },
			},
		})
		expect(ok.statusCode).toBe(200)
		const covers = (ok.json().settings as Record<string, Record<string, unknown>>).covers
		expect(covers.templateToken).toBeUndefined()
		expect(covers.hasTemplateToken).toBe(true)
		// A later save without the token keeps the stored one.
		const again = await app.inject({
			method: 'PUT',
			url: `/api/v1/projects/${projectId}`,
			headers: as(ownerToken),
			payload: {
				settings: { covers: { templateUrl: 'https://example.com/t', hasTemplateToken: true } },
			},
		})
		expect(again.statusCode).toBe(200)
		const [row] = await app.db.select().from(projects).where(eq(projects.id, projectId))
		expect(
			((row.settings as Record<string, Record<string, unknown>>).covers as Record<string, string>)
				.templateToken,
		).toBeTruthy()
	})
})
