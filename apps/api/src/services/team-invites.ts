import { createHash } from 'node:crypto'
import { type Database, projectMemberCollections, projectMembers, users } from '@innolope/db'
import { and, eq, sql } from 'drizzle-orm'
import { normalizeEmail } from '../plugins/auth.js'

interface PendingInvite {
	id: string
	projectId: string
	email: string
	role: 'admin' | 'editor' | 'viewer'
	collectionIds: string[] | null
	canPublishDirectly: boolean | null
}

export type CompleteInviteResult =
	| { status: 'invalid' }
	| { status: 'needs-registration'; email: string; projectId: string }
	| { status: 'account-exists'; email: string; projectId: string }
	| { status: 'email-mismatch'; email: string; projectId: string }
	| {
			status: 'accepted'
			projectId: string
			createdUser: boolean
			user: typeof users.$inferSelect
	  }

interface AccountInput {
	email: string
	name: string
	passwordHash?: string
	/** Password registration must not silently turn into a login. */
	requireNew?: boolean
}

function tokenHash(token: string): string {
	return createHash('sha256').update(token).digest('hex')
}

async function readPendingInvite(
	db: Pick<Database, 'execute'>,
	token: string,
): Promise<PendingInvite | null> {
	const result = await db.execute(
		sql`SELECT id, "projectId", email, role, "collectionIds", "canPublishDirectly"
			FROM invites
			WHERE "tokenHash" = ${tokenHash(token)} AND accepted = false AND "expiresAt" > now()
			LIMIT 1`,
	)
	return (result as unknown as PendingInvite[])[0] ?? null
}

export async function pendingTeamInvite(
	db: Database,
	token: string,
): Promise<{ email: string; projectId: string } | null> {
	if (!token) return null
	const invite = await readPendingInvite(db, token)
	return invite ? { email: invite.email, projectId: invite.projectId } : null
}

/**
 * Complete an invite and grant membership in one transaction. With no account
 * input this accepts only for an existing CMS user. Supplying an account lets
 * invite-authorized password or Google registration create that user without
 * opening general public signup.
 */
export async function completeTeamInvite(
	db: Database,
	token: string,
	account?: AccountInput,
): Promise<CompleteInviteResult> {
	if (!token) return { status: 'invalid' }

	return db.transaction(async (tx) => {
		const invite = await readPendingInvite(tx, token)
		if (!invite) return { status: 'invalid' } as const

		const accountEmail = account ? normalizeEmail(account.email) : null
		if (accountEmail && accountEmail !== invite.email) {
			return {
				status: 'email-mismatch',
				email: invite.email,
				projectId: invite.projectId,
			} as const
		}

		let [user] = await tx.select().from(users).where(eq(users.email, invite.email)).limit(1)
		let createdUser = false

		if (user && account?.requireNew) {
			return {
				status: 'account-exists',
				email: invite.email,
				projectId: invite.projectId,
			} as const
		}

		if (!user && !account) {
			return {
				status: 'needs-registration',
				email: invite.email,
				projectId: invite.projectId,
			} as const
		}

		if (!user && account) {
			const [inserted] = await tx
				.insert(users)
				.values({
					email: invite.email,
					name: account.name.trim(),
					passwordHash: account.passwordHash,
					role: 'editor',
				})
				.onConflictDoNothing({ target: users.email })
				.returning()

			if (inserted) {
				user = inserted
				createdUser = true
			} else {
				;[user] = await tx.select().from(users).where(eq(users.email, invite.email)).limit(1)
				if (!user || account.requireNew) {
					return {
						status: 'account-exists',
						email: invite.email,
						projectId: invite.projectId,
					} as const
				}
			}
		}

		if (!user) return { status: 'invalid' } as const

		const consumed = await tx.execute(
			sql`UPDATE invites SET accepted = true
				WHERE id = ${invite.id} AND accepted = false AND "expiresAt" > now()
				RETURNING id`,
		)
		if ((consumed as unknown as { id: string }[]).length === 0) {
			return { status: 'invalid' } as const
		}

		const [insertedMembership] = await tx
			.insert(projectMembers)
			.values({
				projectId: invite.projectId,
				userId: user.id,
				role: invite.role,
				canPublishDirectly: invite.canPublishDirectly,
			})
			.onConflictDoNothing({ target: [projectMembers.projectId, projectMembers.userId] })
			.returning({ id: projectMembers.id })

		const membership =
			insertedMembership ??
			(
				await tx
					.select({ id: projectMembers.id })
					.from(projectMembers)
					.where(
						and(eq(projectMembers.projectId, invite.projectId), eq(projectMembers.userId, user.id)),
					)
					.limit(1)
			)[0]

		if (!membership) throw new Error('Failed to create project membership')

		if (Array.isArray(invite.collectionIds) && invite.collectionIds.length > 0) {
			await tx
				.insert(projectMemberCollections)
				.values(
					invite.collectionIds.map((collectionId) => ({
						memberId: membership.id,
						collectionId,
					})),
				)
				.onConflictDoNothing()
		}

		return {
			status: 'accepted',
			projectId: invite.projectId,
			createdUser,
			user,
		} as const
	})
}
