import { describe, expect, it } from 'vitest'
import {
	extractHosts,
	isPrivateAddress,
	validateConnectionString,
	validatePublicUrl,
} from './connection-guard.js'

describe('connection guard', () => {
	it('screens every host of a multi-host authority', () => {
		expect(extractHosts('postgres://u:p@2130706433,example.com:5432/db')).toEqual([
			'2130706433',
			'example.com',
		])
		expect(extractHosts('mongodb://u:p@[::1]:27017,h2:27018/db')).toEqual(['::1', 'h2'])
		expect(extractHosts('not a url')).toBeNull()
	})

	it('recognises IPv4-mapped IPv6 in hex and dotted form, NAT64 and ULA', () => {
		expect(isPrivateAddress('::ffff:a9fe:a9fe')).toBe(true)
		expect(isPrivateAddress('::ffff:7f00:1')).toBe(true)
		expect(isPrivateAddress('::ffff:127.0.0.1')).toBe(true)
		expect(isPrivateAddress('64:ff9b::7f00:1')).toBe(true)
		expect(isPrivateAddress('fd12::1')).toBe(true)
		expect(isPrivateAddress('fe80::1')).toBe(true)
		expect(isPrivateAddress('::1')).toBe(true)
		expect(isPrivateAddress('2606:4700::1111')).toBe(false)
		expect(isPrivateAddress('::ffff:8.8.8.8')).toBe(false)
		expect(isPrivateAddress('100.64.0.1')).toBe(true)
		expect(isPrivateAddress('8.8.8.8')).toBe(false)
	})

	it('blocks the review payloads and fails closed on DNS', async () => {
		expect(await validateConnectionString('mongodb://u:p@[::ffff:a9fe:a9fe]:80/db')).toMatch(
			/private/,
		)
		expect(await validateConnectionString('postgres://u:p@2130706433,example.com:5432/db')).toMatch(
			/private|resolved/,
		)
		expect(await validateConnectionString('postgres://u:p@127.0.0.1:5432/db')).toMatch(/private/)
		expect(await validateConnectionString('postgres://u:p@localhost/db')).toMatch(/localhost/)
		expect(
			await validateConnectionString('postgres://u:p@this-host-does-not-exist.invalid/db'),
		).toMatch(/could not be resolved/)
	})

	it('no longer trips on credentials or paths that merely contain a pattern', async () => {
		// Password "Xy10.qP" and a path segment "10." used to be blocked as private.
		const problem = await validateConnectionString('postgres://app:Xy10.qP@example.com:5432/app10.')
		expect(problem === null || /resolved/.test(problem)).toBe(true)
		expect(await validateConnectionString('{"type":"service_account"}')).toBeNull()
	})

	it('validatePublicUrl enforces scheme and screens the host', async () => {
		expect(await validatePublicUrl('file:///etc/passwd')).toMatch(/http/)
		expect(await validatePublicUrl('http://169.254.169.254/latest')).toMatch(/private/)
		expect(await validatePublicUrl('http://[::ffff:7f00:1]/x')).toMatch(/private/)
		expect(await validatePublicUrl('https://notlocalhost.example.com/img/10.png')).not.toMatch(
			/matched/,
		)
	})
})
