import { describe, expect, it } from 'vitest'
import { documentToMarkdown, resolveCachedStatus } from './markdown-cache.js'

describe('resolveCachedStatus', () => {
	it('takes the source status when it says something we understand', () => {
		expect(resolveCachedStatus('draft', 'published')).toBe('draft')
		expect(resolveCachedStatus('archived')).toBe('archived')
	})

	it('keeps the local status when the source table has no status column', () => {
		// Regression: this used to coerce to `published`, so re-syncing a collection
		// whose source has no status column resurrected every draft and every
		// scheduled row — and then wrote `published` back to the source on next edit.
		expect(resolveCachedStatus(undefined, 'draft')).toBe('draft')
		expect(resolveCachedStatus(null, 'scheduled')).toBe('scheduled')
	})

	it('keeps the local status for a value that is not a status we model', () => {
		expect(resolveCachedStatus('active', 'draft')).toBe('draft')
	})

	it('defaults to published only for a row the CMS has never seen', () => {
		// A legacy article being imported for the first time is already live.
		expect(resolveCachedStatus(undefined)).toBe('published')
		expect(resolveCachedStatus(undefined, null)).toBe('published')
	})
})

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

	// Regression: `findBodyField` required a body longer than 100 characters, so a
	// short article fell through to metadata — where the editor hides
	// `content`/`body` — and the record rendered with no body at all.
	it('treats a short body as the body', () => {
		const { markdown, metadata } = documentToMarkdown(
			{ _id: '1', title: 'T', content: 'Short.' },
			[],
		)
		expect(markdown).toBe('Short.')
		expect('content' in metadata).toBe(false)
	})

	it('treats a short localized body as the body', () => {
		const { markdown, metadata } = documentToMarkdown(
			{ _id: '1', title: 'T', content: { en: 'Short.', uk: 'Коротко.' } },
			[],
		)
		expect(metadata.content).toEqual({ en: 'Short.', uk: 'Коротко.' })
		expect(markdown).toBe('Коротко.')
	})

	it('trusts the schema when the sampled document has an empty body', () => {
		// An empty source body used to be cached as `metadata.content = ""`, which
		// outranks `markdown` in buildExternalData — so the next edit was written to
		// the CMS and silently dropped from the source document.
		const { markdown, metadata } = documentToMarkdown({ _id: '1', title: 'T', content: '' }, [
			{ name: 'title', type: 'text' },
			{ name: 'content', type: 'text' },
		])
		expect(markdown).toBe('')
		expect('content' in metadata).toBe(false)
	})

	it('trusts the schema when the document omits the body entirely', () => {
		const { markdown, metadata } = documentToMarkdown({ _id: '1', title: 'T' }, [
			{ name: 'title', type: 'text' },
			{ name: 'content', type: 'text' },
		])
		expect(markdown).toBe('')
		expect(metadata).toEqual({ title: 'T' })
	})

	it('keeps a short description as a structured field', () => {
		// `description` is not a name buildExternalData can write back to, so it
		// keeps the length floor: a one-line description is a field, not a body.
		const { markdown, metadata } = documentToMarkdown({ _id: '1', description: 'A tag.' }, [])
		expect(metadata.description).toBe('A tag.')
		expect(markdown).toBe('')
	})

	it('still treats a long description as the body when nothing better exists', () => {
		const { markdown, metadata } = documentToMarkdown({ _id: '1', description: LONG_EN }, [])
		expect(markdown).toBe(LONG_EN)
		expect('description' in metadata).toBe(false)
	})
})
