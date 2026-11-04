import { randomUUID } from 'node:crypto'
import { mediaUploadSessions, projectMembers, projects, users } from '@innolope/db'
import { and, eq, gt, inArray, ne } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createJwt } from '../plugins/auth.js'
import { buildTestApp, hasTestDb } from '../test/harness.js'

describe.skipIf(!hasTestDb)('media session budgets and sweep (real Postgres)', () => {
	let app: FastifyInstance
	const projectIds: string[] = []
	const userIds: string[] = []
	const tokens: string[] = []
	const maxImageBytes = 10_000_000
	const maxProjectBytes = 200_000_000
	const seed = (
		user = 0,
		count = 1,
		bytes = 1,
		overrides: Partial<typeof mediaUploadSessions.$inferInsert> = {},
	) =>
		app.db
			.insert(mediaUploadSessions)
			.values(
				Array.from({ length: count }, () => ({
					projectId: projectIds[0],
					userId: userIds[user],
					filename: 'session.png',
					mimeType: 'image/png',
					bytes,
					tokenHash: randomUUID(),
					expiresAt: new Date(Date.now() + 30 * 60_000),
					updatedAt: new Date(),
					...overrides,
				})),
			)
			.returning({ id: mediaUploadSessions.id })
	const create = (user = 0, project = 0, bytes = 1) =>
		app.inject({
			method: 'POST',
			url: '/api/v1/media/uploads',
			headers: {
				authorization: `Bearer ${tokens[user]}`,
				'x-project-id': projectIds[project],
			},
			payload: { filename: 'new.png', mimeType: 'image/png', bytes },
		})
	const open = (project = 0) =>
		app.db
			.select({
				id: mediaUploadSessions.id,
				userId: mediaUploadSessions.userId,
				bytes: mediaUploadSessions.bytes,
			})
			.from(mediaUploadSessions)
			.where(
				and(
					eq(mediaUploadSessions.projectId, projectIds[project]),
					ne(mediaUploadSessions.status, 'done'),
					gt(mediaUploadSessions.expiresAt, new Date()),
				),
			)
	const assertQuota = (response: Awaited<ReturnType<typeof create>>) => {
		expect(response.statusCode, response.body).toBe(429)
		expect(response.body).toMatch(/complete|expir/i)
	}

	beforeAll(async () => {
		// Advance only registered intervals for the cleanup test. Date, socket/pool
		// timeouts and polling stay real, so expiry fixtures use the database clock.
		vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
		app = await buildTestApp()
		const suffix = randomUUID().slice(0, 8)
		const fixtureUsers = await app.db
			.insert(users)
			.values(
				['first', 'second'].map((name) => ({
					email: `session-${name}-${suffix}@test.local`,
					name,
					role: 'editor' as const,
				})),
			)
			.returning()
		for (const user of fixtureUsers) {
			userIds.push(user.id)
			tokens.push(
				await createJwt({ id: user.id, email: user.email, name: user.name, role: user.role }),
			)
		}
		const fixtureProjects = await app.db
			.insert(projects)
			.values(
				['first', 'second'].map((name) => ({
					name: `Media sessions ${name}`,
					slug: `media-sessions-${name}-${suffix}`,
					ownerId: userIds[0],
				})),
			)
			.returning()
		projectIds.push(...fixtureProjects.map((project) => project.id))
		await app.db.insert(projectMembers).values(
			projectIds.flatMap((projectId) =>
				userIds.map((userId, index) => ({
					projectId,
					userId,
					role: index === 0 ? ('owner' as const) : ('editor' as const),
				})),
			),
		)
	})

	beforeEach(async () => {
		await app.db
			.delete(mediaUploadSessions)
			.where(inArray(mediaUploadSessions.projectId, projectIds))
	})

	afterAll(async () => {
		try {
			if (projectIds.length) await app.db.delete(projects).where(inArray(projects.id, projectIds))
			if (userIds.length) await app.db.delete(users).where(inArray(users.id, userIds))
			await app?.close()
		} finally {
			vi.useRealTimers()
		}
	})

	it('R3 admits only one concurrent request for a user’s final slot and isolates users/projects', async () => {
		await seed(0, 19)
		// Independent requests represent two clients of the same authenticated user.
		const responses = await Promise.all([create(), create()])
		expect(responses.filter((response) => response.statusCode < 300)).toHaveLength(1)
		const denied = responses.filter((response) => response.statusCode >= 300)
		expect(denied).toHaveLength(1)
		assertQuota(denied[0])
		expect((await open()).filter((row) => row.userId === userIds[0])).toHaveLength(20)
		const otherUser = await create(1)
		expect(otherUser.statusCode, otherUser.body).toBeLessThan(300)
		const otherProject = await create(0, 1)
		expect(otherProject.statusCode, otherProject.body).toBeLessThan(300)
		expect(await open()).toHaveLength(21)
		expect(await open(1)).toHaveLength(1)
	})

	it('R3 serializes the project’s last byte allowance across users without exceeding 200 MB', async () => {
		await seed(0, 10, maxImageBytes)
		await seed(1, 9, maxImageBytes)
		const responses = await Promise.all([create(0, 0, maxImageBytes), create(1, 0, maxImageBytes)])
		expect(responses.filter((response) => response.statusCode < 300)).toHaveLength(1)
		const denied = responses.filter((response) => response.statusCode >= 300)
		expect(denied).toHaveLength(1)
		assertQuota(denied[0])
		const active = await open()
		expect(active).toHaveLength(20)
		expect(active.reduce((total, row) => total + row.bytes, 0)).toBe(maxProjectBytes)
		assertQuota(await create(1, 0, 1))
		expect(await open()).toHaveLength(20)
		const otherProject = await create(1, 1, maxImageBytes)
		expect(otherProject.statusCode, otherProject.body).toBeLessThan(300)
	})

	it('R3 excludes done and expired sessions while counting uploaded and processing sessions', async () => {
		await seed(0, 20, maxImageBytes, { status: 'done' })
		await seed(0, 20, maxImageBytes, { expiresAt: new Date(Date.now() - 60_000) })
		await seed(0, 17)
		await seed(0, 1, 1, { status: 'uploaded' })
		await seed(0, 1, 1, { status: 'processing' })
		const accepted = await create(0, 0, maxImageBytes)
		expect(accepted.statusCode, accepted.body).toBeLessThan(300)
		expect(await open()).toHaveLength(20)
		assertQuota(await create())
		const persisted = await app.db
			.select({ id: mediaUploadSessions.id })
			.from(mediaUploadSessions)
			.where(eq(mediaUploadSessions.projectId, projectIds[0]))
		expect(persisted).toHaveLength(60)
	})

	it('R7 preserves a fresh processing claim and removes stale expired claims and receipts', async () => {
		const past = new Date(Date.now() - 60_000)
		const stale = new Date(Date.now() - 6 * 60_000)
		const [freshProcessing] = await seed(0, 1, 1, {
			status: 'processing',
			expiresAt: past,
			updatedAt: new Date(),
		})
		const [staleProcessing] = await seed(0, 1, 1, {
			status: 'processing',
			expiresAt: past,
			updatedAt: stale,
		})
		const [expiredDone] = await seed(0, 1, 1, { status: 'done', expiresAt: past })
		const [expiredCreated] = await seed(0, 1, 1, { expiresAt: past })
		const [unexpiredProcessing] = await seed(0, 1, 1, {
			status: 'processing',
			updatedAt: stale,
		})
		const [unexpiredDone] = await seed(0, 1, 1, { status: 'done' })
		await vi.advanceTimersByTimeAsync(60_000)
		const removedIds = [staleProcessing.id, expiredDone.id, expiredCreated.id]
		await expect
			.poll(
				async () =>
					app.db
						.select({ id: mediaUploadSessions.id })
						.from(mediaUploadSessions)
						.where(inArray(mediaUploadSessions.id, removedIds)),
				{ timeout: 5_000, interval: 25 },
			)
			.toEqual([])
		const survivors = await app.db
			.select({ id: mediaUploadSessions.id })
			.from(mediaUploadSessions)
			.where(eq(mediaUploadSessions.projectId, projectIds[0]))
		expect(survivors.map((row) => row.id).sort()).toEqual(
			[freshProcessing.id, unexpiredProcessing.id, unexpiredDone.id].sort(),
		)
	})
})
