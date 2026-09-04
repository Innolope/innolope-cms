import { createHash, randomUUID } from 'node:crypto'
import {
	projectMembers,
	projects,
	scimTokens,
	ssoConnections,
	userIdentities,
	users,
} from '@innolope/db'
import { and, eq } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createJwt } from '../plugins/auth.js'
import { completeSsoLogin, type SsoError } from '../services/sso-login.js'
import { buildTestApp, hasTestDb } from '../test/harness.js'

/**
 * SSO connections and SCIM tokens are single-tenant credentials. None of them
 * may adopt, rewrite or log out an account that exists for another tenant.
 */
describe.skipIf(!hasTestDb)('SSO/SCIM tenancy (real Postgres)', () => {
	let app: FastifyInstance
	let attackerId: string
	let attackerToken: string
	let victimId: string
	let memberId: string
	let projectB: string
	let projectA: string
	let connection: typeof ssoConnections.$inferSelect
	let scimToken: string
	const slug = `conn-${randomUUID().slice(0, 8)}`
	const cleanupUsers: string[] = []

	beforeAll(async () => {
		app = await buildTestApp()
		const short = randomUUID().slice(0, 8)
		const [attacker] = await app.db
			.insert(users)
			.values({ email: `att-${short}@example.com`, name: 'Att', role: 'editor' })
			.returning()
		const [victim] = await app.db
			.insert(users)
			.values({
				email: `victim-${short}@corp.example`,
				name: 'Victim',
				role: 'admin',
				passwordHash: 'x',
			})
			.returning()
		const [member] = await app.db
			.insert(users)
			.values({ email: `member-${short}@corp.example`, name: 'Member', role: 'editor' })
			.returning()
		attackerId = attacker.id
		victimId = victim.id
		memberId = member.id
		cleanupUsers.push(attacker.id, victim.id, member.id)
		const [pa] = await app.db
			.insert(projects)
			.values({ name: 'A', slug: `a-${short}`, ownerId: victim.id })
			.returning()
		const [pb] = await app.db
			.insert(projects)
			.values({ name: 'B', slug: `b-${short}`, ownerId: attacker.id })
			.returning()
		projectA = pa.id
		projectB = pb.id
		await app.db.insert(projectMembers).values([
			{ projectId: projectA, userId: victimId, role: 'owner' },
			{ projectId: projectB, userId: attackerId, role: 'owner' },
			{ projectId: projectB, userId: memberId, role: 'viewer' },
		])
		;[connection] = await app.db
			.insert(ssoConnections)
			.values({
				projectId: projectB,
				protocol: 'oidc',
				name: 'c',
				slug,
				enabled: true,
				domains: [],
			})
			.returning()
		const raw = `inkscim_${randomUUID().replace(/-/g, '')}`
		scimToken = raw
		await app.db.insert(scimTokens).values({
			connectionId: connection.id,
			name: 't',
			tokenHash: createHash('sha256').update(raw).digest('hex'),
			tokenPrefix: raw.slice(0, 16),
		})
		attackerToken = await createJwt({
			id: attackerId,
			email: attacker.email,
			name: 'Att',
			role: 'editor',
		})
	})

	afterAll(async () => {
		await app.db.delete(projects).where(eq(projects.id, projectA))
		await app.db.delete(projects).where(eq(projects.id, projectB))
		for (const id of cleanupUsers) await app.db.delete(users).where(eq(users.id, id))
		await app?.close()
	})

	const scim = (method: 'POST' | 'PATCH', url: string, payload: unknown) =>
		app.inject({
			method,
			url,
			headers: { authorization: `Bearer ${scimToken}`, 'content-type': 'application/json' },
			payload: payload as Record<string, unknown>,
		})

	it('SCIM cannot adopt a user who belongs to another tenant', async () => {
		const [victim] = await app.db.select().from(users).where(eq(users.id, victimId))
		const res = await scim('POST', `/api/v1/scim/${slug}/v2/Users`, {
			schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'],
			userName: victim.email,
			externalId: 'x',
		})
		expect(res.statusCode).toBe(409)
		const identities = await app.db
			.select()
			.from(userIdentities)
			.where(eq(userIdentities.userId, victimId))
		expect(identities).toHaveLength(0)
		const members = await app.db
			.select()
			.from(projectMembers)
			.where(and(eq(projectMembers.userId, victimId), eq(projectMembers.projectId, projectB)))
		expect(members).toHaveLength(0)
	})

	it('SCIM adopts an existing member of its own project and cannot rewrite a shared email', async () => {
		const [member] = await app.db.select().from(users).where(eq(users.id, memberId))
		const res = await scim('POST', `/api/v1/scim/${slug}/v2/Users`, {
			schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'],
			userName: member.email,
			externalId: 'm1',
		})
		expect(res.statusCode).toBe(201)
		// Give the member a password: the account is now not tenant-owned.
		await app.db.update(users).set({ passwordHash: 'pw' }).where(eq(users.id, memberId))
		const patch = await scim('PATCH', `/api/v1/scim/${slug}/v2/Users/${memberId}`, {
			Operations: [{ op: 'replace', path: 'userName', value: 'stolen@evil.example' }],
		})
		expect(patch.statusCode).toBe(409)
		const [after] = await app.db.select().from(users).where(eq(users.id, memberId))
		expect(after.email).toBe(member.email)
	})

	it('SSO JIT login refuses to link an existing non-member account', async () => {
		const [victim] = await app.db.select().from(users).where(eq(users.id, victimId))
		const reply = { setCookie: () => reply } as never
		await expect(
			completeSsoLogin(app, {
				connection,
				profile: { subject: 'idp-sub-1', email: victim.email, raw: {} },
				reply,
				intent: 'login',
			}),
		).rejects.toMatchObject({ code: 'account_exists' } satisfies Partial<SsoError>)
		const identities = await app.db
			.select()
			.from(userIdentities)
			.where(eq(userIdentities.userId, victimId))
		expect(identities).toHaveLength(0)
	})

	it('refuses an SSO slug already used by another project', async () => {
		const res = await app.inject({
			method: 'POST',
			url: '/api/v1/ee/sso/connections',
			headers: { authorization: `Bearer ${attackerToken}`, 'x-project-id': projectB },
			payload: { protocol: 'oidc', name: 'dup', slug },
		})
		expect(res.statusCode).toBe(409)
	})
})
