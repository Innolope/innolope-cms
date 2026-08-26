import { describe, expect, it } from 'vitest'
import { htmlFromMarkdown, markdownFromHtml } from './markdown-round-trip.js'

/** What the editor does to a record when someone opens it and saves. */
const roundTrip = (md: string) => markdownFromHtml(htmlFromMarkdown(md))

describe('markdown round trip', () => {
	// The regression this file exists for: a hand-rolled parser with no list rule
	// dropped every list into a paragraph, and turndown wrote it back as
	// `\- item` joined by hard breaks. Opening a record was enough to corrupt it.
	it('keeps a bullet list a list, with no escaped markers', () => {
		const out = roundTrip('- Цільовий доступ до студентів\n- Можливість виростити фахівців\n')
		expect(out).not.toContain('\\-')
		expect(out).not.toMatch(/ {2}\n/) // hard break, i.e. list flattened to a paragraph
		expect(out.split('\n').filter((l) => l.startsWith('-'))).toHaveLength(2)
	})

	it('keeps an ordered list a list', () => {
		const out = roundTrip('1. Перший крок\n2. Другий крок\n')
		expect(out).not.toContain('\\.')
		expect(out).toMatch(/^1\.\s+Перший крок$/m)
		expect(out).toMatch(/^2\.\s+Другий крок$/m)
	})

	it('keeps blockquotes, headings and fenced code intact', () => {
		const out = roundTrip('## Переваги\n\n> Цитата\n\n```js\nconst a = 1\n```\n')
		expect(out).toContain('## Переваги')
		expect(out).toMatch(/^> Цитата$/m)
		expect(out).toContain('```js\nconst a = 1\n```')
	})

	it('is idempotent — re-opening and re-saving never drifts again', () => {
		const source = [
			'## Заголовок',
			'',
			'Абзац з **жирним** і *курсивом* та [посиланням](https://example.com).',
			'',
			'- перший',
			'- другий',
			'',
			'1. крок',
			'2. крок',
			'',
			'> цитата',
		].join('\n')
		const once = roundTrip(source)
		expect(roundTrip(once)).toBe(once)
	})

	it('leaves a GFM table as text rather than dropping it', () => {
		// TipTap has no table node: a parsed <table> would vanish on load. Preserved
		// as text the content still round-trips, ugly but recoverable.
		const out = roundTrip('| a | b |\n| --- | --- |\n| 1 | 2 |\n')
		expect(out).toContain('a')
		expect(out).toContain('b')
		expect(out).not.toContain('<table')
	})
})
