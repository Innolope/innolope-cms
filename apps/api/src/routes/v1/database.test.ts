import { describe, expect, it } from 'vitest'
import {
	parseFirebaseCredentials,
	validateConnectionString,
	validatePublicUrl,
} from '../../adapters/connection-guard.js'

describe('validateConnectionString (SSRF blocklist)', () => {
	const blocked = [
		'postgresql://user:pw@localhost:5432/db',
		'postgresql://user:pw@127.0.0.1:5432/db',
		'postgresql://user:pw@10.0.0.5:5432/db',
		'postgresql://user:pw@192.168.1.10:5432/db',
		'postgresql://user:pw@169.254.169.254/db',
		'mongodb://metadata.google.internal/db',
		'postgresql://user:pw@db.internal:5432/db',
	]

	for (const conn of blocked) {
		it(`rejects ${conn}`, async () => {
			const result = await validateConnectionString(conn)
			expect(result).not.toBeNull()
			expect(result).toMatch(/not allowed/i)
		})
	}
})

describe('validatePublicUrl (webhook SSRF guard)', () => {
	const blocked = [
		'http://localhost/hook',
		'http://127.0.0.1:6379/',
		'http://169.254.169.254/latest/meta-data/',
		'https://metadata.google.internal/computeMetadata/v1/',
		'http://10.0.0.5/hook',
		'http://192.168.1.10/hook',
		'http://internal.local/hook',
	]
	for (const url of blocked) {
		it(`rejects ${url}`, async () => {
			const result = await validatePublicUrl(url)
			expect(result).not.toBeNull()
		})
	}

	it('rejects non-http(s) schemes', async () => {
		expect(await validatePublicUrl('file:///etc/passwd')).toMatch(/http/i)
		expect(await validatePublicUrl('gopher://127.0.0.1/')).not.toBeNull()
	})

	it('rejects malformed URLs', async () => {
		expect(await validatePublicUrl('not a url')).not.toBeNull()
	})

	it('allows a normal public https URL', async () => {
		expect(await validatePublicUrl('https://example.com/webhooks/incoming')).toBeNull()
	})
})

describe('parseFirebaseCredentials', () => {
	it('parses a valid service-account JSON object', () => {
		const creds = parseFirebaseCredentials('{"project_id":"demo","client_email":"x@y.z"}')
		expect(creds.project_id).toBe('demo')
	})

	it('throws a 400 error for malformed JSON', () => {
		try {
			parseFirebaseCredentials('{not valid json')
			expect.unreachable('should have thrown')
		} catch (err) {
			expect((err as { statusCode?: number }).statusCode).toBe(400)
		}
	})

	it('throws a 400 error when JSON is not an object', () => {
		for (const input of ['[]', '"a string"', '42', 'null']) {
			try {
				parseFirebaseCredentials(input)
				expect.unreachable(`should have thrown for ${input}`)
			} catch (err) {
				expect((err as { statusCode?: number }).statusCode).toBe(400)
			}
		}
	})
})
