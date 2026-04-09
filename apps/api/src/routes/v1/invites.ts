import { projects, projectMembers, users } from '@innolope/db'
import type { FastifyInstance } from 'fastify'
import { eq, and, sql } from 'drizzle-orm'
import { createHash, randomUUID } from 'node:crypto'
import { teamInviteEmail } from '../../services/email.js'

export async function inviteRoutes(app: FastifyInstance) {
	const FRONTEND_URL = process.env.ADMIN_URL || 'https://cms.innolope.com'

	// Send invite (admin+, project-scoped)
	app.post(
		'/',
		{ preHandler: [app.requireProject('admin')] },
		async (request, reply) => {
			const { email, role = 'viewer' } = request.body as {
				email: string
				role?: 'admin' | 'editor' | 'viewer'
			}

			// Check if user already exists and is already a member
			const [existingUser] = await app.db
				.select()
				.from(users)
				.where(eq(users.email, email))
				.limit(1)

			if (existingUser) {
				const [existingMember] = await app.db
					.select()
					.from(projectMembers)
					.where(
						and(
							eq(projectMembers.projectId, request.project!.id),
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

			await app.db.execute(
				sql`INSERT INTO invites ("projectId", email, role, "tokenHash", "invitedBy", "expiresAt")
					VALUES (${request.project!.id}, ${email}, ${role}, ${tokenHash}, ${request.user!.id}, ${expiresAt}::timestamptz)`,
			)

			// Send email
			const inviteUrl = `${FRONTEND_URL}/accept-invite?token=${rawToken}`
			const emailMsg = teamInviteEmail(
				inviteUrl,
				request.user!.name,
				request.project!.name,
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
		},
	)

	// Accept invite (public — token-based auth)
	app.post('/accept', async (request, reply) => {
		const { token } = request.body as { token: string }

		if (!token) {
			return reply.status(400).send({ error: 'Token required.' })
		}

		const tokenHash = createHash('sha256').update(token).digest('hex')

		const result = await app.db.execute(
			sql`SELECT id, "projectId", email, role FROM invites WHERE "tokenHash" = ${tokenHash} AND accepted = false AND "expiresAt" > now() LIMIT 1`,
		)

		const invite = (result as unknown as { id: string; projectId: string; email: string; role: string }[])[0]
		if (!invite) {
			return reply.status(400).send({ error: 'Invalid or expired invite.' })
		}

		// Find or require user account
		const [user] = await app.db
			.select()
			.from(users)
			.where(eq(users.email, invite.email))
			.limit(1)

		if (!user) {
			// User needs to register first — return info so frontend can redirect
			return reply.status(200).send({
				action: 'register',
				email: invite.email,
				projectName: invite.projectId,
				message: 'Create an account to accept this invite.',
				token, // pass back so frontend can re-submit after registration
			})
		}

		// Add as project member
		const [existing] = await app.db
			.select()
			.from(projectMembers)
			.where(
				and(
					eq(projectMembers.projectId, invite.projectId),
					eq(projectMembers.userId, user.id),
				),
			)
			.limit(1)

		if (!existing) {
			await app.db.insert(projectMembers).values({
				projectId: invite.projectId,
				userId: user.id,
				role: invite.role as 'admin' | 'editor' | 'viewer',
			})
		}

		// Mark invite as accepted
		await app.db.execute(
			sql`UPDATE invites SET accepted = true WHERE id = ${invite.id}`,
		)

		return { message: 'Invite accepted. You now have access to the project.' }
	})

	// List pending invites (admin+, project-scoped)
	app.get(
		'/',
		{ preHandler: [app.requireProject('admin')] },
		async (request) => {
			const result = await app.db.execute(
				sql`SELECT id, email, role, "createdAt", "expiresAt", accepted
					FROM invites
					WHERE "projectId" = ${request.project!.id}
					ORDER BY "createdAt" DESC
					LIMIT 50`,
			)
			return result
		},
	)
}
