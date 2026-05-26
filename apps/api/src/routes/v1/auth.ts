import { randomUUID } from 'node:crypto'
import { apiKeys, projectMembers, projects, users } from '@innolope/db'
import { and, eq, isNotNull, sql } from 'drizzle-orm'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import {
	createJwt,
	getUser,
	hashApiKey,
	hashPassword,
	revokeAllUserRefreshTokens,
	revokeRefreshTokenFamily,
	rotateRefreshToken,
	validatePasswordComplexity,
	verifyPassword,
} from '../../plugins/auth.js'
import { getProject } from '../../plugins/project.js'
import {
	ACCESS_COOKIE_OPTIONS,
	CSRF_COOKIE_OPTIONS,
	clearAuthCookies,
	REFRESH_COOKIE_OPTIONS,
	setAuthCookies,
} from '../../services/auth-cookies.js'
import { normalizeDomain } from '../../services/domain-verification.js'

/**
 * If the request arrived on a verified custom domain, return that project.
 * Used to scope login to a single project when the CMS is reached via a
 * project's own branded domain.
 */
async function projectForRequestHost(
	app: FastifyInstance,
	request: FastifyRequest,
): Promise<{ id: string; name: string; slug: string } | null> {
	const host = normalizeDomain((request.hostname || '').split(':')[0])
	if (!host) return null
	const [project] = await app.db
		.select({ id: projects.id, name: projects.name, slug: projects.slug })
		.from(projects)
		.where(and(eq(projects.customDomain, host), isNotNull(projects.customDomainVerifiedAt)))
		.limit(1)
	return project ?? null
}

export async function authRoutes(app: FastifyInstance) {
	// Resolve the project bound to the request's custom domain (public).
	// The admin SPA calls this on load to enter project-locked mode.
	app.get('/domain-context', async (request, reply) => {
		const project = await projectForRequestHost(app, request)
		if (!project) return reply.status(404).send({ error: 'No project for this domain' })
		return { projectId: project.id, projectName: project.name, projectSlug: project.slug }
	})

	// Check if setup is needed (public)
	app.get('/setup-status', async () => {
		const [{ count }] = await app.db.select({ count: sql<number>`count(*)` }).from(users)
		return { needsSetup: Number(count) === 0 }
	})

	// Register first admin (only works when no users exist)
	app.post('/register', async (request, reply) => {
		const { email, password, name } = request.body as {
			email: string
			password: string
			name: string
		}

		if (!email?.trim()) return reply.status(400).send({ error: 'Email is required.' })
		if (!name?.trim()) return reply.status(400).send({ error: 'Name is required.' })
		const pwError = validatePasswordComplexity(password)
		if (pwError) return reply.status(400).send({ error: pwError })

		const [{ count }] = await app.db.select({ count: sql<number>`count(*)` }).from(users)

		if (Number(count) > 0) {
			return reply.status(403).send({ error: 'Registration disabled. First admin already exists.' })
		}

		const passwordHash = await hashPassword(password)
		const [user] = await app.db
			.insert(users)
			.values({ email, name, passwordHash, role: 'admin' })
			.returning()

		await setAuthCookies(reply, app.db, user)

		app.events.emit({
			type: 'auth:registered',
			data: { userId: user.id, email: user.email },
			timestamp: new Date().toISOString(),
		})

		return reply.status(201).send({
			user: { id: user.id, email: user.email, name: user.name, role: user.role },
		})
	})

	// Login
	app.post(
		'/login',
		{ config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
		async (request, reply) => {
			const { email, password } = request.body as { email: string; password: string }

			if (!email?.trim() || !password)
				return reply.status(400).send({ error: 'Email and password are required.' })

			const [user] = await app.db.select().from(users).where(eq(users.email, email)).limit(1)
			if (!user?.passwordHash || !(await verifyPassword(password, user.passwordHash))) {
				return reply.status(401).send({ error: 'Invalid credentials' })
			}

			// On a custom domain, login is scoped to that project — reject non-members.
			const domainProject = await projectForRequestHost(app, request)
			if (domainProject) {
				const [membership] = await app.db
					.select({ id: projectMembers.id })
					.from(projectMembers)
					.where(
						and(eq(projectMembers.projectId, domainProject.id), eq(projectMembers.userId, user.id)),
					)
					.limit(1)
				if (!membership) {
					return reply
						.status(403)
						.send({ error: `You don't have access to ${domainProject.name}.` })
				}
			}

			await setAuthCookies(reply, app.db, user)

			app.events.emit({
				type: 'auth:login',
				data: { userId: user.id, email: user.email },
				timestamp: new Date().toISOString(),
			})

			return { user: { id: user.id, email: user.email, name: user.name, role: user.role } }
		},
	)

	// Get current user
	app.get('/me', { preHandler: [app.authenticate] }, async (request) => {
		// JWT carries only id/email/name/role. uiLocale lives in DB and is fetched
		// here so the admin can render in the user's chosen language without
		// waiting for a token refresh after a switch.
		const [row] = await app.db
			.select({ uiLocale: users.uiLocale })
			.from(users)
			.where(eq(users.id, getUser(request).id))
			.limit(1)
		return { ...request.user, uiLocale: row?.uiLocale ?? null }
	})

	const SUPPORTED_UI_LOCALES = ['en', 'uk'] as const
	type SupportedUiLocale = (typeof SUPPORTED_UI_LOCALES)[number]
	const isSupportedUiLocale = (v: unknown): v is SupportedUiLocale =>
		typeof v === 'string' && (SUPPORTED_UI_LOCALES as readonly string[]).includes(v)

	// Update profile
	app.put('/profile', { preHandler: [app.authenticate] }, async (request, reply) => {
		const { name, email, uiLocale } = request.body as {
			name?: string
			email?: string
			uiLocale?: string | null
		}

		if (name !== undefined && !name.trim())
			return reply.status(400).send({ error: 'Name cannot be empty' })
		if (email !== undefined && !email.trim())
			return reply.status(400).send({ error: 'Email cannot be empty' })
		if (uiLocale !== undefined && uiLocale !== null && !isSupportedUiLocale(uiLocale)) {
			return reply.status(400).send({ error: 'Unsupported UI locale' })
		}

		if (email && email !== getUser(request).email) {
			const [existing] = await app.db
				.select({ id: users.id })
				.from(users)
				.where(eq(users.email, email))
				.limit(1)
			if (existing && existing.id !== getUser(request).id) {
				return reply.status(409).send({ error: 'Email already in use' })
			}
		}

		const updates: Record<string, unknown> = { updatedAt: new Date() }
		if (name) updates.name = name.trim()
		if (email) updates.email = email.trim().toLowerCase()
		if (uiLocale !== undefined) updates.uiLocale = uiLocale

		const [updated] = await app.db
			.update(users)
			.set(updates)
			.where(eq(users.id, getUser(request).id))
			.returning({
				id: users.id,
				email: users.email,
				name: users.name,
				role: users.role,
				uiLocale: users.uiLocale,
			})

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
			clearAuthCookies(reply)
			return reply.status(401).send({ error: 'Invalid refresh token. Please log in again.' })
		}

		const accessToken = await createJwt(result.user)
		const csrfToken = randomUUID()

		reply.setCookie('innolope_token', accessToken, ACCESS_COOKIE_OPTIONS)
		reply.setCookie('innolope_refresh', result.newRawToken, REFRESH_COOKIE_OPTIONS)
		reply.setCookie('innolope_csrf', csrfToken, CSRF_COOKIE_OPTIONS)

		return { user: result.user }
	})

	// Logout — revoke refresh token family and clear cookies
	app.post('/logout', async (request, reply) => {
		const rawRefreshToken = request.cookies?.innolope_refresh
		if (rawRefreshToken) {
			await revokeRefreshTokenFamily(app.db, rawRefreshToken)
		}
		clearAuthCookies(reply)

		// Best-effort: try to identify user from the access token cookie
		const cookieToken = request.cookies?.innolope_token
		if (cookieToken) {
			const { verifyJwt } = await import('../../plugins/auth.js')
			const user = await verifyJwt(cookieToken).catch(() => null)
			if (user) {
				app.events.emit({
					type: 'auth:logout',
					data: { userId: user.id },
					timestamp: new Date().toISOString(),
				})
			}
		}

		return { message: 'Logged out' }
	})

	// Change password
	app.post('/change-password', { preHandler: [app.authenticate] }, async (request, reply) => {
		const { currentPassword, newPassword } = request.body as {
			currentPassword: string
			newPassword: string
		}

		if (!currentPassword || !newPassword)
			return reply.status(400).send({ error: 'Current password and new password are required' })
		const pwError = validatePasswordComplexity(newPassword)
		if (pwError) return reply.status(400).send({ error: pwError })

		const [user] = await app.db
			.select({ passwordHash: users.passwordHash })
			.from(users)
			.where(eq(users.id, getUser(request).id))
			.limit(1)
		if (!user?.passwordHash) {
			return reply
				.status(400)
				.send({ error: 'No password set for this account. Use SSO to sign in.' })
		}
		if (!(await verifyPassword(currentPassword, user.passwordHash))) {
			return reply.status(401).send({ error: 'Current password is incorrect' })
		}

		const passwordHash = await hashPassword(newPassword)
		await app.db
			.update(users)
			.set({ passwordHash, updatedAt: new Date() })
			.where(eq(users.id, getUser(request).id))

		// Revoke all refresh tokens — forces re-login on all devices
		await revokeAllUserRefreshTokens(app.db, getUser(request).id)

		app.events.emit({
			type: 'auth:password_changed',
			data: { userId: getUser(request).id },
			timestamp: new Date().toISOString(),
		})

		return { message: 'Password updated. All sessions have been signed out.' }
	})

	// Create API key (admin+, project-scoped)
	app.post('/api-keys', { preHandler: [app.requireProject('admin')] }, async (request, reply) => {
		const { name, permissions = ['*'] } = request.body as { name: string; permissions?: string[] }

		const rawKey = `ink_${randomUUID().replace(/-/g, '')}${randomUUID().replace(/-/g, '').slice(0, 8)}`
		const keyHash = hashApiKey(rawKey)
		const keyPrefix = rawKey.substring(0, 12)

		const [created] = await app.db
			.insert(apiKeys)
			.values({
				projectId: getProject(request).id,
				name,
				keyHash,
				keyPrefix,
				userId: getUser(request).id,
				permissions,
			})
			.returning()

		return reply.status(201).send({
			id: created.id,
			name: created.name,
			key: rawKey,
			keyPrefix,
			projectId: getProject(request).id,
			permissions: created.permissions,
			createdAt: created.createdAt,
			warning: 'Save this key now. It will not be shown again.',
		})
	})

	// List API keys (admin+, project-scoped)
	app.get('/api-keys', { preHandler: [app.requireProject('admin')] }, async (request) => {
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
			.where(eq(apiKeys.projectId, getProject(request).id))
	})

	// Delete API key (admin+, project-scoped)
	app.delete<{ Params: { id: string } }>(
		'/api-keys/:id',
		{ preHandler: [app.requireProject('admin')] },
		async (request, reply) => {
			await app.db
				.delete(apiKeys)
				.where(
					and(eq(apiKeys.id, request.params.id), eq(apiKeys.projectId, getProject(request).id)),
				)
			return reply.status(204).send()
		},
	)
}
