import { createHash, randomUUID } from 'node:crypto'
import { projectMemberCollections, projectMembers, users } from '@innolope/db'
import { and, eq, sql } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { getUser, normalizeEmail } from '../../plugins/auth.js'
import { getProject } from '../../plugins/project.js'
import { teamInviteEmail } from '../../services/email.js'

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

	// Accept invite (public — token-based auth)
	app.post('/accept', async (request, reply) => {
		const { token } = request.body as { token: string }

		if (!token) {
			return reply.status(400).send({ error: 'Token required.' })
		}

		const tokenHash = createHash('sha256').update(token).digest('hex')

		const result = await app.db.execute(
			sql`SELECT id, "projectId", email, role, "collectionIds", "canPublishDirectly" FROM invites WHERE "tokenHash" = ${tokenHash} AND accepted = false AND "expiresAt" > now() LIMIT 1`,
		)

		const invite = (
			result as unknown as {
				id: string
				projectId: string
				email: string
				role: string
				collectionIds: string[] | null
				canPublishDirectly: boolean | null
			}[]
		)[0]
		if (!invite) {
			return reply.status(400).send({ error: 'Invalid or expired invite.' })
		}

		// Find or require user account
		const [user] = await app.db.select().from(users).where(eq(users.email, invite.email)).limit(1)

		if (!user) {
			// User needs to register first — return info so frontend can redirect.
			// Do NOT consume the invite yet, so it survives until the re-submit.
			return reply.status(200).send({
				action: 'register',
				email: invite.email,
				projectName: invite.projectId,
				message: 'Create an account to accept this invite.',
				token, // pass back so frontend can re-submit after registration
			})
		}

		// Atomically consume the invite before granting membership. The guarded
		// UPDATE returns zero rows if another concurrent request already accepted it,
		// making the token strictly single-use.
		const consumed = await app.db.execute(
			sql`UPDATE invites SET accepted = true
				WHERE id = ${invite.id} AND accepted = false AND "expiresAt" > now()
				RETURNING id`,
		)
		if ((consumed as unknown as { id: string }[]).length === 0) {
			return reply.status(400).send({ error: 'Invalid or expired invite.' })
		}

		// Add as project member
		const [existing] = await app.db
			.select()
			.from(projectMembers)
			.where(
				and(eq(projectMembers.projectId, invite.projectId), eq(projectMembers.userId, user.id)),
			)
			.limit(1)

		let membershipId: string
		if (!existing) {
			const [inserted] = await app.db
				.insert(projectMembers)
				.values({
					projectId: invite.projectId,
					userId: user.id,
					role: invite.role as 'admin' | 'editor' | 'viewer',
					canPublishDirectly: invite.canPublishDirectly,
				})
				.returning({ id: projectMembers.id })
			membershipId = inserted.id
		} else {
			membershipId = existing.id
		}

		// Materialize the collection scope on the membership. null means unrestricted —
		// leave the allowlist empty. An empty array means "no collections" (still empty
		// rows but with the role gated elsewhere). A non-empty array materializes one
		// row per collection.
		if (Array.isArray(invite.collectionIds) && invite.collectionIds.length > 0) {
			await app.db
				.insert(projectMemberCollections)
				.values(invite.collectionIds.map((cid) => ({ memberId: membershipId, collectionId: cid })))
				.onConflictDoNothing()
		}

		return { message: 'Invite accepted. You now have access to the project.' }
	})

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
