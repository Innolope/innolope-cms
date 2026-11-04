import type { FastifyInstance } from 'fastify'
import { ZodError } from 'zod'
import { ExternalWriteError, externalFailureBody } from '../services/external-errors.js'
import { redactRequestUrl } from './request-url.js'

export function registerRequestErrors(app: FastifyInstance) {
	app.setErrorHandler(async (error: Error & { statusCode?: number }, request, reply) => {
		// Schema validation failures are client errors — surface them as 400, not 500.
		// Matched by instanceof AND by shape: zod is dual-published (CJS + ESM), so a
		// ZodError thrown by a module that resolved the other build fails instanceof
		// against this file's copy (bit us under vitest's module graph).
		const zodError =
			error instanceof ZodError ||
			(error.name === 'ZodError' && Array.isArray((error as unknown as ZodError).issues))
				? (error as unknown as ZodError)
				: null
		// A failed write to a connected database already knows which field caused it.
		if (error instanceof ExternalWriteError) {
			app.log.warn(
				{
					code: error.failure.code,
					detail: error.failure.detail,
					url: redactRequestUrl(request.url),
				},
				'External write failed',
			)
			return reply.status(error.statusCode).send(externalFailureBody(error.failure))
		}
		if (zodError) {
			app.log.info(
				{ issues: zodError.issues, url: redactRequestUrl(request.url), method: request.method },
				'Request validation failed',
			)
			return reply.status(400).send({
				error: 'Validation failed',
				statusCode: 400,
				issues: zodError.issues.map((issue) => ({
					path: issue.path.join('.'),
					message: issue.message,
				})),
			})
		}

		// Drizzle wraps DB driver errors and its top-level message is just
		// "Failed query: ..." with the SQL and params — the actual reason
		// ("column X does not exist", unique-constraint violation, etc.) lives
		// on `error.cause`. Pull it up so logs and 500 responses show it.
		const cause = (error as { cause?: unknown }).cause
		const pgCause =
			cause && typeof cause === 'object'
				? (cause as { message?: string; code?: string; detail?: string; hint?: string })
				: null

		app.log.error(
			{
				err: error,
				cause: pgCause ?? undefined,
				url: redactRequestUrl(request.url),
				method: request.method,
			},
			'Request failed',
		)
		const statusCode = error.statusCode || 500
		// Report 5xx errors to Sentry
		if (statusCode >= 500 && process.env.SENTRY_DSN) {
			try {
				const Sentry = await import('@sentry/node')
				Sentry.captureException(error, {
					extra: {
						url: redactRequestUrl(request.url),
						method: request.method,
						cause: pgCause ?? undefined,
					},
				})
			} catch (e) {
				app.log.error(e)
			}
		}
		// Never surface raw Postgres error text (message/detail/hint/schema) to the
		// client — it's captured in the server log and Sentry above. Clients get a
		// generic 5xx; 4xx keep their own (already client-safe) message, as do 5xx
		// errors whose message was written for the client (`expose`, e.g. an
		// upstream storage provider failing — the caller needs to know which step).
		const expose = (error as { expose?: boolean }).expose === true
		reply.status(statusCode).send({
			error: statusCode >= 500 && !expose ? 'Internal server error' : error.message,
			statusCode,
		})
	})
}
