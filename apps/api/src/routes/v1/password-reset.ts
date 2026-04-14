import { users } from '@innolope/db'
import type { FastifyInstance } from 'fastify'
import { eq, and, sql } from 'drizzle-orm'
import { createHash, randomUUID } from 'node:crypto'
import { hashPassword, validatePasswordComplexity } from '../../plugins/auth.js'
import { passwordResetEmail } from '../../services/email.js'

export async function passwordResetRoutes(app: FastifyInstance) {
	const FRONTEND_URL = process.env.ADMIN_URL || 'https://cms.innolope.com'

	// Request password reset (public — no auth needed)
	app.post('/forgot-password', { config: { rateLimit: { max: 5, timeWindow: '15 minutes' } } }, async (request, reply) => {
		const { email } = request.body as { email: string }

		// Always return success (don't leak whether email exists)
		const [user] = await app.db
			.select()
			.from(users)
			.where(eq(users.email, email))
			.limit(1)

		if (!user) {
			return { message: 'If that email exists, a reset link has been sent.' }
		}

		// Generate token
		const rawToken = randomUUID()
		const tokenHash = createHash('sha256').update(rawToken).digest('hex')
		const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString() // 1 hour

		// Store token (raw SQL since we don't have a Drizzle schema for this table yet)
		await app.db.execute(
			sql`INSERT INTO password_reset_tokens ("userId", "tokenHash", "expiresAt") VALUES (${user.id}, ${tokenHash}, ${expiresAt}::timestamptz)`,
		)

		// Send email
		const resetUrl = `${FRONTEND_URL}/reset-password?token=${rawToken}`
		const emailMsg = passwordResetEmail(resetUrl, user.name)
		emailMsg.to = user.email

		try {
			await app.email.send(emailMsg)
		} catch (err) {
			app.log.error(err, 'Failed to send password reset email')
		}

		return { message: 'If that email exists, a reset link has been sent.' }
	})

	// Reset password with token (public)
	app.post('/reset-password', { config: { rateLimit: { max: 5, timeWindow: '15 minutes' } } }, async (request, reply) => {
		const { token, password } = request.body as { token: string; password: string }

		if (!token || !password) {
			return reply.status(400).send({ error: 'Token and password are required.' })
		}
		const pwError = validatePasswordComplexity(password)
		if (pwError) {
			return reply.status(400).send({ error: pwError })
		}

		const tokenHash = createHash('sha256').update(token).digest('hex')

		// Find valid token
		const result = await app.db.execute(
			sql`SELECT id, "userId" FROM password_reset_tokens WHERE "tokenHash" = ${tokenHash} AND used = false AND "expiresAt" > now() LIMIT 1`,
		)

		const row = (result as unknown as { id: string; userId: string }[])[0]
		if (!row) {
			return reply.status(400).send({ error: 'Invalid or expired reset token.' })
		}

		// Update password
		const passwordHash = await hashPassword(password)
		await app.db
			.update(users)
			.set({ passwordHash, updatedAt: new Date() })
			.where(eq(users.id, row.userId))

		// Mark token as used
		await app.db.execute(
			sql`UPDATE password_reset_tokens SET used = true WHERE id = ${row.id}`,
		)

		return { message: 'Password updated. You can now log in.' }
	})
}
