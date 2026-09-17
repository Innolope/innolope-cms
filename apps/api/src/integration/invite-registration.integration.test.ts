import { createHash, randomUUID } from 'node:crypto'
import { projectMembers, projects, users } from '@innolope/db'
import { eq, sql } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { verifyPassword } from '../plugins/auth.js'
import { buildTestApp, hasTestDb } from '../test/harness.js'

describe.skipIf(!hasTestDb)('invite-authorized registration (real Postgres)', () => {
	let app: FastifyInstance
	let inviterId: string
	let projectId: string
	const createdUserIds: string[] = []

	async function createInvite(email: string) {
		const token = randomUUID()
		const hash = createHash('sha256').update(token).digest('hex')
		await app.db.execute(
			sql`INSERT INTO invites ("projectId", email, role, "tokenHash", "invitedBy", "expiresAt")
				VALUES (${projectId}, ${email}, 'viewer', ${hash}, ${inviterId}, ${new Date(Date.now() + 3_600_000).toISOString()}::timestamptz)`,
		)
		return token
	}

	beforeAll(async () => {
		app = await buildTestApp()
		const short = randomUUID().slice(0, 8)
		const [inviter] = await app.db
			.insert(users)
			.values({ email: `invite-owner-${short}@example.com`, name: 'Invite Owner', role: 'admin' })
			.returning()
		inviterId = inviter.id
		const [project] = await app.db
			.insert(projects)
			.values({ name: 'Invite Project', slug: `invite-${short}`, ownerId: inviter.id })
			.returning()
		projectId = project.id
		await app.db.insert(projectMembers).values({ projectId, userId: inviter.id, role: 'owner' })
	})

	afterAll(async () => {
		if (!app) return
		await app.db.delete(projects).where(eq(projects.id, projectId))
		for (const id of createdUserIds) await app.db.delete(users).where(eq(users.id, id))
		await app.db.delete(users).where(eq(users.id, inviterId))
		await app.close()
	})

	it('creates the invited account, membership, and session together', async () => {
		const email = `new-member-${randomUUID().slice(0, 8)}@example.com`
		const token = await createInvite(email)
		const details = await app.inject({
			method: 'POST',
			url: '/api/v1/invites/details',
			payload: { token },
		})
		expect(details.statusCode).toBe(200)
		expect(details.json()).toEqual({ email })

		const response = await app.inject({
			method: 'POST',
			url: '/api/v1/invites/register',
			payload: { token, email, name: 'New Member', password: 'ValidPassword123' },
		})

		expect(response.statusCode).toBe(201)
		expect(response.json().projectId).toBe(projectId)
		expect(response.cookies.map((cookie) => cookie.name)).toEqual(
			expect.arrayContaining(['innolope_token', 'innolope_refresh', 'innolope_csrf']),
		)

		const [user] = await app.db.select().from(users).where(eq(users.email, email)).limit(1)
		createdUserIds.push(user.id)
		expect(await verifyPassword('ValidPassword123', user.passwordHash || '')).toBe(true)
		const [membership] = await app.db
			.select()
			.from(projectMembers)
			.where(eq(projectMembers.userId, user.id))
			.limit(1)
		expect(membership).toMatchObject({ projectId, role: 'viewer' })

		const inviteRows = await app.db.execute(
			sql`SELECT accepted FROM invites WHERE "tokenHash" = ${createHash('sha256').update(token).digest('hex')}`,
		)
		expect((inviteRows as unknown as { accepted: boolean }[])[0]?.accepted).toBe(true)
	})

	it('keeps the invite usable when registration uses the wrong email', async () => {
		const email = `right-member-${randomUUID().slice(0, 8)}@example.com`
		const token = await createInvite(email)
		const response = await app.inject({
			method: 'POST',
			url: '/api/v1/invites/register',
			payload: {
				token,
				email: `wrong-${randomUUID().slice(0, 8)}@example.com`,
				name: 'Wrong Account',
				password: 'ValidPassword123',
			},
		})

		expect(response.statusCode).toBe(400)
		expect(response.json().error).toContain('email address that was invited')
		const inviteRows = await app.db.execute(
			sql`SELECT accepted FROM invites WHERE "tokenHash" = ${createHash('sha256').update(token).digest('hex')}`,
		)
		expect((inviteRows as unknown as { accepted: boolean }[])[0]?.accepted).toBe(false)
	})
})
