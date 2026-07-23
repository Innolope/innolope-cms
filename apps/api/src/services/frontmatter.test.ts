import { describe, expect, it } from 'vitest'
import { normalizeIncomingMarkdown, parseFrontmatter } from './frontmatter.js'

const FRONTMATTERED = `---
title: My Post
tags: ["a", "b"]
featured: true
rating: 4
---

# My Post

Body text.`

describe('parseFrontmatter', () => {
	it('splits frontmatter fields from the body with type coercion', () => {
		const { body, meta } = parseFrontmatter(FRONTMATTERED)
		expect(meta).toEqual({ title: 'My Post', tags: ['a', 'b'], featured: true, rating: 4 })
		expect(body.trim().startsWith('# My Post')).toBe(true)
		expect(body).not.toContain('---')
	})

	it('returns plain markdown untouched', () => {
		const md = '# No frontmatter here\n\nJust text.'
		expect(parseFrontmatter(md)).toEqual({ body: md, meta: {} })
	})

	it('does not treat a mid-document horizontal rule as frontmatter', () => {
		const md = '# Title\n\n---\n\nSection two.'
		expect(parseFrontmatter(md).meta).toEqual({})
	})
})

describe('normalizeIncomingMarkdown', () => {
	it('folds frontmatter into metadata and strips it from the body', () => {
		const { markdown, metadata } = normalizeIncomingMarkdown(FRONTMATTERED, undefined)
		expect(markdown).not.toContain('title: My Post')
		expect(metadata.title).toBe('My Post')
		expect(metadata.featured).toBe(true)
	})

	it('explicit metadata wins over frontmatter values', () => {
		const { metadata } = normalizeIncomingMarkdown(FRONTMATTERED, { title: 'Explicit Title' })
		expect(metadata.title).toBe('Explicit Title')
		expect(metadata.rating).toBe(4)
	})

	it('coalesces omitted markdown to an empty body', () => {
		const { markdown, metadata } = normalizeIncomingMarkdown(undefined, { title: 'Data Only' })
		expect(markdown).toBe('')
		expect(metadata).toEqual({ title: 'Data Only' })
	})

	it('passes frontmatter-free markdown through unchanged', () => {
		const md = '# Plain\n\nBody.'
		expect(normalizeIncomingMarkdown(md, { a: 1 })).toEqual({ markdown: md, metadata: { a: 1 } })
	})
})
