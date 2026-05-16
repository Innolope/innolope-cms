import { beforeAll, describe, expect, it } from 'vitest'
import {
	createJwt,
	hashApiKey,
	hashToken,
	roleSatisfies,
	validatePasswordComplexity,
	verifyJwt,
} from './auth.js'

beforeAll(() => {
	process.env.AUTH_SECRET = 'test-secret-at-least-32-characters-long'
})

describe('roleSatisfies (role hierarchy)', () => {
	it('grants access when the user role meets the requirement', () => {
		expect(roleSatisfies('admin', ['admin'])).toBe(true)
		expect(roleSatisfies('admin', ['editor'])).toBe(true)
		expect(roleSatisfies('admin', ['viewer'])).toBe(true)
		expect(roleSatisfies('editor', ['editor'])).toBe(true)
		expect(roleSatisfies('editor', ['viewer'])).toBe(true)
		expect(roleSatisfies('viewer', ['viewer'])).toBe(true)
	})

	it('denies access when the user role is below the requirement', () => {
		expect(roleSatisfies('viewer', ['editor'])).toBe(false)
		expect(roleSatisfies('viewer', ['admin'])).toBe(false)
		expect(roleSatisfies('editor', ['admin'])).toBe(false)
	})

	it('denies an unknown role', () => {
		expect(roleSatisfies('nonsense', ['viewer'])).toBe(false)
	})
})

describe('validatePasswordComplexity', () => {
	it('accepts a strong password', () => {
		expect(validatePasswordComplexity('Str0ngPass')).toBeNull()
	})

	it('rejects weak passwords', () => {
		expect(validatePasswordComplexity('short1A')).toMatch(/8 characters/)
		expect(validatePasswordComplexity('lowercase1')).toMatch(/uppercase/)
		expect(validatePasswordComplexity('UPPERCASE1')).toMatch(/lowercase/)
		expect(validatePasswordComplexity('NoDigitsHere')).toMatch(/number/)
	})
})

describe('JWT round-trip', () => {
	const user = { id: 'u1', email: 'a@b.com', name: 'A', role: 'editor' as const }

	it('issues a token that verifies back to the same user', async () => {
		const token = await createJwt(user)
		const decoded = await verifyJwt(token)
		expect(decoded).not.toBeNull()
		expect(decoded?.id).toBe('u1')
		expect(decoded?.role).toBe('editor')
	})

	it('rejects a tampered token', async () => {
		const token = await createJwt(user)
		const tampered = `${token.slice(0, -3)}xyz`
		expect(await verifyJwt(tampered)).toBeNull()
	})

	it('rejects a malformed token', async () => {
		expect(await verifyJwt('not.a.jwt')).toBeNull()
	})
})

describe('hashing helpers', () => {
	it('hashApiKey is deterministic', () => {
		expect(hashApiKey('ink_abc')).toBe(hashApiKey('ink_abc'))
		expect(hashApiKey('ink_abc')).not.toBe(hashApiKey('ink_def'))
	})

	it('hashToken is deterministic', () => {
		expect(hashToken('tok')).toBe(hashToken('tok'))
	})
})
