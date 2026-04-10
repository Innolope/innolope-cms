import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import fp from 'fastify-plugin'
import { createPublicKey, createVerify } from 'node:crypto'

export type LicenseFeature =
	| 'sso'
	| 'audit-log'
	| 'ai-assistant'
	| 'multiple-projects'
	| 'webhooks'
	| 'scheduling'
	| 'custom-roles'
	| 'white-label'
	| 'review-workflows'
	| 'media-integrations'

export interface LicensePayload {
	org: string
	email: string
	plan: 'pro' | 'enterprise'
	features: LicenseFeature[]
	maxProjects: number // -1 = unlimited
	expiresAt: string
	issuedAt: string
}

declare module 'fastify' {
	interface FastifyInstance {
		license: {
			valid: boolean
			payload: LicensePayload | null
			hasFeature: (feature: LicenseFeature) => boolean
			maxProjects: number
		}
		requireLicense: (
			feature: LicenseFeature,
		) => (request: FastifyRequest, reply: FastifyReply) => Promise<void>
	}
}

// Public key for license verification (shipped with the product)
// Generate keypair: openssl genrsa -out license-private.pem 2048
//                   openssl rsa -in license-private.pem -pubout -out license-public.pem
const PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA0placeholder0000000
0000000000000000000000000000000000000000000000000000000000000000
0000000000000000000000000000000000000000000000000000000000000000
0000000000000000000000000000000000000000000000000000000000000000
000000000000000000000000000000000000000000000000000000000000AQAB
-----END PUBLIC KEY-----`

function decodeLicenseKey(key: string): { payload: LicensePayload; signature: string } | null {
	try {
		const raw = key.startsWith('ink-lic_') ? key.slice(8) : key
		const decoded = Buffer.from(raw, 'base64').toString('utf-8')
		const { payload, signature } = JSON.parse(decoded) as {
			payload: string
			signature: string
		}
		return { payload: JSON.parse(payload) as LicensePayload, signature }
	} catch {
		return null
	}
}

function verifySignature(payloadStr: string, signature: string): boolean {
	try {
		const publicKey = createPublicKey(PUBLIC_KEY)
		const verifier = createVerify('SHA256')
		verifier.update(payloadStr)
		return verifier.verify(publicKey, signature, 'base64')
	} catch {
		// If public key is placeholder (dev/open-source), skip verification
		return false
	}
}

export const licensePlugin = fp(async (app: FastifyInstance) => {
	const licenseKey = process.env.INNOLOPE_LICENSE_KEY

	let valid = false
	let payload: LicensePayload | null = null

	// Cloud mode: all features enabled without license key
	if (process.env.CLOUD_MODE === 'true') {
		valid = true
		payload = {
			org: 'Innolope Cloud',
			email: 'cloud@innolope.com',
			plan: 'enterprise',
			features: [
				'sso', 'audit-log', 'ai-assistant', 'multiple-projects',
				'webhooks', 'scheduling', 'custom-roles', 'white-label', 'review-workflows',
			],
			maxProjects: -1,
			expiresAt: '2099-12-31T00:00:00Z',
			issuedAt: new Date().toISOString(),
		}
		app.log.info('License: Cloud mode — all features enabled')
	} else if (licenseKey) {
		const decoded = decodeLicenseKey(licenseKey)
		if (decoded) {
			// Check expiry
			const now = new Date()
			const expires = new Date(decoded.payload.expiresAt)
			if (expires > now) {
				valid = true
				payload = decoded.payload
				app.log.info(
					`License: ${decoded.payload.plan} plan for ${decoded.payload.org} (expires ${decoded.payload.expiresAt})`,
				)
			} else {
				app.log.warn(`License expired on ${decoded.payload.expiresAt} — reverting to free tier`)
			}
		} else {
			app.log.warn('Invalid license key format — running in free tier')
		}
	} else {
		app.log.info('License: Community (free tier)')
	}

	const hasFeature = (feature: LicenseFeature): boolean => {
		if (!valid || !payload) return false
		return payload.features.includes(feature)
	}

	app.decorate('license', {
		valid,
		payload,
		hasFeature,
		maxProjects: valid && payload ? payload.maxProjects : 1,
	})

	// Middleware for gating enterprise features
	const requireLicense =
		(feature: LicenseFeature) =>
		async (_request: FastifyRequest, reply: FastifyReply) => {
			if (!hasFeature(feature)) {
				return reply.status(403).send({
					error: `This feature requires an Innolope ${feature === 'ai-assistant' ? 'Pro' : 'Enterprise'} license.`,
					feature,
					upgradeUrl: 'https://innolope.dev/pricing',
				})
			}
		}

	app.decorate('requireLicense', requireLicense)

	// License info endpoint (public — so admin UI can check)
	app.get('/api/v1/license', async () => ({
		valid,
		plan: payload?.plan || 'community',
		org: payload?.org || null,
		features: payload?.features || [],
		maxProjects: valid && payload ? payload.maxProjects : 1,
		expiresAt: payload?.expiresAt || null,
		cloudMode: process.env.CLOUD_MODE === 'true',
	}))
})
