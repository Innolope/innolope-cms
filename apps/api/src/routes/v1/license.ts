import { licenseSettings } from '@innolope/db'
import { eq } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { evaluateLicense } from '../../plugins/license.js'

function currentLicenseInfo(app: FastifyInstance) {
	return {
		valid: app.license.valid,
		plan: app.license.payload?.plan || 'community',
		org: app.license.payload?.org || null,
		features: app.license.payload?.features || [],
		maxProjects: app.license.maxProjects,
		expiresAt: app.license.payload?.expiresAt || null,
		cloudMode: process.env.CLOUD_MODE === 'true',
	}
}

export async function licenseRoutes(app: FastifyInstance) {
	// Activate / update the instance license key (admin only).
	app.put('/', { preHandler: [app.requireRole('admin')] }, async (request, reply) => {
		if (process.env.CLOUD_MODE === 'true') {
			return reply.status(400).send({ error: 'License cannot be modified in cloud mode.' })
		}

		const { key } = (request.body ?? {}) as { key?: string }
		const trimmed = typeof key === 'string' ? key.trim() : ''
		if (!trimmed) return reply.status(400).send({ error: 'A license key is required.' })

		const result = evaluateLicense(trimmed)
		if (!result.valid) {
			return reply.status(400).send({ error: result.error || 'License key is not valid.' })
		}

		const [existing] = await app.db.select().from(licenseSettings).limit(1)
		if (existing) {
			await app.db
				.update(licenseSettings)
				.set({ licenseKey: trimmed, updatedAt: new Date() })
				.where(eq(licenseSettings.id, existing.id))
		} else {
			await app.db.insert(licenseSettings).values({ licenseKey: trimmed })
		}

		await app.license.reload()
		return currentLicenseInfo(app)
	})

	// Remove the instance license key (admin only) — revert to community tier.
	app.delete('/', { preHandler: [app.requireRole('admin')] }, async (_request, reply) => {
		if (process.env.CLOUD_MODE === 'true') {
			return reply.status(400).send({ error: 'License cannot be modified in cloud mode.' })
		}

		const [existing] = await app.db.select().from(licenseSettings).limit(1)
		if (existing) {
			await app.db
				.update(licenseSettings)
				.set({ licenseKey: null, updatedAt: new Date() })
				.where(eq(licenseSettings.id, existing.id))
		}

		await app.license.reload()
		return currentLicenseInfo(app)
	})
}
