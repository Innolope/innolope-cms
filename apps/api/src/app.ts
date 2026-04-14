import cookie from '@fastify/cookie'
import cors from '@fastify/cors'
import helmet from '@fastify/helmet'
import rateLimit from '@fastify/rate-limit'
import fastifyStatic from '@fastify/static'
import Fastify from 'fastify'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { dbPlugin } from './plugins/db.js'
import { authPlugin } from './plugins/auth.js'
import { eventsPlugin } from './plugins/events.js'
import { licensePlugin } from './plugins/license.js'
import { projectPlugin } from './plugins/project.js'
import { emailPlugin } from './plugins/email.js'
import { mediaPlugin } from './plugins/media.js'
import { auditLogRoutes } from './ee/audit-log.js'
import { webhookRoutes } from './ee/webhooks.js'
import { schedulingRoutes } from './ee/scheduling.js'
import { databaseRoutes } from './routes/v1/database.js'
import { aiRoutes } from './routes/v1/ai.js'
import { authRoutes } from './routes/v1/auth.js'
import { contentRoutes } from './routes/v1/content.js'
import { collectionRoutes } from './routes/v1/collections.js'
import { localeRoutes } from './routes/v1/locales.js'
import { mediaRoutes } from './routes/v1/media.js'
import { projectRoutes } from './routes/v1/projects.js'
import { statsRoutes } from './routes/v1/stats.js'
import { streamRoutes } from './routes/v1/stream.js'
import { unsplashRoutes } from './routes/v1/unsplash.js'
import { passwordResetRoutes } from './routes/v1/password-reset.js'
import { inviteRoutes } from './routes/v1/invites.js'
import { exportRoutes } from './routes/v1/export.js'
import { semanticSearchRoutes } from './routes/v1/semantic-search.js'
import { posthogPlugin } from './plugins/posthog.js'
import { initWebhookDispatcher } from './services/webhook-dispatch.js'
import { initAutoEmbedding } from './services/embedding.js'

export async function buildApp() {
	const app = Fastify({
		logger: {
			level: process.env.LOG_LEVEL || 'info',
			transport: {
				target: 'pino-pretty',
				options: {
					colorize: true,
					translateTime: 'HH:MM:ss Z',
					ignore: 'pid,hostname',
				},
			},
		},
		disableRequestLogging: true,
		bodyLimit: 10 * 1024 * 1024, // 10MB
	})

	await app.register(helmet, {
		contentSecurityPolicy: {
			directives: {
				defaultSrc: ["'self'"],
				scriptSrc: ["'self'"],
				styleSrc: ["'self'", "'unsafe-inline'"],
				imgSrc: ["'self'", 'data:', 'https:'],
				connectSrc: ["'self'"],
				fontSrc: ["'self'"],
				objectSrc: ["'none'"],
				frameAncestors: ["'none'"],
			},
		},
	})

	await app.register(cookie, {
		secret: process.env.AUTH_SECRET,
	})

	await app.register(cors, {
		origin: process.env.ADMIN_URL || 'http://localhost:5173',
		credentials: true,
	})

	await app.register(rateLimit, { max: 200, timeWindow: '1 minute' })

	// CSRF protection: validate double-submit cookie on state-changing requests
	app.addHook('onRequest', async (request, reply) => {
		if (['GET', 'HEAD', 'OPTIONS'].includes(request.method)) return
		// Skip CSRF for API key auth (machine-to-machine)
		const authHeader = request.headers.authorization
		if (authHeader?.startsWith('Bearer ink_')) return
		// Skip for public auth endpoints that don't have a session yet
		const path = request.url.split('?')[0]
		const csrfExemptPaths = ['/api/v1/auth/login', '/api/v1/auth/register', '/api/v1/auth/logout', '/api/v1/auth/refresh', '/api/v1/auth/forgot-password', '/api/v1/auth/reset-password', '/api/v1/invites/accept']
		if (csrfExemptPaths.some(p => path.startsWith(p))) return

		const cookieToken = request.cookies['innolope_csrf']
		const headerToken = request.headers['x-csrf-token'] as string | undefined
		if (!cookieToken || !headerToken || cookieToken !== headerToken) {
			return reply.status(403).send({ error: 'CSRF token missing or invalid' })
		}
	})

	// Plugins
	await app.register(dbPlugin)
	await app.register(licensePlugin)
	await app.register(authPlugin)
	await app.register(projectPlugin)
	await app.register(eventsPlugin)
	await app.register(posthogPlugin)
	initWebhookDispatcher(app)
	initAutoEmbedding(app)
	await app.register(emailPlugin)
	await app.register(mediaPlugin)

	// Health check (public)
	app.get('/api/v1/health', async (_request, reply) => {
		const health: Record<string, unknown> = {
			status: 'ok',
			name: 'Innolope CMS',
			version: '0.1.0',
			timestamp: new Date().toISOString(),
		}

		if (app.db) {
			try {
				const { sql: rawSql } = await import('drizzle-orm')
				await app.db.execute(rawSql`SELECT 1`)
				health.database = 'connected'
			} catch {
				health.status = 'degraded'
				health.database = 'disconnected'
				reply.status(503)
			}
		} else {
			health.database = 'not configured'
		}

		return health
	})

	// Auth routes (no project context needed)
	await app.register(authRoutes, { prefix: '/api/v1/auth' })
	await app.register(passwordResetRoutes, { prefix: '/api/v1/auth' })
	await app.register(inviteRoutes, { prefix: '/api/v1/invites' })

	// Project routes (user-scoped, project context resolved per-route)
	await app.register(projectRoutes, { prefix: '/api/v1/projects' })
	await app.register(databaseRoutes, { prefix: '/api/v1/projects' })

	// Project-scoped data routes
	await app.register(aiRoutes, { prefix: '/api/v1/ai' })
	await app.register(exportRoutes, { prefix: '/api/v1/content/export' })
	await app.register(semanticSearchRoutes, { prefix: '/api/v1/content/semantic-search' })
	await app.register(contentRoutes, { prefix: '/api/v1/content' })
	await app.register(collectionRoutes, { prefix: '/api/v1/collections' })
	await app.register(localeRoutes, { prefix: '/api/v1/locales' })
	await app.register(mediaRoutes, { prefix: '/api/v1/media' })
	await app.register(statsRoutes, { prefix: '/api/v1/stats' })
	await app.register(streamRoutes, { prefix: '/api/v1/stream' })
	await app.register(unsplashRoutes, { prefix: '/api/v1/unsplash' })

	// Enterprise Edition routes
	await app.register(auditLogRoutes, { prefix: '/api/v1/ee/audit-logs' })
	await app.register(webhookRoutes, { prefix: '/api/v1/ee/webhooks' })
	await app.register(schedulingRoutes, { prefix: '/api/v1/ee/scheduling' })

	// Serve admin UI static files in production (cloud deployment)
	const adminDistPath = resolve(process.cwd(), 'apps/admin/dist')
	if (process.env.NODE_ENV === 'production' && existsSync(adminDistPath)) {
		await app.register(fastifyStatic, {
			root: adminDistPath,
			prefix: '/',
		})
		app.log.info(`Serving admin UI from ${adminDistPath}`)
	}

	// Global error handler
	app.setErrorHandler(async (error: Error & { statusCode?: number }, request, reply) => {
		app.log.error(error)
		const statusCode = error.statusCode || 500
		// Report 5xx errors to Sentry
		if (statusCode >= 500 && process.env.SENTRY_DSN) {
			try {
				const Sentry = await import('@sentry/node')
				Sentry.captureException(error, {
					extra: { url: request.url, method: request.method },
				})
			} catch (e) {
				app.log.error(e)
			}
		}
		reply.status(statusCode).send({
			error: statusCode >= 500 ? 'Internal server error' : error.message,
			statusCode,
		})
	})

	// 404 handler — serve index.html for SPA routes in production, JSON for API
	app.setNotFoundHandler((request, reply) => {
		if (request.url.startsWith('/api/')) {
			return reply.status(404).send({ error: 'Not found', statusCode: 404 })
		}
		// SPA fallback
		if (process.env.NODE_ENV === 'production' && existsSync(join(adminDistPath, 'index.html'))) {
			return reply.sendFile('index.html', adminDistPath)
		}
		return reply.status(404).send({ error: 'Not found', statusCode: 404 })
	})

	return app
}
