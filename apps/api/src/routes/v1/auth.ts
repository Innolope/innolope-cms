import { apiKeys, users } from '@innolope/db'
import type { FastifyInstance } from 'fastify'
import { eq, and, sql } from 'drizzle-orm'
import { randomUUID } from 'node:crypto'
import { hashApiKey, hashPassword, verifyPassword, createJwt, verifyJwt, validatePasswordComplexity, createRefreshToken, rotateRefreshToken, revokeRefreshTokenFamily, revokeAllUserRefreshTokens } from '../../plugins/auth.js'

const IS_PROD = process.env.NODE_ENV === 'production'

const ACCESS_COOKIE_OPTIONS = {
	httpOnly: true,
	secure: IS_PROD,
	sameSite: 'lax' as const,
	path: '/',
	maxAge: 60 * 60, // 1 hour — matches JWT expiry
}

const REFRESH_COOKIE_OPTIONS = {
	httpOnly: true,
	secure: IS_PROD,
	sameSite: 'lax' as const,
	path: '/api/v1/auth/refresh', // Only sent to the refresh endpoint
	maxAge: 30 * 24 * 60 * 60, // 30 days
}

function setCsrfCookie(reply: import('fastify').FastifyReply, token: string) {
	reply.setCookie('innolope_csrf', token, {
		httpOnly: false, // JS must read this
		secure: IS_PROD,
		sameSite: 'lax',
		path: '/',
		maxAge: 30 * 24 * 60 * 60, // 30 days — matches refresh token
	})
}

/** Set all auth cookies (access + refresh + CSRF) */
async function setAuthCookies(
	reply: import('fastify').FastifyReply,
	db: import('fastify').FastifyInstance['db'],
	user: { id: string; email: string; name: string; role: string },
) {
	const accessToken = await createJwt({
		id: user.id,
		email: user.email,
		name: user.name,
		role: user.role as 'admin' | 'editor' | 'viewer',
	})
	const { rawToken: refreshToken } = await createRefreshToken(db, user.id)
	const csrfToken = randomUUID()

	reply.setCookie('innolope_token', accessToken, ACCESS_COOKIE_OPTIONS)
	reply.setCookie('innolope_refresh', refreshToken, REFRESH_COOKIE_OPTIONS)
	setCsrfCookie(reply, csrfToken)
}

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
		const pwError = validatePasswordComplexity(password)
		if (pwError) return reply.status(400).send({ error: pwError })

		const [{ count }] = await app.db.select({ count: sql<number>`count(*)` }).from(users)

		if (Number(count) > 0) {
			return reply.status(403).send({ error: 'Registration disabled. First admin already exists.' })
		}

		const passwordHash = await hashPassword(password)
		const [user] = await app.db.insert(users).values({ email, name, passwordHash, role: 'admin' }).returning()

		await setAuthCookies(reply, app.db, user)

		app.events.emit({ type: 'auth:registered', data: { userId: user.id, email: user.email }, timestamp: new Date().toISOString() })

		return reply.status(201).send({
			user: { id: user.id, email: user.email, name: user.name, role: user.role },
		})
	})

	// Login
	app.post('/login', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (request, reply) => {
		const { email, password } = request.body as { email: string; password: string }

		if (!email?.trim() || !password) return reply.status(400).send({ error: 'Email and password are required.' })

		const [user] = await app.db.select().from(users).where(eq(users.email, email)).limit(1)
		if (!user || !(await verifyPassword(password, user.passwordHash))) {
			return reply.status(401).send({ error: 'Invalid credentials' })
		}

		await setAuthCookies(reply, app.db, user)

		app.events.emit({ type: 'auth:login', data: { userId: user.id, email: user.email }, timestamp: new Date().toISOString() })

		return { user: { id: user.id, email: user.email, name: user.name, role: user.role } }
	})

	// Session probe — public; returns the user or null. Not 401, because the
	// frontend uses this to *check* whether a session exists, and "no session"
	// is a valid answer rather than an error.
	app.get('/me', async (request) => {
		const authHeader = request.headers.authorization
		if (authHeader?.startsWith('Bearer ')) {
			return (await verifyJwt(authHeader.slice(7))) ?? null
		}
		const cookieToken = request.cookies?.innolope_token
		if (cookieToken) {
			return (await verifyJwt(cookieToken)) ?? null
		}
		return null
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

	// Refresh — exchange refresh token for new access + refresh tokens
	app.post('/refresh', async (request, reply) => {
		const rawRefreshToken = request.cookies?.innolope_refresh
		if (!rawRefreshToken) {
			return reply.status(401).send({ error: 'No refresh token' })
		}

		const result = await rotateRefreshToken(app.db, rawRefreshToken)
		if (!result) {
			// Token invalid/expired/reused — clear everything
			reply.clearCookie('innolope_token', { path: '/' })
			reply.clearCookie('innolope_refresh', { path: '/api/v1/auth/refresh' })
			reply.clearCookie('innolope_csrf', { path: '/' })
			return reply.status(401).send({ error: 'Invalid refresh token. Please log in again.' })
		}

		const accessToken = await createJwt(result.user)
		const csrfToken = randomUUID()

		reply.setCookie('innolope_token', accessToken, ACCESS_COOKIE_OPTIONS)
		reply.setCookie('innolope_refresh', result.newRawToken, REFRESH_COOKIE_OPTIONS)
		setCsrfCookie(reply, csrfToken)

		return { user: result.user }
	})

	// Logout — revoke refresh token family and clear cookies
	app.post('/logout', async (request, reply) => {
		const rawRefreshToken = request.cookies?.innolope_refresh
		if (rawRefreshToken) {
			await revokeRefreshTokenFamily(app.db, rawRefreshToken)
		}
		reply.clearCookie('innolope_token', { path: '/' })
		reply.clearCookie('innolope_refresh', { path: '/api/v1/auth/refresh' })
		reply.clearCookie('innolope_csrf', { path: '/' })

		// Best-effort: try to identify user from the access token cookie
		const cookieToken = request.cookies?.innolope_token
		if (cookieToken) {
			const { verifyJwt } = await import('../../plugins/auth.js')
			const user = await verifyJwt(cookieToken).catch(() => null)
			if (user) {
				app.events.emit({ type: 'auth:logout', data: { userId: user.id }, timestamp: new Date().toISOString() })
			}
		}

		return { message: 'Logged out' }
	})

	// Change password
	app.post('/change-password', { preHandler: [app.authenticate] }, async (request, reply) => {
		const { currentPassword, newPassword } = request.body as { currentPassword: string; newPassword: string }

		if (!currentPassword || !newPassword) return reply.status(400).send({ error: 'Current password and new password are required' })
		const pwError = validatePasswordComplexity(newPassword)
		if (pwError) return reply.status(400).send({ error: pwError })

		const [user] = await app.db.select({ passwordHash: users.passwordHash }).from(users).where(eq(users.id, request.user!.id)).limit(1)
		if (!user || !(await verifyPassword(currentPassword, user.passwordHash))) {
			return reply.status(401).send({ error: 'Current password is incorrect' })
		}

		const passwordHash = await hashPassword(newPassword)
		await app.db.update(users).set({ passwordHash, updatedAt: new Date() }).where(eq(users.id, request.user!.id))

		// Revoke all refresh tokens — forces re-login on all devices
		await revokeAllUserRefreshTokens(app.db, request.user!.id)

		app.events.emit({ type: 'auth:password_changed', data: { userId: request.user!.id }, timestamp: new Date().toISOString() })

		return { message: 'Password updated. All sessions have been signed out.' }
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
