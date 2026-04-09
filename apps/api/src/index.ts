import { envSchema } from '@innolope/config'
import { buildApp } from './app.js'

// Validate environment upfront
const env = envSchema.safeParse(process.env)
if (!env.success) {
	const missing = env.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`)
	console.error('Invalid environment variables:\n' + missing.join('\n'))
	if (process.env.NODE_ENV === 'production') process.exit(1)
}

const app = await buildApp()

const port = Number(process.env.API_PORT) || 3001
const host = process.env.API_HOST || '0.0.0.0'

// Graceful shutdown
const shutdown = async (signal: string) => {
	app.log.info(`${signal} received, shutting down...`)
	await app.close()
	process.exit(0)
}
process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))

try {
	await app.listen({ port, host })
	console.log(`Innolope CMS API running at http://${host}:${port}`)
} catch (err) {
	app.log.error(err)
	process.exit(1)
}
