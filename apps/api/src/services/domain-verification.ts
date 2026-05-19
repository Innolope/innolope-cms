import { randomBytes } from 'node:crypto'

/** DNS TXT record name prefix where the verification token is expected. */
export const VERIFICATION_RECORD_PREFIX = '_innolope-verify'

/** Prefix of the TXT record value. */
export const VERIFICATION_VALUE_PREFIX = 'innolope-domain-verification='

/** Generate a fresh random verification token. */
export function generateVerificationToken(): string {
	return randomBytes(24).toString('hex')
}

/**
 * Normalize and validate a user-supplied custom domain.
 * Strips protocol/path/port, lowercases, and rejects wildcards and malformed hosts.
 * Returns the clean hostname, or null if the input is not a usable domain.
 */
export function normalizeDomain(input: string): string | null {
	if (!input) return null
	let host = input.trim().toLowerCase()
	// Strip protocol and any path/query.
	host = host.replace(/^[a-z]+:\/\//, '')
	host = host.split('/')[0]
	// Strip port and trailing dot.
	host = host.split(':')[0].replace(/\.$/, '')
	if (!host) return null
	if (host.includes('*')) return null
	if (host.includes(' ')) return null
	// Must be a dotted hostname: at least two labels, valid label chars, TLD of letters.
	const hostnameRe = /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/
	if (!hostnameRe.test(host)) return null
	return host
}

/** The TXT record the user must add to prove ownership of `domain`. */
export function verificationRecord(domain: string, token: string): { name: string; value: string } {
	return {
		name: `${VERIFICATION_RECORD_PREFIX}.${domain}`,
		value: `${VERIFICATION_VALUE_PREFIX}${token}`,
	}
}

interface DohAnswer {
	name: string
	type: number
	data: string
}

/**
 * Check whether the verification TXT record for `domain` contains `token`.
 * Uses Cloudflare DNS-over-HTTPS to bypass any local resolver caching.
 */
export async function verifyTxtRecord(domain: string, token: string): Promise<boolean> {
	const record = verificationRecord(domain, token)
	const url = `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(record.name)}&type=TXT`
	let res: Response
	try {
		res = await fetch(url, {
			headers: { accept: 'application/dns-json' },
			signal: AbortSignal.timeout(8000),
		})
	} catch {
		return false
	}
	if (!res.ok) return false
	const body = (await res.json().catch(() => null)) as { Answer?: DohAnswer[] } | null
	if (!body?.Answer) return false
	// TXT type is 16. Record data is returned as a quoted string, possibly chunked.
	return body.Answer.filter((a) => a.type === 16).some((a) => {
		const txt = a.data.replace(/^"|"$/g, '').replace(/"\s*"/g, '')
		return txt.includes(record.value)
	})
}
