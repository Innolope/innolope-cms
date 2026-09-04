import { lookup } from 'node:dns/promises'
import { isIP, isIPv6 } from 'node:net'

/** Hostnames that are always internal, whatever they resolve to. */
const BLOCKED_HOSTNAMES = new Set(['localhost', 'metadata.google.internal', 'metadata'])
/** Hostname suffixes that are always internal. */
const BLOCKED_SUFFIXES = ['.localhost', '.internal', '.local', '.home.arpa']

/**
 * Split a URL-ish authority into its hosts. Done by hand rather than through
 * `new URL()` because both postgres.js and the MongoDB driver accept a
 * comma-separated multi-host authority (`host1:5432,host2:5432`) that the
 * WHATWG parser either rejects or folds into one opaque "hostname" — and a
 * guard that only sees the folded string can be walked around with a comma.
 * Every host in the list is screened individually.
 */
export function extractHosts(connStr: string): string[] | null {
	const m = /^[a-z][a-z0-9+.-]*:\/\/([^/?#]*)/i.exec(connStr.trim())
	if (!m) return null
	let authority = m[1]
	const at = authority.lastIndexOf('@')
	if (at >= 0) authority = authority.slice(at + 1)
	if (!authority) return null
	const hosts: string[] = []
	for (const raw of authority.split(',')) {
		let host = raw.trim()
		if (!host) return null
		if (host.startsWith('[')) {
			const close = host.indexOf(']')
			if (close < 0) return null
			host = host.slice(1, close)
		} else {
			// Strip a trailing :port (an IPv6 literal without brackets is invalid here).
			const colon = host.lastIndexOf(':')
			if (colon >= 0 && host.indexOf(':') === colon) host = host.slice(0, colon)
		}
		hosts.push(host.toLowerCase())
	}
	return hosts
}

function screenHostname(host: string, subject: 'Connection' | 'Request'): string | null {
	if (!host) return `${subject} host is missing.`
	if (isIP(host)) return null
	// DNS names only: letters, digits, dots, dashes, underscores (SRV records).
	if (!/^[a-z0-9._-]+$/i.test(host)) return `${subject} host "${host}" is not a valid hostname.`
	if (BLOCKED_HOSTNAMES.has(host)) {
		return `${subject} to private/internal addresses is not allowed (matched: ${host}).`
	}
	for (const suffix of BLOCKED_SUFFIXES) {
		if (host.endsWith(suffix)) {
			return `${subject} to private/internal addresses is not allowed (matched: ${suffix}).`
		}
	}
	return null
}

/**
 * Block connection strings targeting private/internal networks (SSRF
 * protection). Firebase service-account JSON has no host and passes through.
 */
export async function validateConnectionString(connStr: string): Promise<string | null> {
	const trimmed = connStr.trim()
	if (trimmed.startsWith('{')) return null
	const hosts = extractHosts(trimmed)
	if (!hosts) return 'Invalid connection string: no host could be parsed.'
	for (const host of hosts) {
		const screened = screenHostname(host, 'Connection')
		if (screened) return screened
		const resolved = await resolveHostnameGuard(host, 'Connection')
		if (resolved) return resolved
	}
	return null
}

/**
 * Block outbound HTTP(S) requests to private/internal networks (SSRF protection)
 * for user-supplied URLs — webhooks, external content fetches, media probes.
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
	const hostname = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase()
	if (!hostname) return 'Invalid URL host.'
	const screened = screenHostname(hostname, 'Request')
	if (screened) return screened
	return resolveHostnameGuard(hostname, 'Request')
}

/**
 * Resolve a hostname and reject if any resolved address is private/internal.
 * A name that does not resolve is rejected too: the drivers would resolve it
 * themselves a moment later, possibly to something this guard never saw.
 */
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
			return `${subject} host "${hostname}" could not be resolved.`
		}
		if (addresses.length === 0) return `${subject} host "${hostname}" could not be resolved.`
	}

	for (const address of addresses) {
		if (isPrivateAddress(address)) {
			return `${subject} to private/internal addresses is not allowed (resolved: ${address}).`
		}
	}
	return null
}

/** Expand an IPv6 literal into eight 16-bit groups, or null if malformed. */
function ipv6Groups(address: string): number[] | null {
	let addr = address
	// Embedded dotted-quad tail (::ffff:1.2.3.4) → two hex groups.
	const v4 = /(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(addr)
	if (v4) {
		const o = v4.slice(1, 5).map(Number)
		if (o.some((n) => n > 255)) return null
		addr = `${addr.slice(0, v4.index)}${((o[0] << 8) | o[1]).toString(16)}:${((o[2] << 8) | o[3]).toString(16)}`
	}
	const halves = addr.split('::')
	if (halves.length > 2) return null
	const head = halves[0] ? halves[0].split(':') : []
	const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : []
	const fill = halves.length === 2 ? 8 - head.length - tail.length : 0
	if (fill < 0 || (halves.length === 1 && head.length !== 8)) return null
	const groups = [...head, ...Array(fill).fill('0'), ...tail].map((g) => Number.parseInt(g, 16))
	if (groups.length !== 8 || groups.some((g) => Number.isNaN(g) || g < 0 || g > 0xffff)) return null
	return groups
}

function isPrivateIpv4(parts: number[]): boolean {
	const [a, b] = parts
	return (
		a === 10 ||
		a === 127 ||
		a === 0 ||
		(a === 172 && b >= 16 && b <= 31) ||
		(a === 192 && b === 168) ||
		(a === 169 && b === 254) ||
		(a === 100 && b >= 64 && b <= 127) ||
		(a === 198 && (b === 18 || b === 19)) ||
		a >= 224
	)
}

export function isPrivateAddress(address: string): boolean {
	if (isIPv6(address) || address.includes(':')) {
		const g = ipv6Groups(address.replace(/^\[|\]$/g, '').replace(/%.*$/, ''))
		if (!g) return true
		// ::1 loopback, :: unspecified
		if (g.slice(0, 7).every((x) => x === 0) && (g[7] === 0 || g[7] === 1)) return true
		// IPv4-mapped ::ffff:a.b.c.d (in either dotted or hex spelling) and the
		// deprecated IPv4-compatible ::a.b.c.d → judge the embedded IPv4.
		if (g.slice(0, 5).every((x) => x === 0) && (g[5] === 0xffff || g[5] === 0)) {
			return isPrivateIpv4([g[6] >> 8, g[6] & 0xff, g[7] >> 8, g[7] & 0xff])
		}
		// NAT64 well-known prefix 64:ff9b::/96 embeds an IPv4 too.
		if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0)) {
			return isPrivateIpv4([g[6] >> 8, g[6] & 0xff, g[7] >> 8, g[7] & 0xff])
		}
		if ((g[0] & 0xfe00) === 0xfc00) return true // fc00::/7 unique local
		if ((g[0] & 0xffc0) === 0xfe80) return true // fe80::/10 link local
		if ((g[0] & 0xff00) === 0xff00) return true // multicast
		if (g[0] === 0x2001 && g[1] === 0x0db8) return true // documentation
		return false
	}

	const parts = address.split('.').map(Number)
	if (
		parts.length !== 4 ||
		parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)
	) {
		return true
	}
	return isPrivateIpv4(parts)
}

export interface SafeFetchOptions {
	/** How many redirects to follow, each re-screened. Default 5; 0 hands the 3xx back. */
	maxRedirects?: number
}

/**
 * `fetch` for user-influenced URLs: the initial URL AND every redirect target
 * are screened with `validatePublicUrl` before being requested, so an allowed
 * public host cannot bounce the request onto loopback or cloud metadata.
 * Throws an Error whose `message` names the blocked hop.
 */
export async function safeFetch(
	input: string | URL,
	init: RequestInit = {},
	options: SafeFetchOptions = {},
): Promise<Response> {
	const maxRedirects = options.maxRedirects ?? 5
	let current = String(input)
	let method = init.method ?? 'GET'
	let body = init.body
	for (let hop = 0; ; hop++) {
		const problem = await validatePublicUrl(current)
		if (problem) throw new Error(problem)
		const res = await fetch(current, { ...init, method, body, redirect: 'manual' })
		const location = res.headers.get('location')
		if (![301, 302, 303, 307, 308].includes(res.status) || !location) return res
		if (hop >= maxRedirects) return res
		await res.body?.cancel().catch(() => {})
		current = new URL(location, current).toString()
		if (res.status === 303 || ((res.status === 301 || res.status === 302) && method === 'POST')) {
			method = 'GET'
			body = undefined
		}
	}
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
