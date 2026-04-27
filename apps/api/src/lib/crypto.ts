import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

const ALGORITHM = 'aes-256-gcm'
const IV_LENGTH = 12
const AUTH_TAG_LENGTH = 16

function getKey(): Buffer {
	const key = process.env.SSO_ENCRYPTION_KEY
	if (!key) {
		throw new Error('SSO_ENCRYPTION_KEY is not set')
	}
	const buf = Buffer.from(key, 'base64')
	if (buf.length !== 32) {
		throw new Error('SSO_ENCRYPTION_KEY must be 32 bytes base64-encoded (256 bits)')
	}
	return buf
}

/** AES-256-GCM encrypt. Output: base64(iv || authTag || ciphertext). */
export function encryptSecret(plaintext: string): string {
	const key = getKey()
	const iv = randomBytes(IV_LENGTH)
	const cipher = createCipheriv(ALGORITHM, key, iv)
	const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
	const authTag = cipher.getAuthTag()
	return Buffer.concat([iv, authTag, ciphertext]).toString('base64')
}

export function decryptSecret(encoded: string): string {
	const key = getKey()
	const buf = Buffer.from(encoded, 'base64')
	if (buf.length < IV_LENGTH + AUTH_TAG_LENGTH) {
		throw new Error('Invalid encrypted payload')
	}
	const iv = buf.subarray(0, IV_LENGTH)
	const authTag = buf.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH)
	const ciphertext = buf.subarray(IV_LENGTH + AUTH_TAG_LENGTH)
	const decipher = createDecipheriv(ALGORITHM, key, iv)
	decipher.setAuthTag(authTag)
	const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()])
	return plaintext.toString('utf8')
}
