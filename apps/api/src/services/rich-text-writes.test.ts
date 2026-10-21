import { describe, expect, it } from 'vitest'
import { markdownToRichText } from './rich-text.js'
import { applyRichTextWrites } from './rich-text-writes.js'

const lexical = (text: string) => markdownToRichText(text, 'lexical') as Record<string, unknown>
const withTable = {
	root: {
		type: 'root',
		children: [
			{ type: 'paragraph', children: [{ type: 'text', text: 'Intro', format: 0 }] },
			{ type: 'table', children: [] },
		],
	},
}

describe('applyRichTextWrites', () => {
	it('converts markdown written to a rich-text field into its format', () => {
		const fields = [
			{
				name: 'blurb',
				type: 'object' as const,
				ui: { preset: 'rich-text', richTextFormat: 'editorjs' as const },
			},
		]
		const { metadata, issues } = applyRichTextWrites(fields, { metadata: { blurb: '**Hi**' } })
		expect(issues).toEqual([])
		expect(
			(metadata?.blurb as { blocks: Array<{ data: { text: string } }> }).blocks[0].data.text,
		).toBe('<b>Hi</b>')
	})

	it('converts an edited body, keeping the stored document as the template', () => {
		const current = { metadata: { content: lexical('Old text') }, markdown: 'Old text' }
		const { metadata, issues } = applyRichTextWrites(
			[{ name: 'content', type: 'object' }],
			{ metadata: { content: current.metadata.content }, markdown: 'New *text*' },
			{ current },
		)
		expect(issues).toEqual([])
		expect(JSON.stringify(metadata?.content)).toContain('"text":"text","format":2')
	})

	it('leaves an unchanged body alone', () => {
		const current = { metadata: { content: lexical('Same') }, markdown: 'Same' }
		const input = { metadata: { content: current.metadata.content }, markdown: 'Same' }
		expect(
			applyRichTextWrites([{ name: 'content', type: 'object' }], input, { current }).metadata,
		).toBe(input.metadata)
	})

	it('refuses to overwrite a body that uses blocks markdown cannot hold', () => {
		const current = { metadata: { content: withTable }, markdown: 'Intro' }
		const { issues } = applyRichTextWrites(
			[{ name: 'content', type: 'object' }],
			{ metadata: { content: withTable }, markdown: 'Intro, edited' },
			{ current },
		)
		expect(issues).toEqual([
			{
				field: 'content',
				message:
					'content uses table, which cannot be converted from markdown without losing it. Edit it where it was created.',
			},
		])
	})

	it('accepts the unchanged preview of such a body', () => {
		const current = { metadata: { content: withTable }, markdown: 'Intro' }
		const { issues } = applyRichTextWrites(
			[{ name: 'content', type: 'object' }],
			{ metadata: { content: withTable }, markdown: 'Intro' },
			{ current },
		)
		expect(issues).toEqual([])
	})

	it('respects new editor state sent for the body', () => {
		const current = { metadata: { content: lexical('Old') }, markdown: 'Old' }
		const sent = lexical('Sent as state')
		const { metadata } = applyRichTextWrites(
			[{ name: 'content', type: 'object' }],
			{ metadata: { content: sent }, markdown: 'Old' },
			{ current },
		)
		expect(metadata?.content).toBe(sent)
	})

	it('explains when the format is unknown', () => {
		const { issues } = applyRichTextWrites(
			[{ name: 'blurb', type: 'object' as const, ui: { preset: 'rich-text' } }],
			{ metadata: { blurb: 'text' } },
		)
		expect(issues[0].message).toContain('format is unknown')
	})
})
