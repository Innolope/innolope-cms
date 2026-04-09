import { apiKeys, users } from '@innolope/db'
import type { FastifyInstance } from 'fastify'
import { eq, and, sql } from 'drizzle-orm'
import { randomUUID } from 'node:crypto'
import { hashApiKey, hashPassword, verifyPassword, createJwt } from '../../plugins/auth.js'

export async function authRoutes(app: FastifyInstance) {
	// Check if setup is needed (public)
	app.get('/setup-status', async () => {
		const [{ count }] = await app.db.select({ count: sql<number>`count(*)` }).from(users)
		return { needsSetup: Number(count) === 0 }
	})

	// Register first admin (only works when no users exist)
	app.post('/register', async (request, reply) => {
		const { email, password, name } = request.body as { email: string; password: string; name: string }

		const [{ count }] = await app.db.select({ count: sql<number>`count(*)` }).from(users)

		if (Number(count) > 0) {
			return reply.status(403).send({ error: 'Registration disabled. First admin already exists.' })
		}

		const passwordHash = await hashPassword(password)
		const [user] = await app.db.insert(users).values({ email, name, passwordHash, role: 'admin' }).returning()

		const token = await createJwt({ id: user.id, email: user.email, name: user.name, role: 'admin' })

		return reply.status(201).send({
			user: { id: user.id, email: user.email, name: user.name, role: user.role },
			token,
		})
	})

	// Login
	app.post('/login', async (request, reply) => {
		const { email, password } = request.body as { email: string; password: string }

		const [user] = await app.db.select().from(users).where(eq(users.email, email)).limit(1)
		if (!user || !(await verifyPassword(password, user.passwordHash))) {
			return reply.status(401).send({ error: 'Invalid credentials' })
		}

		const token = await createJwt({
			id: user.id,
			email: user.email,
			name: user.name,
			role: user.role as 'admin' | 'editor' | 'viewer',
		})

		return { user: { id: user.id, email: user.email, name: user.name, role: user.role }, token }
	})

	// Get current user
	app.get('/me', { preHandler: [app.authenticate] }, async (request) => {
		return request.user
	})

	// Create API key (admin+, project-scoped)
	app.post(
		'/api-keys',
		{ preHandler: [app.requireProject('admin')] },
		async (request, reply) => {
			const { name, permissions = ['*'] } = request.body as { name: string; permissions?: string[] }

			const rawKey = `ink_${randomUUID().replace(/-/g, '')}${randomUUID().replace(/-/g, '').slice(0, 8)}`
			const keyHash = hashApiKey(rawKey)
			const keyPrefix = rawKey.substring(0, 12)

			const [created] = await app.db
				.insert(apiKeys)
				.values({
					projectId: request.project!.id,
					name,
					keyHash,
					keyPrefix,
					userId: request.user!.id,
					permissions,
				})
				.returning()

			return reply.status(201).send({
				id: created.id,
				name: created.name,
				key: rawKey,
				keyPrefix,
				projectId: request.project!.id,
				permissions: created.permissions,
				createdAt: created.createdAt,
				warning: 'Save this key now. It will not be shown again.',
			})
		},
	)

	// List API keys (admin+, project-scoped)
	app.get(
		'/api-keys',
		{ preHandler: [app.requireProject('admin')] },
		async (request) => {
			return app.db
				.select({
					id: apiKeys.id,
					name: apiKeys.name,
					keyPrefix: apiKeys.keyPrefix,
					permissions: apiKeys.permissions,
					createdAt: apiKeys.createdAt,
					lastUsedAt: apiKeys.lastUsedAt,
				})
				.from(apiKeys)
				.where(eq(apiKeys.projectId, request.project!.id))
		},
	)

	// Delete API key (admin+, project-scoped)
	app.delete<{ Params: { id: string } }>(
		'/api-keys/:id',
		{ preHandler: [app.requireProject('admin')] },
		async (request, reply) => {
			await app.db.delete(apiKeys).where(
				and(eq(apiKeys.id, request.params.id), eq(apiKeys.projectId, request.project!.id)),
			)
			return reply.status(204).send()
		},
	)
}
