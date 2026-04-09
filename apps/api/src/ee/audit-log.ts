import type { FastifyInstance } from 'fastify'
import { desc, eq, sql } from 'drizzle-orm'

// EE Feature: Audit Logs
// Requires license: 'audit-log'

export async function auditLogRoutes(app: FastifyInstance) {
	// List audit logs (admin+, project-scoped, requires license)
	app.get(
		'/',
		{ preHandler: [app.requireProject('admin'), app.requireLicense('audit-log')] },
		async (request) => {
			// TODO: Query from audit_logs table once schema is created
			return { data: [], message: 'Audit logs coming soon' }
		},
	)
}

// Middleware to log actions (called from content/media/auth routes)
export function createAuditLogger(app: FastifyInstance) {
	return async (action: string, details: Record<string, unknown>) => {
		if (!app.license.hasFeature('audit-log')) return
		// TODO: Insert into audit_logs table
		app.log.info({ action, ...details }, 'Audit log')
	}
}
