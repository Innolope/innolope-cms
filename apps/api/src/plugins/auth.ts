import { apiKeys, users } from '@innolope/db'
import type { UserRole } from '@innolope/types'
import { eq } from 'drizzle-orm'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import fp from 'fastify-plugin'
import bcrypt from 'bcrypt'
import { createHash } from 'node:crypto'
import { SignJWT, jwtVerify } from 'jose'

interface AuthUser {
	id: string
	email: string
	name: string
	role: UserRole
}

interface ApiKeyAuth {
	keyId: string
	userId: string
	permissions: string[]
}

declare module 'fastify' {
	interface FastifyRequest {
		user?: AuthUser
		apiKeyAuth?: ApiKeyAuth
	}
	interface FastifyInstance {
		authenticate: (request: FastifyRequest, reply: FastifyReply) => Promise<void>
		requireRole: (
			...roles: UserRole[]
		) => (request: FastifyRequest, reply: FastifyReply) => Promise<void>
		requirePermission: (
			permission: string,
		) => (request: FastifyRequest, reply: FastifyReply) => Promise<void>
	}
}

const ROLE_HIERARCHY: Record<UserRole, number> = {
	admin: 3,
	editor: 2,
	viewer: 1,
}

export function hashApiKey(key: string): string {
	return createHash('sha256').update(key).digest('hex')
}

const BCRYPT_ROUNDS = 12

export async function hashPassword(password: string): Promise<string> {
	return bcrypt.hash(password, BCRYPT_ROUNDS)
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
	return bcrypt.compare(password, stored)
}

function getJwtSecret(): Uint8Array {
	const secret = process.env.AUTH_SECRET
	if (!secret || secret.length < 32) {
		throw new Error('AUTH_SECRET must be set and at least 32 characters')
	}
	return new TextEncoder().encode(secret)
}

export async function createJwt(user: AuthUser): Promise<string> {
	return new SignJWT({ sub: user.id, email: user.email, role: user.role, name: user.name })
		.setProtectedHeader({ alg: 'HS256' })
		.setIssuedAt()
		.setExpirationTime('7d')
		.sign(getJwtSecret())
}

export async function verifyJwt(token: string): Promise<AuthUser | null> {
	try {
		const { payload } = await jwtVerify(token, getJwtSecret())
		return {
			id: payload.sub!,
			email: payload.email as string,
			name: payload.name as string,
			role: payload.role as UserRole,
		}
	} catch {
		return null
	}
}

export const authPlugin = fp(async (app: FastifyInstance) => {
	// Authenticate from JWT (cookie or header) or API key
	const authenticate = async (request: FastifyRequest, reply: FastifyReply) => {
		const authHeader = request.headers.authorization

		if (authHeader?.startsWith('Bearer ink_')) {
			// API key auth
			const rawKey = authHeader.slice(7)
			const keyHash = hashApiKey(rawKey)

			const [key] = await app.db
				.select()
				.from(apiKeys)
				.where(eq(apiKeys.keyHash, keyHash))
				.limit(1)

			if (!key) {
				return reply.status(401).send({ error: 'Invalid API key' })
			}

			if (key.expiresAt && new Date(key.expiresAt) < new Date()) {
				return reply.status(401).send({ error: 'API key expired' })
			}

			// Update last used
			await app.db
				.update(apiKeys)
				.set({ lastUsedAt: new Date() })
				.where(eq(apiKeys.id, key.id))

			// Get associated user for role info
			const [user] = await app.db
				.select()
				.from(users)
				.where(eq(users.id, key.userId))
				.limit(1)

			if (user) {
				request.user = {
					id: user.id,
					email: user.email,
					name: user.name,
					role: user.role as UserRole,
				}
			}

			request.apiKeyAuth = {
				keyId: key.id,
				userId: key.userId,
				permissions: (key.permissions as string[]) || [],
			}
			return
		}

		if (authHeader?.startsWith('Bearer ')) {
			// JWT auth
			const token = authHeader.slice(7)
			const user = await verifyJwt(token)
			if (!user) {
				return reply.status(401).send({ error: 'Invalid or expired token' })
			}
			request.user = user
			return
		}

		return reply.status(401).send({ error: 'Authentication required' })
	}

	// Role check
	const requireRole =
		(...roles: UserRole[]) =>
		async (request: FastifyRequest, reply: FastifyReply) => {
			await authenticate(request, reply)
			if (reply.sent) return

			if (!request.user) {
				return reply.status(401).send({ error: 'Authentication required' })
			}

			const userLevel = ROLE_HIERARCHY[request.user.role] || 0
			const minLevel = Math.min(...roles.map((r) => ROLE_HIERARCHY[r] || 0))

			if (userLevel < minLevel) {
				return reply.status(403).send({ error: 'Insufficient permissions' })
			}
		}

	// Permission check for API keys
	const requirePermission = (permission: string) => async (request: FastifyRequest, reply: FastifyReply) => {
		await authenticate(request, reply)
		if (reply.sent) return

		// If authenticated via API key, check granular permission
		if (request.apiKeyAuth) {
			const perms = request.apiKeyAuth.permissions
			if (perms.length > 0 && !perms.includes(permission) && !perms.includes('*')) {
				return reply.status(403).send({ error: `Missing permission: ${permission}` })
			}
		}
		// Role-based users (admin/editor) bypass granular permissions
	}

	app.decorate('authenticate', authenticate)
	app.decorate('requireRole', requireRole)
	app.decorate('requirePermission', requirePermission)
})
