import type { RichTextFormat } from '@innolope/config'
import { describe, expect, it } from 'vitest'
import {
	blocksToMarkdown,
	markdownToBlocks,
	markdownToRichText,
	richTextToMarkdown,
} from './rich-text.js'

const MARKDOWN = [
	'# Title',
	'Some **bold**, *italic*, `code`, ~~gone~~ and a [link](https://example.com).',
	'- one\n- two',
	'1. first\n2. second',
	'> A quote',
	'```js\nconst a = 1\n```',
	'![An image](https://example.com/a.png)',
].join('\n\n')

const FORMATS: RichTextFormat[] = ['lexical', 'editorjs', 'portable-text', 'slate']

describe('markdown ⇄ blocks', () => {
	it('is stable through a round trip', () => {
		const blocks = markdownToBlocks(MARKDOWN)
		expect(markdownToBlocks(blocksToMarkdown(blocks))).toEqual(blocks)
	})

	it('escapes text that would otherwise turn into markup', () => {
		const blocks = markdownToBlocks('2 \\* 3 \\_not italic\\_ and \\[brackets\\]')
		expect(blocksToMarkdown(blocks)).toBe('2 \\* 3 \\_not italic\\_ and \\[brackets\\]')
	})
})

describe.each(FORMATS)('%s', (format) => {
	it('converts markdown to editor state and back without loss', () => {
		const back = richTextToMarkdown(markdownToRichText(MARKDOWN, format))
		expect(back).toMatchObject({ format })
		let expected = blocksToMarkdown(markdownToBlocks(MARKDOWN))
		// Editor.js's standard code block has nowhere to keep a language.
		if (format === 'editorjs') expected = expected.replace('```js', '```')
		expect(back && 'markdown' in back ? back.markdown : null).toBe(expected)
	})

	it('is stable when converted twice', () => {
		const once = richTextToMarkdown(markdownToRichText(MARKDOWN, format))
		const twice =
			once && 'markdown' in once
				? richTextToMarkdown(markdownToRichText(once.markdown, format))
				: null
		expect(twice).toEqual(once)
	})
})

describe('unsupported content is reported, never flattened', () => {
	it('flags a Lexical table with a text preview', () => {
		const state = {
			root: {
				type: 'root',
				children: [
					{
						type: 'paragraph',
						children: [{ type: 'text', text: 'Before', format: 0 }],
					},
					{ type: 'table', children: [] },
				],
			},
		}
		const result = richTextToMarkdown(state)
		expect(result).toMatchObject({ format: 'lexical', unsupported: 'table' })
		expect(result && 'preview' in result ? result.preview : '').toContain('Before')
	})

	it('flags Lexical alignment and underline', () => {
		const aligned = {
			root: {
				type: 'root',
				children: [
					{
						type: 'paragraph',
						format: 'center',
						children: [{ type: 'text', text: 'x', format: 0 }],
					},
				],
			},
		}
		expect(richTextToMarkdown(aligned)).toMatchObject({ unsupported: 'alignment or indent' })
		const underlined = {
			root: {
				type: 'root',
				children: [{ type: 'paragraph', children: [{ type: 'text', text: 'x', format: 8 }] }],
			},
		}
		expect(richTextToMarkdown(underlined)).toMatchObject({ unsupported: 'underline or highlight' })
	})

	it('flags an Editor.js embed and unknown inline HTML', () => {
		expect(
			richTextToMarkdown({ blocks: [{ type: 'embed', data: { service: 'youtube' } }] }),
		).toMatchObject({ format: 'editorjs', unsupported: 'embed' })
		expect(
			richTextToMarkdown({ blocks: [{ type: 'paragraph', data: { text: 'a <mark>b</mark>' } }] }),
		).toMatchObject({ unsupported: '<mark>' })
	})

	it('flags a Portable Text asset image and a custom block', () => {
		expect(
			richTextToMarkdown([
				{ _type: 'image', asset: { _ref: 'image-abc' } },
				{ _type: 'block', children: [] },
			]),
		).toMatchObject({ format: 'portable-text', unsupported: 'image asset reference' })
	})

	it('flags nested lists in every format', () => {
		expect(
			richTextToMarkdown([
				{
					_type: 'block',
					listItem: 'bullet',
					level: 2,
					children: [{ _type: 'span', text: 'x', marks: [] }],
				},
			]),
		).toMatchObject({ unsupported: 'nested list' })
		expect(
			richTextToMarkdown({
				blocks: [
					{
						type: 'list',
						data: { style: 'unordered', items: [{ content: 'a', items: [{ content: 'b' }] }] },
					},
				],
			}),
		).toMatchObject({ unsupported: 'nested list' })
	})

	it('returns null for a value that is not editor state', () => {
		expect(richTextToMarkdown({ title: 'not rich text' })).toBeNull()
	})
})

describe('format details', () => {
	it('keeps the Editor.js wrapper and Lexical root props from the template', () => {
		const editorjs = markdownToRichText('Hi', 'editorjs', {
			version: '2.29.0',
			blocks: [],
		}) as Record<string, unknown>
		expect(editorjs.version).toBe('2.29.0')
		const lexical = markdownToRichText('Hi', 'lexical', {
			root: { type: 'root', direction: 'rtl', children: [] },
		}) as {
			root: { direction: string }
		}
		expect(lexical.root.direction).toBe('rtl')
	})

	it('keeps block ids and keys at the same position and type', () => {
		const editorjs = markdownToRichText('# H\n\nText', 'editorjs', {
			blocks: [
				{ id: 'keep-me', type: 'header', data: { text: 'Old', level: 1 } },
				{ id: 'not-a-paragraph', type: 'quote', data: { text: 'q' } },
			],
		}) as { blocks: Array<{ id: string }> }
		expect(editorjs.blocks[0].id).toBe('keep-me')
		expect(editorjs.blocks[1].id).not.toBe('not-a-paragraph')
		const portable = markdownToRichText('Text', 'portable-text', [
			{ _type: 'block', _key: 'k1', children: [] },
		]) as Array<{ _key: string }>
		expect(portable[0]._key).toBe('k1')
	})

	it('writes Plate element names when the template uses them', () => {
		const plate = markdownToRichText('# H\n\n- a', 'slate', [
			{ type: 'p', children: [{ text: '' }] },
		]) as Array<{
			type: string
		}>
		expect(plate.map((node) => node.type)).toEqual(['h1', 'ul'])
		const slate = markdownToRichText('# H', 'slate', [
			{ type: 'paragraph', children: [{ text: '' }] },
		]) as Array<{
			type: string
		}>
		expect(slate[0].type).toBe('heading-one')
	})

	it('reads Portable Text links from markDefs', () => {
		const result = richTextToMarkdown([
			{
				_type: 'block',
				style: 'normal',
				markDefs: [{ _key: 'l1', _type: 'link', href: 'https://x.example' }],
				children: [
					{ _type: 'span', text: 'Go ', marks: [] },
					{ _type: 'span', text: 'here', marks: ['l1', 'strong'] },
				],
			},
		])
		expect(result).toEqual({
			format: 'portable-text',
			markdown: 'Go [**here**](https://x.example)',
		})
	})
})
