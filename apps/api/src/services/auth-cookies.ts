import type { FastifyInstance, FastifyReply } from 'fastify'
import { randomUUID } from 'node:crypto'
import { createJwt, createRefreshToken } from '../plugins/auth.js'
import type { UserRole } from '@innolope/types'

const IS_PROD = process.env.NODE_ENV === 'production'

export const ACCESS_COOKIE_OPTIONS = {
	httpOnly: true,
	secure: IS_PROD,
	sameSite: 'lax' as const,
	path: '/',
	maxAge: 60 * 60, // 1 hour — matches JWT expiry
}

export const REFRESH_COOKIE_OPTIONS = {
	httpOnly: true,
	secure: IS_PROD,
	sameSite: 'lax' as const,
	path: '/api/v1/auth/refresh',
	maxAge: 30 * 24 * 60 * 60,
}

export const CSRF_COOKIE_OPTIONS = {
	httpOnly: false,
	secure: IS_PROD,
	sameSite: 'lax' as const,
	path: '/',
	maxAge: 30 * 24 * 60 * 60,
}

export function clearAuthCookies(reply: FastifyReply) {
	reply.clearCookie('innolope_token', { path: '/' })
	reply.clearCookie('innolope_refresh', { path: '/api/v1/auth/refresh' })
	reply.clearCookie('innolope_csrf', { path: '/' })
}

/** Mint a new session: access JWT + refresh token + CSRF token, set cookies. */
export async function setAuthCookies(
	reply: FastifyReply,
	db: FastifyInstance['db'],
	user: { id: string; email: string; name: string; role: string },
	opts: { authMethod?: 'password' | 'sso' } = {},
) {
	const accessToken = await createJwt({
		id: user.id,
		email: user.email,
		name: user.name,
		role: user.role as UserRole,
	})
	const { rawToken: refreshToken } = await createRefreshToken(db, user.id, undefined, opts.authMethod ?? 'password')
	const csrfToken = randomUUID()

	reply.setCookie('innolope_token', accessToken, ACCESS_COOKIE_OPTIONS)
	reply.setCookie('innolope_refresh', refreshToken, REFRESH_COOKIE_OPTIONS)
	reply.setCookie('innolope_csrf', csrfToken, CSRF_COOKIE_OPTIONS)
}
