import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'

/** Literal substrings that flag a private/internal target before DNS resolution. */
const LITERAL_BLOCKED_PATTERNS = [
	'localhost',
	'127.0.0.1',
	'::1',
	'0.0.0.0',
	'10.',
	'172.16.',
	'172.17.',
	'172.18.',
	'172.19.',
	'172.20.',
	'172.21.',
	'172.22.',
	'172.23.',
	'172.24.',
	'172.25.',
	'172.26.',
	'172.27.',
	'172.28.',
	'172.29.',
	'172.30.',
	'172.31.',
	'192.168.',
	'169.254.',
	'.internal',
	'.local',
	'metadata.google',
]

/** Block connection strings targeting private/internal networks (SSRF protection). */
export async function validateConnectionString(connStr: string): Promise<string | null> {
	const lc = connStr.toLowerCase()
	for (const pattern of LITERAL_BLOCKED_PATTERNS) {
		if (lc.includes(pattern)) {
			return `Connection to private/internal addresses is not allowed (matched: ${pattern}).`
		}
	}

	const hostname = extractHostname(connStr)
	if (!hostname) return null
	return resolveHostnameGuard(hostname, 'Connection')
}

/**
 * Block outbound HTTP(S) requests to private/internal networks (SSRF protection)
 * for user-supplied URLs — webhooks, external content fetches, etc. Mirrors the
 * DB connection-string guard: literal-pattern screen, then DNS resolution so a
 * public hostname that resolves to a private address is still rejected.
 *
 * Returns an error string if the URL must be blocked, or null if it is allowed.
 */
export async function validatePublicUrl(rawUrl: string): Promise<string | null> {
	let parsed: URL
	try {
		parsed = new URL(rawUrl)
	} catch {
		return 'Invalid URL.'
	}
	if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
		return 'Only http and https URLs are allowed.'
	}
	const hostname = parsed.hostname.replace(/^\[|\]$/g, '')
	if (!hostname) return 'Invalid URL host.'
	const lc = hostname.toLowerCase()
	for (const pattern of LITERAL_BLOCKED_PATTERNS) {
		if (lc === pattern || lc.includes(pattern)) {
			return `Requests to private/internal addresses are not allowed (matched: ${pattern}).`
		}
	}
	return resolveHostnameGuard(hostname, 'Request')
}

/** Resolve a hostname and reject if any resolved address is private/internal. */
async function resolveHostnameGuard(
	hostname: string,
	subject: 'Connection' | 'Request',
): Promise<string | null> {
	let addresses: string[]
	if (isIP(hostname)) {
		addresses = [hostname]
	} else {
		try {
			const resolved = await lookup(hostname, { all: true, verbatim: true })
			addresses = resolved.map((entry) => entry.address)
		} catch {
			return null
		}
	}

	for (const address of addresses) {
		if (isPrivateAddress(address)) {
			return `${subject} to private/internal addresses is not allowed (resolved: ${address}).`
		}
	}
	return null
}

function extractHostname(connStr: string): string | null {
	try {
		const parsed = new URL(connStr)
		return parsed.hostname.replace(/^\[|\]$/g, '')
	} catch {
		return null
	}
}

function isPrivateAddress(address: string): boolean {
	if (address.includes(':')) {
		const normalized = address.toLowerCase()
		return (
			normalized === '::1' ||
			normalized === '::' ||
			normalized.startsWith('fc') ||
			normalized.startsWith('fd') ||
			normalized.startsWith('fe80:') ||
			normalized.startsWith('::ffff:127.') ||
			normalized.startsWith('::ffff:10.') ||
			normalized.startsWith('::ffff:192.168.') ||
			/^::ffff:172\.(1[6-9]|2\d|3[01])\./.test(normalized)
		)
	}

	const parts = address.split('.').map(Number)
	if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part))) return false
	const [a, b] = parts
	return (
		a === 10 ||
		a === 127 ||
		(a === 172 && b >= 16 && b <= 31) ||
		(a === 192 && b === 168) ||
		(a === 169 && b === 254) ||
		a === 0 ||
		a >= 224
	)
}

/** Parse a Firebase service-account JSON connection string, failing with a clear 400. */
export function parseFirebaseCredentials(connStr: string): Record<string, unknown> {
	let parsed: unknown
	try {
		parsed = JSON.parse(connStr)
	} catch {
		const err = new Error(
			'Invalid Firebase service-account JSON. Paste the full contents of the service-account key file.',
		) as Error & { statusCode?: number }
		err.statusCode = 400
		throw err
	}
	if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
		const err = new Error('Firebase credentials must be a JSON object.') as Error & {
			statusCode?: number
		}
		err.statusCode = 400
		throw err
	}
	return parsed as Record<string, unknown>
}
