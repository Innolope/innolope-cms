import { auditLogs } from '@innolope/db'
import { and, desc, eq, sql } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import fp from 'fastify-plugin'
import { getProject } from '../plugins/project.js'

// EE Feature: Audit Logs — requires license 'audit-log'.

const VERB_BY_METHOD: Record<string, string> = {
	POST: 'create',
	PUT: 'update',
	PATCH: 'update',
	DELETE: 'delete',
}

// A path segment that looks like a resource id (UUID or numeric).
const ID_SEGMENT = /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|\d+)$/i

export interface DerivedAction {
	action: string
	resourceType: string | null
	resourceId: string | null
}

/**
 * Derive a semantic action + resource from a request method and path.
 * `POST /api/v1/content` → `content.create`; `PATCH /api/v1/content/<uuid>` →
 * `content.update`; `POST /api/v1/content/<uuid>/publish` → `content.publish`.
 */
export function deriveAuditAction(method: string, path: string): DerivedAction {
	let segments = path.split('?')[0].split('/').filter(Boolean)
	// Drop the `/api/v1` (and `/ee`) prefix so the first remaining segment is the resource.
	if (segments[0] === 'api') segments = segments.slice(1)
	if (segments[0] === 'v1') segments = segments.slice(1)
	if (segments[0] === 'ee') segments = segments.slice(1)

	const resourceType = segments[0] ?? null
	let resourceId: string | null = null
	let subAction: string | null = null
	for (const seg of segments.slice(1)) {
		if (ID_SEGMENT.test(seg)) resourceId = seg
		else subAction = seg
	}

	const verb = subAction ?? VERB_BY_METHOD[method] ?? method.toLowerCase()
	const action = resourceType ? `${resourceType}.${verb}` : verb
	return { action, resourceType, resourceId }
}

/**
 * App-wide audit logging. Records every authenticated, state-changing request to
 * `audit_logs` after the response is sent. No-op unless the `audit-log` license
 * feature is active, so non-licensed installs pay only a boolean check.
 */
export const auditPlugin = fp(async (app: FastifyInstance) => {
	app.addHook('onResponse', async (request, reply) => {
		const { method } = request
		if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return
		if (!app.license.hasFeature('audit-log')) return

		// Only audit actions with a known actor. Unauthenticated POSTs (login,
		// register, IdP callbacks) carry no user and are out of scope here.
		const userId = request.user?.id ?? request.apiKeyAuth?.userId ?? null
		if (!userId) return

		const { action, resourceType, resourceId } = deriveAuditAction(method, request.url)

		try {
			await app.db.insert(auditLogs).values({
				projectId: request.project?.id ?? null,
				userId,
				userEmail: request.user?.email ?? null,
				action,
				method,
				path: request.url.split('?')[0],
				statusCode: reply.statusCode,
				resourceType,
				resourceId,
				ip: request.ip || null,
				userAgent: request.headers['user-agent'] ?? null,
			})
		} catch (err) {
			// Audit logging must never break the request lifecycle.
			app.log.warn(err, 'failed to write audit log')
		}
	})
})

export async function auditLogRoutes(app: FastifyInstance) {
	// List audit logs (admin+, project-scoped, requires license).
	app.get(
		'/',
		{ preHandler: [app.requireProject('admin'), app.requireLicense('audit-log')] },
		async (request) => {
			const projectId = getProject(request).id
			const query = request.query as { limit?: string; offset?: string; action?: string }

			const limit = Math.min(Math.max(Number(query.limit) || 50, 1), 200)
			const offset = Math.max(Number(query.offset) || 0, 0)

			const where = query.action
				? and(eq(auditLogs.projectId, projectId), eq(auditLogs.action, query.action))
				: eq(auditLogs.projectId, projectId)

			const rows = await app.db
				.select()
				.from(auditLogs)
				.where(where)
				.orderBy(desc(auditLogs.createdAt))
				.limit(limit)
				.offset(offset)

			const [{ total }] = await app.db
				.select({ total: sql<number>`count(*)::int` })
				.from(auditLogs)
				.where(where)

			return { data: rows, pagination: { limit, offset, total } }
		},
	)
}
