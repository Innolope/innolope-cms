import { decryptSecret, encryptSecret } from './crypto.js'

/**
 * Secrets that live inside `projects.settings` (Cloudflare API tokens, R2 keys,
 * imported-media signing keys, cover-template bearer tokens) are sealed with
 * the same AES-256-GCM key as OAuth tokens and SSO client secrets whenever that
 * key is configured. Values are prefixed so a reader can tell sealed from
 * legacy plaintext and both keep working; an instance with no encryption key
 * stores plaintext exactly as before and is warned once.
 */
const PREFIX = 'enc:v1:'

let warned = false
function hasKey(): boolean {
	const ok = Boolean(process.env.SSO_ENCRYPTION_KEY || process.env.INTEGRATION_ENCRYPTION_KEY)
	if (!ok && !warned) {
		warned = true
		console.warn(
			'[innolope] INTEGRATION_ENCRYPTION_KEY is not set — project secrets are stored in plaintext. Set a 32-byte base64 key to encrypt them at rest.',
		)
	}
	return ok
}

export function isSealed(value: unknown): value is string {
	return typeof value === 'string' && value.startsWith(PREFIX)
}

/** Encrypt a secret for storage. Non-strings, empty strings and sealed values pass through. */
export function sealSecret<T>(value: T): T | string {
	if (typeof value !== 'string' || value === '' || isSealed(value)) return value
	if (!hasKey()) return value
	return `${PREFIX}${encryptSecret(value)}`
}

/** Decrypt a stored secret. Plaintext (legacy or keyless) passes through unchanged. */
export function revealSecret(value: unknown): string | undefined {
	if (typeof value !== 'string') return undefined
	if (!isSealed(value)) return value
	try {
		return decryptSecret(value.slice(PREFIX.length))
	} catch {
		// Wrong/missing key: better an unusable credential than a crash on read.
		return undefined
	}
}

const MEDIA_CREDENTIAL_KEYS = ['apiToken', 'signingKey', 'secretAccessKey'] as const

type Credentials = Record<string, unknown> | undefined

export function sealMediaCredentials<T extends object | undefined>(creds: T): T {
	if (!creds) return creds
	const out: Record<string, unknown> = { ...(creds as Record<string, unknown>) }
	for (const k of MEDIA_CREDENTIAL_KEYS) if (k in out) out[k] = sealSecret(out[k])
	return out as T
}

export function revealMediaCredentials<T extends object | undefined>(creds: T): T {
	if (!creds) return creds
	const out: Record<string, unknown> = { ...(creds as Record<string, unknown>) }
	for (const k of MEDIA_CREDENTIAL_KEYS) if (k in out) out[k] = revealSecret(out[k])
	return out as T
}

/** Seal every secret-bearing field of a full project settings object before it is written. */
export function sealProjectSettings(settings: Record<string, unknown>): Record<string, unknown> {
	const next = { ...settings }
	const cf = next.cloudflare as Record<string, unknown> | undefined
	if (cf) {
		next.cloudflare = {
			...cf,
			apiToken: sealSecret(cf.apiToken),
			r2SecretAccessKey: sealSecret(cf.r2SecretAccessKey),
		}
	}
	const covers = next.covers as Record<string, unknown> | undefined
	if (covers?.templateToken !== undefined) {
		next.covers = { ...covers, templateToken: sealSecret(covers.templateToken) }
	}
	const ext = next.externalDb as Record<string, unknown> | undefined
	const media = ext?.mediaStorage as Record<string, Record<string, unknown>> | undefined
	if (ext && media) {
		next.externalDb = {
			...ext,
			mediaStorage: Object.fromEntries(
				Object.entries(media).map(([table, entry]) => [
					table,
					{ ...entry, credentials: sealMediaCredentials(entry.credentials as Credentials) },
				]),
			),
		}
	}
	return next
}
