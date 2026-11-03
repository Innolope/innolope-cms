import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildTestApp, hasTestDb } from '../test/harness.js'

/**
 * Locally stored uploads are user content served from the API origin, so every
 * response must carry the sandboxing headers. The `setHeaders` callback that sets
 * them changed shape in @fastify/static 10 (it receives the Fastify reply), and a
 * mismatch only shows up when a file is actually served.
 */
describe.skipIf(!hasTestDb)('local uploads static serving (real Postgres)', () => {
	let app: FastifyInstance
	let dir: string
	const previousDir = process.env.UPLOAD_DIR

	beforeAll(async () => {
		dir = mkdtempSync(join(tmpdir(), 'innolope-uploads-'))
		writeFileSync(join(dir, 'note.txt'), 'hello')
		process.env.UPLOAD_DIR = dir
		app = await buildTestApp()
	})

	afterAll(async () => {
		await app?.close()
		if (previousDir === undefined) delete process.env.UPLOAD_DIR
		else process.env.UPLOAD_DIR = previousDir
		rmSync(dir, { recursive: true, force: true })
	})

	it('serves an uploaded file with the sandboxing headers', async () => {
		const res = await app.inject({ method: 'GET', url: '/uploads/note.txt' })
		expect(res.statusCode, res.body).toBe(200)
		expect(res.body).toBe('hello')
		expect(res.headers['content-security-policy']).toBe("sandbox; default-src 'none'")
		expect(res.headers['x-content-type-options']).toBe('nosniff')
	})
})
