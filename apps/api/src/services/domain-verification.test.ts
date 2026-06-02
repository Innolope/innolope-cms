import { describe, expect, it } from 'vitest'
import {
	generateVerificationToken,
	normalizeDomain,
	VERIFICATION_RECORD_PREFIX,
	VERIFICATION_VALUE_PREFIX,
	verificationRecord,
} from './domain-verification.js'

describe('normalizeDomain', () => {
	it('lowercases and strips protocol, path, port, and trailing dot', () => {
		expect(normalizeDomain('Example.COM')).toBe('example.com')
		expect(normalizeDomain('https://www.example.com/path?q=1')).toBe('www.example.com')
		expect(normalizeDomain('example.com:8080')).toBe('example.com')
		expect(normalizeDomain('example.com.')).toBe('example.com')
		expect(normalizeDomain('sub.example.co.uk')).toBe('sub.example.co.uk')
	})

	it('rejects wildcards, spaces, single labels, and IPs', () => {
		expect(normalizeDomain('*.example.com')).toBeNull()
		expect(normalizeDomain('has space.com')).toBeNull()
		expect(normalizeDomain('localhost')).toBeNull()
		expect(normalizeDomain('example')).toBeNull()
		expect(normalizeDomain('192.168.1.1')).toBeNull()
		expect(normalizeDomain('')).toBeNull()
	})
})

describe('verificationRecord', () => {
	it('builds the expected TXT record name and value', () => {
		const rec = verificationRecord('example.com', 'tok123')
		expect(rec.name).toBe(`${VERIFICATION_RECORD_PREFIX}.example.com`)
		expect(rec.value).toBe(`${VERIFICATION_VALUE_PREFIX}tok123`)
	})
})

describe('generateVerificationToken', () => {
	it('returns 48 hex chars and is non-deterministic', () => {
		const a = generateVerificationToken()
		expect(a).toMatch(/^[0-9a-f]{48}$/)
		expect(a).not.toBe(generateVerificationToken())
	})
})
