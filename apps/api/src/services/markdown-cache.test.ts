import { describe, expect, it } from 'vitest'
import { documentToMarkdown } from './markdown-cache.js'

const LONG_UA = `Перший освітній навігатор у маркетингу. ${'а'.repeat(150)}`
const LONG_EN = `The first educational navigator in marketing. ${'a'.repeat(200)}`

describe('documentToMarkdown', () => {
	it('treats a plain long string as the body and keeps it out of metadata', () => {
		const { markdown, metadata } = documentToMarkdown(
			{ _id: '1', title: 'T', content: LONG_UA },
			[],
		)
		expect('content' in metadata).toBe(false)
		expect(markdown).toContain(LONG_UA)
	})

	it('recognises a locale-mapped body and keeps the full map in metadata', () => {
		// Regression: a `content: { en, ua }` document used to fall through to
		// metadata as an anonymous object, and the editor — which hides `content` —
		// never rendered it, so the article body simply vanished.
		const { markdown, metadata } = documentToMarkdown(
			{ _id: '1', title: 'T', content: { ua: LONG_UA, en: LONG_EN } },
			[],
		)
		expect(metadata.content).toEqual({ ua: LONG_UA, en: LONG_EN })
		// `markdown` carries a flattened copy (the longest translation) so list
		// previews and search keep working.
		expect(markdown).toContain(LONG_EN)
	})

	it('does not embed YAML frontmatter — metadata is the single source of truth', () => {
		const { markdown, metadata } = documentToMarkdown(
			{ _id: '1', title: 'T', content: { ua: LONG_UA, en: LONG_EN } },
			[],
		)
		expect(markdown.startsWith('---')).toBe(false)
		expect(markdown).not.toContain('title: T')
		expect(metadata.title).toBe('T')
	})

	it('does not mistake a structured object for a locale map', () => {
		const meta = { platform: 'linkedin', url: 'https://example.com' }
		const { metadata } = documentToMarkdown({ _id: '1', content: LONG_UA, social: meta }, [])
		expect(metadata.social).toEqual(meta)
	})
})
