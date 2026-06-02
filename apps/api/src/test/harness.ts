import type { FastifyInstance } from 'fastify'

/**
 * Integration tests run against a real Postgres reachable at `TEST_DATABASE_URL`
 * with migrations already applied. They are skipped when the variable is unset
 * (local runs without a database); CI provides a Postgres service container.
 */
export const TEST_DB_URL = process.env.TEST_DATABASE_URL
export const hasTestDb = Boolean(TEST_DB_URL)

/**
 * Boot the full Fastify app wired to the test database. `buildApp` is imported
 * dynamically so that, when the suite is skipped, none of the app's module graph
 * (DB driver, plugins) is loaded.
 */
export async function buildTestApp(): Promise<FastifyInstance> {
	if (!TEST_DB_URL) {
		throw new Error('TEST_DATABASE_URL must be set to build the integration test app')
	}
	process.env.DATABASE_URL = TEST_DB_URL
	process.env.AUTH_SECRET ??= 'test-secret-at-least-32-characters-long'
	process.env.ADMIN_URL ??= 'http://localhost:5173'
	process.env.NODE_ENV ??= 'test'
	// Enable all enterprise features (incl. audit-log) so integration tests can
	// exercise EE paths without a signed license key.
	process.env.CLOUD_MODE ??= 'true'

	const { buildApp } = await import('../app.js')
	const app = await buildApp()
	await app.ready()
	return app
}
