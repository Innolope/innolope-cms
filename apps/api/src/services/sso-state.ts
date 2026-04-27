import { SignJWT, jwtVerify } from 'jose'
import { randomBytes } from 'node:crypto'

function getSecret(): Uint8Array {
	const secret = process.env.AUTH_SECRET
	if (!secret || secret.length < 32) {
		throw new Error('AUTH_SECRET must be set and at least 32 characters')
	}
	return new TextEncoder().encode(secret)
}

export interface SsoStatePayload {
	slug: string
	connectionId: string
	nonce: string
	next?: string
	intent: 'login' | 'link' | 'test'
	linkUserId?: string
}

/** Sign a short-lived RelayState / OIDC state JWT. Expires in 10 minutes. */
export async function signState(payload: SsoStatePayload): Promise<string> {
	return new SignJWT({ ...payload })
		.setProtectedHeader({ alg: 'HS256' })
		.setIssuedAt()
		.setExpirationTime('10m')
		.sign(getSecret())
}

export async function verifyState(token: string): Promise<SsoStatePayload | null> {
	try {
		const { payload } = await jwtVerify(token, getSecret())
		return {
			slug: payload.slug as string,
			connectionId: payload.connectionId as string,
			nonce: payload.nonce as string,
			next: payload.next as string | undefined,
			intent: (payload.intent as 'login' | 'link' | 'test') ?? 'login',
			linkUserId: payload.linkUserId as string | undefined,
		}
	} catch {
		return null
	}
}

export function newNonce(): string {
	return randomBytes(16).toString('base64url')
}

/** Guard against open-redirect: must be same-origin path (starts with `/`, not `//`). */
export function sanitizeNext(next: string | null | undefined): string | undefined {
	if (!next) return undefined
	if (!next.startsWith('/')) return undefined
	if (next.startsWith('//')) return undefined
	if (next.includes('\\')) return undefined
	return next
}
