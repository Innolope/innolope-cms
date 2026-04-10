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

		if (!email?.trim()) return reply.status(400).send({ error: 'Email is required.' })
		if (!name?.trim()) return reply.status(400).send({ error: 'Name is required.' })
		if (!password || password.length < 8) return reply.status(400).send({ error: 'Password must be at least 8 characters.' })

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

		if (!email?.trim() || !password) return reply.status(400).send({ error: 'Email and password are required.' })

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

	// Update profile
	app.put('/profile', { preHandler: [app.authenticate] }, async (request, reply) => {
		const { name, email } = request.body as { name?: string; email?: string }

		if (name !== undefined && !name.trim()) return reply.status(400).send({ error: 'Name cannot be empty' })
		if (email !== undefined && !email.trim()) return reply.status(400).send({ error: 'Email cannot be empty' })

		if (email && email !== request.user!.email) {
			const [existing] = await app.db.select({ id: users.id }).from(users).where(eq(users.email, email)).limit(1)
			if (existing && existing.id !== request.user!.id) {
				return reply.status(409).send({ error: 'Email already in use' })
			}
		}

		const updates: Record<string, unknown> = { updatedAt: new Date() }
		if (name) updates.name = name.trim()
		if (email) updates.email = email.trim().toLowerCase()

		const [updated] = await app.db
			.update(users)
			.set(updates)
			.where(eq(users.id, request.user!.id))
			.returning({ id: users.id, email: users.email, name: users.name, role: users.role })

		return updated
	})

	// Change password
	app.post('/change-password', { preHandler: [app.authenticate] }, async (request, reply) => {
		const { currentPassword, newPassword } = request.body as { currentPassword: string; newPassword: string }

		if (!currentPassword || !newPassword) return reply.status(400).send({ error: 'Current password and new password are required' })
		if (newPassword.length < 8) return reply.status(400).send({ error: 'New password must be at least 8 characters' })

		const [user] = await app.db.select({ passwordHash: users.passwordHash }).from(users).where(eq(users.id, request.user!.id)).limit(1)
		if (!user || !(await verifyPassword(currentPassword, user.passwordHash))) {
			return reply.status(401).send({ error: 'Current password is incorrect' })
		}

		const passwordHash = await hashPassword(newPassword)
		await app.db.update(users).set({ passwordHash, updatedAt: new Date() }).where(eq(users.id, request.user!.id))

		return { message: 'Password updated' }
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
