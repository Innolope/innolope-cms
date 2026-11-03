import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * `cheerio`'s full entry imports undici 7, whose module load installs an undici 7
 * Agent as the process-wide fetch dispatcher. Node's built-in fetch (undici 8)
 * then hands back every response with no headers — in the API that silently
 * breaks webhooks, IndexNow and cover rendering, not just the preview. The
 * capture code must use `cheerio/slim`. Checked in a fresh process because a
 * vitest worker may already have a dispatcher from an earlier test.
 */
describe('preview capture module loading', () => {
	it('leaves the global fetch dispatcher alone', () => {
		const modules = [
			'../services/preview-template.ts',
			'../routes/v1/collection-preview-templates.ts',
		]
		const urls = modules.map((m) => new URL(m, import.meta.url).href)
		const script = `
			for (const url of ${JSON.stringify(urls)}) await import(url)
			const installed = [1, 2].filter((v) => globalThis[Symbol.for('undici.globalDispatcher.' + v)] !== undefined)
			console.log(JSON.stringify(installed))
		`
		const out = execFileSync(
			process.execPath,
			['--import', 'tsx', '--input-type=module', '-e', script],
			{
				cwd: fileURLToPath(new URL('../..', import.meta.url)),
				encoding: 'utf8',
				env: { ...process.env, DATABASE_URL: process.env.DATABASE_URL ?? 'postgresql://unused' },
			},
		)
		expect(JSON.parse(out.trim().split('\n').pop() ?? 'null')).toEqual([])
	}, 30_000)
})
