import { createHash, randomUUID } from 'node:crypto'
import { projectMembers, users } from '@innolope/db'
import { and, eq, sql } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import {
	getUser,
	hashPassword,
	normalizeEmail,
	validatePasswordComplexity,
} from '../../plugins/auth.js'
import { getProject } from '../../plugins/project.js'
import { setAuthCookies } from '../../services/auth-cookies.js'
import { teamInviteEmail } from '../../services/email.js'
import { completeTeamInvite, pendingTeamInvite } from '../../services/team-invites.js'

export async function inviteRoutes(app: FastifyInstance) {
	const FRONTEND_URL = process.env.ADMIN_URL || 'https://cms.innolope.com'

	// Send invite (admin+, project-scoped)
	app.post('/', { preHandler: [app.requireProject('admin')] }, async (request, reply) => {
		const {
			email: rawEmail,
			role = 'viewer',
			collectionIds,
			canPublishDirectly,
		} = request.body as {
			email: string
			role?: 'admin' | 'editor' | 'viewer'
			// null/undefined ⇒ unrestricted (full access). [] ⇒ no collections. [...] ⇒ subset.
			collectionIds?: string[] | null
			// null/undefined ⇒ inherit project default; true/false ⇒ explicit override.
			canPublishDirectly?: boolean | null
		}

		if (!rawEmail?.trim()) return reply.status(400).send({ error: 'Email is required.' })
		const email = normalizeEmail(rawEmail)

		// Check if user already exists and is already a member
		const [existingUser] = await app.db.select().from(users).where(eq(users.email, email)).limit(1)

		if (existingUser) {
			const [existingMember] = await app.db
				.select()
				.from(projectMembers)
				.where(
					and(
						eq(projectMembers.projectId, getProject(request).id),
						eq(projectMembers.userId, existingUser.id),
					),
				)
				.limit(1)

			if (existingMember) {
				return reply.status(409).send({ error: 'User is already a member of this project.' })
			}
		}

		// Generate invite token
		const rawToken = randomUUID()
		const tokenHash = createHash('sha256').update(rawToken).digest('hex')
		const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString() // 7 days

		// Admin/owner roles always have full access — never persist a scope for them.
		const scopedCollectionIds =
			role === 'admin' || !Array.isArray(collectionIds) ? null : collectionIds
		const scopeJson = scopedCollectionIds === null ? null : JSON.stringify(scopedCollectionIds)

		// Admin role inherits publish authority unconditionally; never persist an
		// explicit override for them. Viewers don't get publish anyway.
		const persistedCanPublish =
			role === 'editor' && typeof canPublishDirectly === 'boolean' ? canPublishDirectly : null

		await app.db.execute(
			sql`INSERT INTO invites ("projectId", email, role, "tokenHash", "invitedBy", "expiresAt", "collectionIds", "canPublishDirectly")
					VALUES (${getProject(request).id}, ${email}, ${role}, ${tokenHash}, ${getUser(request).id}, ${expiresAt}::timestamptz, ${scopeJson}::jsonb, ${persistedCanPublish})`,
		)

		// Send email
		const inviteUrl = `${FRONTEND_URL}/accept-invite?token=${rawToken}`
		const emailMsg = teamInviteEmail(
			inviteUrl,
			getUser(request).name,
			getProject(request).name,
			role,
		)
		emailMsg.to = email

		try {
			await app.email.send(emailMsg)
		} catch (err) {
			app.log.error(err, 'Failed to send invite email')
		}

		return reply.status(201).send({
			message: `Invite sent to ${email}`,
			inviteUrl: process.env.NODE_ENV !== 'production' ? inviteUrl : undefined,
		})
	})

	// Resolve the invited email without consuming the token. Keeping the email
	// out of the login URL avoids leaking it through browser history or analytics.
	app.post(
		'/details',
		{ config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
		async (request, reply) => {
			const { token } = request.body as { token: string }
			const invite = await pendingTeamInvite(app.db, token)
			if (!invite) return reply.status(400).send({ error: 'Invalid or expired invite.' })
			return { email: invite.email }
		},
	)

	// Accept invite (public — token-based auth)
	app.post('/accept', async (request, reply) => {
		const { token } = request.body as { token: string }

		if (!token) {
			return reply.status(400).send({ error: 'Token required.' })
		}

		const result = await completeTeamInvite(app.db, token)
		if (result.status === 'invalid') {
			return reply.status(400).send({ error: 'Invalid or expired invite.' })
		}
		if (result.status === 'needs-registration') {
			// User needs to register first — return info so frontend can redirect.
			// Do NOT consume the invite yet, so it survives until the re-submit.
			return reply.status(200).send({
				action: 'register',
				email: result.email,
				message: 'Create an account to accept this invite.',
			})
		}
		if (result.status !== 'accepted') {
			return reply.status(400).send({ error: 'Unable to accept invite.' })
		}

		return {
			message: 'Invite accepted. You now have access to the project.',
			projectId: result.projectId,
		}
	})

	// Create a CMS account only when authorized by a still-valid invite, then
	// consume the invite and establish the session atomically from the user's
	// perspective. General public registration remains disabled after setup.
	app.post(
		'/register',
		{ config: { rateLimit: { max: 5, timeWindow: '1 minute' } } },
		async (request, reply) => {
			const { token, email, name, password } = request.body as {
				token: string
				email: string
				name: string
				password: string
			}

			if (!token) return reply.status(400).send({ error: 'Invite token is required.' })
			if (!email?.trim()) return reply.status(400).send({ error: 'Email is required.' })
			if (!name?.trim()) return reply.status(400).send({ error: 'Name is required.' })
			const passwordError = validatePasswordComplexity(password)
			if (passwordError) return reply.status(400).send({ error: passwordError })

			const result = await completeTeamInvite(app.db, token, {
				email,
				name,
				passwordHash: await hashPassword(password),
				requireNew: true,
			})

			if (result.status === 'invalid') {
				return reply.status(400).send({ error: 'Invalid or expired invite.' })
			}
			if (result.status === 'email-mismatch') {
				return reply.status(400).send({ error: 'Use the email address that was invited.' })
			}
			if (result.status === 'account-exists') {
				return reply.status(409).send({ error: 'An account already exists. Sign in instead.' })
			}
			if (result.status !== 'accepted') {
				return reply.status(400).send({ error: 'Unable to create account from invite.' })
			}

			await setAuthCookies(reply, app.db, result.user)
			app.events.emit({
				type: 'auth:registered',
				data: { userId: result.user.id, email: result.user.email, source: 'invite' },
				timestamp: new Date().toISOString(),
			})

			return reply.status(201).send({
				user: {
					id: result.user.id,
					email: result.user.email,
					name: result.user.name,
					role: result.user.role,
				},
				projectId: result.projectId,
			})
		},
	)

	// List pending invites (admin+, project-scoped)
	app.get('/', { preHandler: [app.requireProject('admin')] }, async (request) => {
		const result = await app.db.execute(
			sql`SELECT id, email, role, "createdAt", "expiresAt", accepted, "collectionIds"
					FROM invites
					WHERE "projectId" = ${getProject(request).id}
					ORDER BY "createdAt" DESC
					LIMIT 50`,
		)
		return result
	})
}
