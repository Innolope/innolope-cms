import { createPublicKey, createVerify } from 'node:crypto'
import { licenseSettings } from '@innolope/db'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import fp from 'fastify-plugin'

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

export interface LicenseEvaluation {
	valid: boolean
	payload: LicensePayload | null
	error?: string
}

declare module 'fastify' {
	interface FastifyInstance {
		license: {
			valid: boolean
			payload: LicensePayload | null
			hasFeature: (feature: LicenseFeature) => boolean
			maxProjects: number
			// Re-reads the active key (DB row, falling back to env) and re-evaluates.
			reload: () => Promise<void>
		}
		requireLicense: (
			feature: LicenseFeature,
		) => (request: FastifyRequest, reply: FastifyReply) => Promise<void>
	}
}

// Public key for license verification (shipped with the product).
// Community/open-source builds ship the placeholder below and cannot validate paid
// licenses — they run as free tier. Production builds inject a real key, either by
// replacing the constant below or via the INNOLOPE_LICENSE_PUBLIC_KEY env var.
// Generate keypair: openssl genrsa -out license-private.pem 2048
//                   openssl rsa -in license-private.pem -pubout -out license-public.pem
const PLACEHOLDER_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA0placeholder0000000
0000000000000000000000000000000000000000000000000000000000000000
0000000000000000000000000000000000000000000000000000000000000000
0000000000000000000000000000000000000000000000000000000000000000
000000000000000000000000000000000000000000000000000000000000AQAB
-----END PUBLIC KEY-----`

const PUBLIC_KEY = process.env.INNOLOPE_LICENSE_PUBLIC_KEY || PLACEHOLDER_PUBLIC_KEY
const HAS_REAL_PUBLIC_KEY = !PUBLIC_KEY.includes('placeholder')

const ALL_FEATURES: LicenseFeature[] = [
	'sso',
	'audit-log',
	'ai-assistant',
	'multiple-projects',
	'webhooks',
	'scheduling',
	'custom-roles',
	'white-label',
	'review-workflows',
	'media-integrations',
]

export function decodeLicenseKey(
	key: string,
): { payload: LicensePayload; payloadStr: string; signature: string } | null {
	try {
		const raw = key.startsWith('ink-lic_') ? key.slice(8) : key
		const decoded = Buffer.from(raw, 'base64').toString('utf-8')
		const { payload, signature } = JSON.parse(decoded) as {
			payload: string
			signature: string
		}
		// `signature` is computed over the raw `payload` string, so it must be preserved
		// verbatim — re-serializing the parsed object would change key order/whitespace.
		return { payload: JSON.parse(payload) as LicensePayload, payloadStr: payload, signature }
	} catch {
		return null
	}
}

export function verifySignature(
	payloadStr: string,
	signature: string,
	publicKeyPem: string = PUBLIC_KEY,
): boolean {
	try {
		const publicKey = createPublicKey(publicKeyPem)
		const verifier = createVerify('SHA256')
		verifier.update(payloadStr)
		return verifier.verify(publicKey, signature, 'base64')
	} catch {
		return false
	}
}

// Pure evaluation of a license key. Returns a structured result so callers (the
// activation endpoint) can surface a specific reason for rejection.
export function evaluateLicense(key: string | undefined | null): LicenseEvaluation {
	if (!key) return { valid: false, payload: null }

	const decoded = decodeLicenseKey(key)
	if (!decoded) {
		return { valid: false, payload: null, error: 'Invalid license key format.' }
	}
	if (!HAS_REAL_PUBLIC_KEY) {
		// Community/open-source build: no public key to verify against. A license key
		// cannot be trusted, so we never grant paid features.
		return {
			valid: false,
			payload: null,
			error:
				'This build has no license public key. Set INNOLOPE_LICENSE_PUBLIC_KEY to enable paid licenses.',
		}
	}
	if (!verifySignature(decoded.payloadStr, decoded.signature)) {
		return { valid: false, payload: null, error: 'License signature verification failed.' }
	}
	if (new Date(decoded.payload.expiresAt) <= new Date()) {
		return {
			valid: false,
			payload: null,
			error: `License expired on ${decoded.payload.expiresAt}.`,
		}
	}
	return { valid: true, payload: decoded.payload }
}

export const licensePlugin = fp(async (app: FastifyInstance) => {
	const cloudMode = process.env.CLOUD_MODE === 'true'

	const license = {
		valid: false,
		payload: null as LicensePayload | null,
		maxProjects: 1,
		hasFeature: (_feature: LicenseFeature) => false,
		reload: async () => {},
	}

	license.hasFeature = (feature: LicenseFeature): boolean => {
		if (!license.valid || !license.payload) return false
		return license.payload.features.includes(feature)
	}

	license.reload = async () => {
		// Cloud mode: all features enabled without a license key.
		if (cloudMode) {
			license.valid = true
			license.payload = {
				org: 'Innolope Cloud',
				email: 'cloud@innolope.com',
				plan: 'enterprise',
				features: [...ALL_FEATURES],
				maxProjects: -1,
				expiresAt: '2099-12-31T00:00:00Z',
				issuedAt: new Date().toISOString(),
			}
			license.maxProjects = -1
			app.log.info('License: Cloud mode — all features enabled')
			return
		}

		// Resolve the active key: DB row first, INNOLOPE_LICENSE_KEY env var second.
		let key: string | null | undefined = process.env.INNOLOPE_LICENSE_KEY
		try {
			const [row] = await app.db.select().from(licenseSettings).limit(1)
			if (row?.licenseKey) key = row.licenseKey
		} catch {
			app.log.warn('License: could not read license_settings table — falling back to env var')
		}

		const result = evaluateLicense(key)
		license.valid = result.valid
		license.payload = result.valid ? result.payload : null
		license.maxProjects = result.valid && result.payload ? result.payload.maxProjects : 1

		if (result.valid && result.payload) {
			app.log.info(
				`License: ${result.payload.plan} plan for ${result.payload.org} (expires ${result.payload.expiresAt})`,
			)
		} else if (key && result.error) {
			app.log.warn(`License: ${result.error} — running in free tier`)
		} else {
			app.log.info('License: Community (free tier)')
		}
	}

	await license.reload()

	app.decorate('license', license)

	// Middleware for gating enterprise features
	const requireLicense =
		(feature: LicenseFeature) => async (_request: FastifyRequest, reply: FastifyReply) => {
			if (!license.hasFeature(feature)) {
				return reply.status(403).send({
					error: `This feature requires an Innolope ${feature === 'ai-assistant' || feature === 'media-integrations' ? 'Pro' : 'Enterprise'} license.`,
					feature,
					upgradeUrl: 'https://innolope.com/apps/cms#pricing',
				})
			}
		}

	app.decorate('requireLicense', requireLicense)

	// License info endpoint (public — so admin UI can check)
	app.get('/api/v1/license', async () => ({
		valid: license.valid,
		plan: license.payload?.plan || 'community',
		org: license.payload?.org || null,
		features: license.payload?.features || [],
		maxProjects: license.maxProjects,
		expiresAt: license.payload?.expiresAt || null,
		cloudMode,
	}))
})
