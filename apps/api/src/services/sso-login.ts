import type { FastifyInstance, FastifyReply } from 'fastify'
import { and, eq, sql } from 'drizzle-orm'
import { projectMembers, ssoConnections, userIdentities, users } from '@innolope/db'
import { revokeAllUserRefreshTokens } from '../plugins/auth.js'
import { setAuthCookies } from './auth-cookies.js'

export type SsoConnection = typeof ssoConnections.$inferSelect

export interface SsoProfile {
	subject: string
	email?: string
	name?: string
	groups?: string[]
	raw: Record<string, unknown>
}

export interface CompleteSsoLoginOpts {
	connection: SsoConnection
	profile: SsoProfile
	reply: FastifyReply
	intent: 'login' | 'link' | 'test'
	linkUserId?: string
	/** Post-login redirect (same-origin path). If omitted, caller must redirect. */
	next?: string
}

interface CompleteSsoLoginResult {
	userId: string
	email: string
	created: boolean
	linked: boolean
	redirectedTo?: string
}

const PROJECT_ROLE_RANK: Record<string, number> = {
	owner: 4,
	admin: 3,
	editor: 2,
	viewer: 1,
}

/** Given connection config and the claims we got back from the IdP, extract a profile. */
export function extractProfile(
	connection: SsoConnection,
	claims: Record<string, unknown>,
	subject: string,
): SsoProfile {
	const email = (claims[connection.attrEmail] as string | undefined) || (claims.email as string | undefined)
	const name =
		(claims[connection.attrName] as string | undefined) ||
		(claims.name as string | undefined) ||
		(email ? email.split('@')[0] : undefined)
	const groupsRaw = claims[connection.attrGroups]
	const groups: string[] = Array.isArray(groupsRaw)
		? groupsRaw.map(String)
		: typeof groupsRaw === 'string'
			? groupsRaw.split(/[,\s]+/).filter(Boolean)
			: []
	return { subject, email, name, groups, raw: claims }
}

/** Resolve the project-level role to assign from the default + group overlay. */
function resolveProjectRole(connection: SsoConnection, groups: string[]): 'admin' | 'editor' | 'viewer' {
	let best: 'admin' | 'editor' | 'viewer' = connection.defaultRole as 'admin' | 'editor' | 'viewer'
	const map = (connection.groupRoleMap || {}) as Record<string, 'admin' | 'editor' | 'viewer'>
	for (const g of groups) {
		const mapped = map[g]
		if (mapped && PROJECT_ROLE_RANK[mapped] > PROJECT_ROLE_RANK[best]) {
			best = mapped
		}
	}
	return best
}

/**
 * Common completion step shared by OIDC and SAML flows.
 * - Validates domain allowlist on the connection.
 * - JIT provisioning: by (connectionId, subject), then email fallback (silent link).
 * - Updates project membership according to the connection's defaultRole + groupRoleMap.
 * - On `intent === 'login'`: revokes prior refresh tokens (session-fixation reset) and mints new cookies.
 * - On `intent === 'link'`: attaches identity to `linkUserId` without touching session.
 * - On `intent === 'test'`: no DB writes beyond the identity lookup; no cookies set.
 */
export async function completeSsoLogin(
	app: FastifyInstance,
	opts: CompleteSsoLoginOpts,
): Promise<CompleteSsoLoginResult> {
	const { connection, profile, reply, intent, linkUserId } = opts

	// Domain gate
	if (connection.domains.length > 0 && profile.email) {
		const emailDomain = profile.email.split('@')[1]?.toLowerCase()
		if (!emailDomain || !connection.domains.map((d) => d.toLowerCase()).includes(emailDomain)) {
			throw new SsoError('email_domain_not_allowed', 403, 'Email domain is not allowed for this SSO connection.')
		}
	}

	// 1. Identity lookup
	const [existingIdentity] = await app.db
		.select()
		.from(userIdentities)
		.where(and(eq(userIdentities.connectionId, connection.id), eq(userIdentities.subject, profile.subject)))
		.limit(1)

	if (intent === 'test') {
		return { userId: existingIdentity?.userId ?? '', email: profile.email ?? '', created: false, linked: false }
	}

	let userId: string
	let created = false
	let linked = false

	if (existingIdentity) {
		userId = existingIdentity.userId
		await app.db
			.update(userIdentities)
			.set({ lastLoginAt: new Date(), email: profile.email ?? existingIdentity.email, rawProfile: profile.raw })
			.where(eq(userIdentities.id, existingIdentity.id))
	} else if (intent === 'link') {
		if (!linkUserId) throw new SsoError('link_target_missing', 400, 'Missing link target.')
		userId = linkUserId
		await app.db.insert(userIdentities).values({
			userId,
			connectionId: connection.id,
			provider: connection.protocol,
			subject: profile.subject,
			email: profile.email,
			rawProfile: profile.raw,
			lastLoginAt: new Date(),
		})
		linked = true
	} else {
		// Login without existing identity — look up user by email, or create
		if (!profile.email) {
			throw new SsoError('email_required', 400, 'SSO profile did not include an email claim.')
		}
		const [existingUser] = await app.db
			.select()
			.from(users)
			.where(eq(users.email, profile.email.toLowerCase()))
			.limit(1)

		if (existingUser) {
			userId = existingUser.id
			await app.db.insert(userIdentities).values({
				userId,
				connectionId: connection.id,
				provider: connection.protocol,
				subject: profile.subject,
				email: profile.email,
				rawProfile: profile.raw,
				lastLoginAt: new Date(),
			})
			linked = true
			app.events.emit({
				type: 'auth:sso_linked',
				data: { userId, connectionId: connection.id, email: profile.email },
				timestamp: new Date().toISOString(),
			})
		} else {
			const [createdUser] = await app.db
				.insert(users)
				.values({
					email: profile.email.toLowerCase(),
					name: profile.name || profile.email.split('@')[0],
					passwordHash: null,
					role: 'editor',
				})
				.returning()
			userId = createdUser.id
			created = true
			await app.db.insert(userIdentities).values({
				userId,
				connectionId: connection.id,
				provider: connection.protocol,
				subject: profile.subject,
				email: profile.email,
				rawProfile: profile.raw,
				lastLoginAt: new Date(),
			})
		}
	}

	// 2. Project membership: ensure user is a member, apply role overlay
	const targetRole = resolveProjectRole(connection, profile.groups ?? [])
	const [existingMember] = await app.db
		.select()
		.from(projectMembers)
		.where(and(eq(projectMembers.projectId, connection.projectId), eq(projectMembers.userId, userId)))
		.limit(1)
	if (!existingMember) {
		await app.db
			.insert(projectMembers)
			.values({ projectId: connection.projectId, userId, role: targetRole })
	} else {
		// Never downgrade an existing member; upgrade only if the resolved role is higher
		const currentRank = PROJECT_ROLE_RANK[existingMember.role] ?? 0
		const nextRank = PROJECT_ROLE_RANK[targetRole] ?? 0
		if (nextRank > currentRank) {
			await app.db
				.update(projectMembers)
				.set({ role: targetRole })
				.where(eq(projectMembers.id, existingMember.id))
		}
	}

	if (intent === 'link') {
		app.events.emit({
			type: 'auth:sso_linked',
			data: { userId, connectionId: connection.id, email: profile.email },
			timestamp: new Date().toISOString(),
		})
		return { userId, email: profile.email ?? '', created, linked: true }
	}

	// 3. Session-fixation defense: revoke all prior refresh tokens
	await revokeAllUserRefreshTokens(app.db, userId)

	// 4. Mint new cookies
	const [user] = await app.db.select().from(users).where(eq(users.id, userId)).limit(1)
	if (!user) throw new SsoError('user_missing', 500, 'User vanished mid-flight.')
	await setAuthCookies(reply, app.db, user, { authMethod: 'sso' })

	app.events.emit({
		type: 'auth:sso_login',
		data: { userId, connectionId: connection.id, projectId: connection.projectId, email: user.email, created },
		timestamp: new Date().toISOString(),
	})

	return { userId, email: user.email, created, linked }
}

export class SsoError extends Error {
	code: string
	statusCode: number
	constructor(code: string, statusCode: number, message: string) {
		super(message)
		this.code = code
		this.statusCode = statusCode
	}
}
