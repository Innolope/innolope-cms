import { randomUUID } from 'node:crypto'
import { mcpFeedback, users } from '@innolope/db'
import { eq, inArray } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createJwt } from '../plugins/auth.js'
import { buildTestApp, hasTestDb } from '../test/harness.js'

describe.skipIf(!hasTestDb)('/api/v1/feedback (real Postgres)', () => {
	let app: FastifyInstance
	let adminToken: string
	let editorToken: string
	const userIds: string[] = []
	const feedbackIds: string[] = []

	beforeAll(async () => {
		app = await buildTestApp()
		const short = randomUUID().slice(0, 8)

		const [admin] = await app.db
			.insert(users)
			.values({ email: `fb-admin-${short}@example.com`, name: 'FB Admin', role: 'admin' })
			.returning()
		const [editor] = await app.db
			.insert(users)
			.values({ email: `fb-editor-${short}@example.com`, name: 'FB Editor', role: 'editor' })
			.returning()
		userIds.push(admin.id, editor.id)
		adminToken = await createJwt({
			id: admin.id,
			email: admin.email,
			name: admin.name,
			role: 'admin',
		})
		editorToken = await createJwt({
			id: editor.id,
			email: editor.email,
			name: editor.name,
			role: 'editor',
		})
	})

	afterAll(async () => {
		if (app) {
			if (feedbackIds.length) {
				await app.db.delete(mcpFeedback).where(inArray(mcpFeedback.id, feedbackIds))
			}
			for (const id of userIds) await app.db.delete(users).where(eq(users.id, id))
		}
		await app?.close()
	})

	it('saves feedback to the database', async () => {
		const res = await app.inject({
			method: 'POST',
			url: '/api/v1/feedback',
			headers: { authorization: `Bearer ${editorToken}` },
			payload: {
				type: 'bug',
				tool: 'get_content',
				summary: 'Metadata block missing on read-back',
				details: 'Created via create_content, get_content showed only markdown.',
			},
		})
		expect(res.statusCode).toBe(201)
		const { id } = res.json()
		feedbackIds.push(id)

		const [row] = await app.db.select().from(mcpFeedback).where(eq(mcpFeedback.id, id))
		expect(row).toBeDefined()
		expect(row.type).toBe('bug')
		expect(row.tool).toBe('get_content')
		expect(row.summary).toContain('Metadata block')
	})

	it('silently drops an unknown projectId (attribution only, never rejects)', async () => {
		const res = await app.inject({
			method: 'POST',
			url: '/api/v1/feedback',
			headers: { authorization: `Bearer ${editorToken}` },
			payload: {
				type: 'suggestion',
				summary: 'Add cursor pagination',
				projectId: randomUUID(),
			},
		})
		expect(res.statusCode).toBe(201)
		const { id } = res.json()
		feedbackIds.push(id)
		const [row] = await app.db.select().from(mcpFeedback).where(eq(mcpFeedback.id, id))
		expect(row.projectId).toBeNull()
	})

	it('rejects oversized or malformed feedback', async () => {
		const res = await app.inject({
			method: 'POST',
			url: '/api/v1/feedback',
			headers: { authorization: `Bearer ${editorToken}` },
			payload: { type: 'rant', summary: 'x' },
		})
		expect(res.statusCode, res.body).toBe(400)
	})

	it('lists feedback for account admins, newest first', async () => {
		const res = await app.inject({
			method: 'GET',
			url: '/api/v1/feedback?type=bug',
			headers: { authorization: `Bearer ${adminToken}` },
		})
		expect(res.statusCode).toBe(200)
		const body = res.json()
		expect(body.data.some((r: { id: string }) => r.id === feedbackIds[0])).toBe(true)
		expect(body.data.every((r: { type: string }) => r.type === 'bug')).toBe(true)
	})

	it('denies the feedback log to non-admins', async () => {
		const res = await app.inject({
			method: 'GET',
			url: '/api/v1/feedback',
			headers: { authorization: `Bearer ${editorToken}` },
		})
		expect(res.statusCode).toBe(403)
	})
})
