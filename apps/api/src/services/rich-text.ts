/**
 * Converters between rich-text editor state and the CMS's markdown.
 *
 * Bodies stored as editor state — Lexical, Editor.js, Portable Text, Slate — are
 * what the customer's site renders with its own component tree, while the CMS
 * edits markdown. A body like that used to reach the cache as the string
 * "[object Object]", and editing it would have written that string over the
 * source document.
 *
 * Every format maps onto one small block model (paragraphs, headings, flat
 * lists, quotes, code, images, rules; bold, italic, code, strike, links, line
 * breaks). A document is offered for markdown editing only when every block and
 * mark it uses fits that model, so converting it to markdown and back changes
 * nothing. Anything else — embeds, columns, tables, nested lists, alignment,
 * custom components — is reported as unsupported: the field stays read-only
 * with a preview, and a markdown write to it is refused instead of flattening
 * what the site relies on.
 *
 * The conversion runs on the API, so MCP and SDK writes get the same treatment
 * as the editor.
 */

import { randomBytes } from 'node:crypto'
import { detectRichTextFormat, type RichTextFormat } from '@innolope/config'
import { marked, type Token, type Tokens } from 'marked'

// ─── The block model ─────────────────────────────────────────────────────────

export interface TextLeaf {
	kind: 'text'
	text: string
	bold?: boolean
	italic?: boolean
	code?: boolean
	strike?: boolean
}
export type Inline =
	| TextLeaf
	| { kind: 'link'; href: string; children: Inline[] }
	| { kind: 'break' }

export type Block =
	| { kind: 'paragraph'; children: Inline[] }
	| { kind: 'heading'; level: number; children: Inline[] }
	| { kind: 'list'; ordered: boolean; items: Inline[][] }
	| { kind: 'quote'; children: Inline[] }
	| { kind: 'code'; lang?: string; text: string }
	| { kind: 'image'; src: string; alt: string }
	| { kind: 'rule' }

/** Raised by a reader when the document uses something the model cannot hold. */
class Unsupported extends Error {
	constructor(readonly what: string) {
		super(what)
	}
}

const unsupported = (what: string): never => {
	throw new Unsupported(what)
}

function isObject(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === 'object' && !Array.isArray(value)
}

function key(bytes = 6): string {
	return randomBytes(bytes).toString('hex')
}

/** Merge neighbouring text leaves with the same marks. */
function normalizeInline(children: Inline[]): Inline[] {
	const out: Inline[] = []
	for (const child of children) {
		const last = out[out.length - 1]
		if (child.kind === 'text') {
			if (child.text === '') continue
			if (
				last?.kind === 'text' &&
				!!last.bold === !!child.bold &&
				!!last.italic === !!child.italic &&
				!!last.code === !!child.code &&
				!!last.strike === !!child.strike
			) {
				out[out.length - 1] = { ...last, text: last.text + child.text }
				continue
			}
			out.push(child)
		} else if (child.kind === 'link') {
			out.push({ ...child, children: normalizeInline(child.children) })
		} else {
			out.push(child)
		}
	}
	return out
}

function plainText(children: Inline[]): string {
	return children
		.map((child) =>
			child.kind === 'text' ? child.text : child.kind === 'link' ? plainText(child.children) : '\n',
		)
		.join('')
}

// ─── Markdown ⇄ blocks ───────────────────────────────────────────────────────

function escapeMarkdown(text: string): string {
	return text.replace(/([\\`*_[\]<>~])/g, '\\$1').replace(/^(\s*)([#>+-]|\d+\.)(\s)/gm, '$1\\$2$3')
}

function inlineToMarkdown(children: Inline[]): string {
	return normalizeInline(children)
		.map((child) => {
			if (child.kind === 'break') return '  \n'
			if (child.kind === 'link') return `[${inlineToMarkdown(child.children)}](${child.href})`
			if (child.code) {
				const fence = child.text.includes('`') ? '``' : '`'
				return `${fence}${child.text}${fence}`
			}
			let text = escapeMarkdown(child.text)
			// Marks hug the text: leading/trailing spaces stay outside them.
			const lead = text.match(/^\s*/)?.[0] ?? ''
			const trail = text.match(/\s*$/)?.[0] ?? ''
			text = text.slice(lead.length, text.length - trail.length)
			if (!text) return lead + trail
			if (child.strike) text = `~~${text}~~`
			if (child.italic) text = `*${text}*`
			if (child.bold) text = `**${text}**`
			return lead + text + trail
		})
		.join('')
}

export function blocksToMarkdown(blocks: Block[]): string {
	return blocks
		.map((block) => {
			switch (block.kind) {
				case 'paragraph':
					return inlineToMarkdown(block.children)
				case 'heading':
					return `${'#'.repeat(block.level)} ${inlineToMarkdown(block.children)}`
				case 'list':
					return block.items
						.map(
							(item, index) => `${block.ordered ? `${index + 1}.` : '-'} ${inlineToMarkdown(item)}`,
						)
						.join('\n')
				case 'quote':
					return inlineToMarkdown(block.children)
						.split('\n')
						.map((line) => `> ${line}`)
						.join('\n')
				case 'code': {
					const fence = block.text.includes('```') ? '````' : '```'
					return `${fence}${block.lang ?? ''}\n${block.text}\n${fence}`
				}
				case 'image':
					return `![${block.alt.replace(/[[\]]/g, '\\$&')}](${block.src})`
				case 'rule':
					return '---'
			}
			return ''
		})
		.join('\n\n')
}

function tokensToInline(
	tokens: Token[] | undefined,
	marks: Omit<TextLeaf, 'kind' | 'text'> = {},
): Inline[] {
	const out: Inline[] = []
	for (const token of tokens ?? []) {
		switch (token.type) {
			case 'text': {
				const text = token as Tokens.Text
				if (text.tokens?.length) out.push(...tokensToInline(text.tokens, marks))
				else out.push({ kind: 'text', text: decodeEntities(text.text), ...marks })
				break
			}
			case 'escape':
				out.push({ kind: 'text', text: (token as Tokens.Escape).text, ...marks })
				break
			case 'strong':
				out.push(...tokensToInline((token as Tokens.Strong).tokens, { ...marks, bold: true }))
				break
			case 'em':
				out.push(...tokensToInline((token as Tokens.Em).tokens, { ...marks, italic: true }))
				break
			case 'del':
				out.push(...tokensToInline((token as Tokens.Del).tokens, { ...marks, strike: true }))
				break
			case 'codespan':
				out.push({
					kind: 'text',
					text: decodeEntities((token as Tokens.Codespan).text),
					...marks,
					code: true,
				})
				break
			case 'link': {
				const link = token as Tokens.Link
				out.push({ kind: 'link', href: link.href, children: tokensToInline(link.tokens, marks) })
				break
			}
			case 'br':
				out.push({ kind: 'break' })
				break
			default:
				out.push({ kind: 'text', text: token.raw, ...marks })
		}
	}
	return out
}

function decodeEntities(text: string): string {
	return text
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/&amp;/g, '&')
}

/** A paragraph's inline content, with stand-alone images lifted out as blocks. */
function paragraphBlocks(tokens: Token[]): Block[] {
	const blocks: Block[] = []
	let run: Token[] = []
	const flush = () => {
		const children = normalizeInline(tokensToInline(run))
		if (children.length > 0 && plainText(children).trim() !== '') {
			blocks.push({ kind: 'paragraph', children })
		}
		run = []
	}
	for (const token of tokens) {
		if (token.type === 'image') {
			flush()
			const image = token as Tokens.Image
			blocks.push({ kind: 'image', src: image.href, alt: image.text })
		} else {
			run.push(token)
		}
	}
	flush()
	return blocks
}

export function markdownToBlocks(markdown: string): Block[] {
	const blocks: Block[] = []
	for (const token of marked.lexer(markdown, { gfm: true })) {
		switch (token.type) {
			case 'heading': {
				const heading = token as Tokens.Heading
				blocks.push({
					kind: 'heading',
					level: heading.depth,
					children: normalizeInline(tokensToInline(heading.tokens)),
				})
				break
			}
			case 'paragraph':
				blocks.push(...paragraphBlocks((token as Tokens.Paragraph).tokens))
				break
			case 'list': {
				const list = token as Tokens.List
				const items: Inline[][] = []
				const visit = (entries: Tokens.ListItem[]) => {
					for (const entry of entries) {
						const nested = entry.tokens.filter((t) => t.type === 'list') as Tokens.List[]
						const own = entry.tokens.filter((t) => t.type !== 'list')
						items.push(
							normalizeInline(own.flatMap((t) => tokensToInline((t as Tokens.Text).tokens ?? [t]))),
						)
						// Nested lists are flattened: the block model has none.
						for (const child of nested) visit(child.items)
					}
				}
				visit(list.items)
				blocks.push({ kind: 'list', ordered: list.ordered, items })
				break
			}
			case 'blockquote': {
				const quote = token as Tokens.Blockquote
				const children: Inline[] = []
				quote.tokens.forEach((inner, index) => {
					if (index > 0) children.push({ kind: 'break' })
					children.push(...tokensToInline((inner as Tokens.Paragraph).tokens ?? [inner]))
				})
				blocks.push({ kind: 'quote', children: normalizeInline(children) })
				break
			}
			case 'code': {
				const code = token as Tokens.Code
				blocks.push({ kind: 'code', ...(code.lang && { lang: code.lang }), text: code.text })
				break
			}
			case 'hr':
				blocks.push({ kind: 'rule' })
				break
			case 'space':
				break
			default:
				// Tables, raw HTML and the like: kept as their source text.
				if (token.raw.trim()) {
					blocks.push({ kind: 'paragraph', children: [{ kind: 'text', text: token.raw.trim() }] })
				}
		}
	}
	return blocks
}

// ─── Lexical ─────────────────────────────────────────────────────────────────

const LEXICAL_BOLD = 1
const LEXICAL_ITALIC = 2
const LEXICAL_STRIKE = 4
const LEXICAL_CODE = 16
const LEXICAL_SUPPORTED_FORMAT = LEXICAL_BOLD | LEXICAL_ITALIC | LEXICAL_STRIKE | LEXICAL_CODE

function lexicalInline(nodes: unknown[]): Inline[] {
	return nodes.flatMap((node): Inline[] => {
		if (!isObject(node)) return []
		switch (node.type) {
			case 'text': {
				const format = Number(node.format ?? 0)
				if (format & ~LEXICAL_SUPPORTED_FORMAT) unsupported('underline or highlight')
				if (node.style) unsupported('text style')
				return [
					{
						kind: 'text',
						text: String(node.text ?? ''),
						...(format & LEXICAL_BOLD && { bold: true }),
						...(format & LEXICAL_ITALIC && { italic: true }),
						...(format & LEXICAL_STRIKE && { strike: true }),
						...(format & LEXICAL_CODE && { code: true }),
					},
				]
			}
			case 'linebreak':
				return [{ kind: 'break' }]
			case 'link':
			case 'autolink':
				return [
					{
						kind: 'link',
						href: String(node.url ?? ''),
						children: lexicalInline((node.children as unknown[]) ?? []),
					},
				]
			default:
				return unsupported(String(node.type))
		}
	})
}

function lexicalPlain(node: Record<string, unknown>) {
	if (
		(node.format && node.format !== 'left' && node.format !== 0) ||
		Number(node.indent ?? 0) > 0
	) {
		unsupported('alignment or indent')
	}
}

function lexicalToBlocks(value: Record<string, unknown>): Block[] {
	const root = value.root as Record<string, unknown>
	const blocks: Block[] = []
	for (const node of (root.children as unknown[]) ?? []) {
		if (!isObject(node)) continue
		switch (node.type) {
			case 'paragraph':
				lexicalPlain(node)
				blocks.push({ kind: 'paragraph', children: lexicalInline(node.children as unknown[]) })
				break
			case 'heading':
				lexicalPlain(node)
				blocks.push({
					kind: 'heading',
					level: Number(String(node.tag ?? 'h1').slice(1)) || 1,
					children: lexicalInline(node.children as unknown[]),
				})
				break
			case 'quote':
				blocks.push({ kind: 'quote', children: lexicalInline(node.children as unknown[]) })
				break
			case 'list': {
				if (node.listType === 'check') unsupported('checklist')
				const items = ((node.children as unknown[]) ?? []).filter(isObject).map((item) => {
					const children = (item.children as unknown[]) ?? []
					if (children.some((child) => isObject(child) && child.type === 'list')) {
						unsupported('nested list')
					}
					return lexicalInline(children)
				})
				blocks.push({ kind: 'list', ordered: node.listType === 'number', items })
				break
			}
			case 'code':
				blocks.push({
					kind: 'code',
					...(typeof node.language === 'string' && node.language && { lang: node.language }),
					text: ((node.children as unknown[]) ?? [])
						.filter(isObject)
						.map((child) => (child.type === 'linebreak' ? '\n' : String(child.text ?? '')))
						.join(''),
				})
				break
			case 'image':
				blocks.push({ kind: 'image', src: String(node.src ?? ''), alt: String(node.altText ?? '') })
				break
			case 'horizontalrule':
				blocks.push({ kind: 'rule' })
				break
			default:
				unsupported(String(node.type))
		}
	}
	return blocks
}

function lexicalElement(type: string, children: unknown[], extra: Record<string, unknown> = {}) {
	return { type, version: 1, format: '', indent: 0, direction: 'ltr', children, ...extra }
}

function lexicalText(children: Inline[]): unknown[] {
	return normalizeInline(children).map((child) => {
		if (child.kind === 'break') return { type: 'linebreak', version: 1 }
		if (child.kind === 'link') {
			return lexicalElement('link', lexicalText(child.children), {
				url: child.href,
				rel: null,
				target: null,
				title: null,
			})
		}
		const format =
			(child.bold ? LEXICAL_BOLD : 0) |
			(child.italic ? LEXICAL_ITALIC : 0) |
			(child.strike ? LEXICAL_STRIKE : 0) |
			(child.code ? LEXICAL_CODE : 0)
		return {
			type: 'text',
			version: 1,
			text: child.text,
			format,
			style: '',
			mode: 'normal',
			detail: 0,
		}
	})
}

function blocksToLexical(blocks: Block[], template: unknown): Record<string, unknown> {
	const children = blocks.map((block) => {
		switch (block.kind) {
			case 'paragraph':
				return lexicalElement('paragraph', lexicalText(block.children), { textFormat: 0 })
			case 'heading':
				return lexicalElement('heading', lexicalText(block.children), { tag: `h${block.level}` })
			case 'quote':
				return lexicalElement('quote', lexicalText(block.children))
			case 'list':
				return lexicalElement(
					'list',
					block.items.map((item, index) =>
						lexicalElement('listitem', lexicalText(item), { value: index + 1 }),
					),
					{
						listType: block.ordered ? 'number' : 'bullet',
						start: 1,
						tag: block.ordered ? 'ol' : 'ul',
					},
				)
			case 'code':
				return lexicalElement(
					'code',
					block.text.split('\n').flatMap((line, index) => [
						...(index > 0 ? [{ type: 'linebreak', version: 1 }] : []),
						...(line
							? [
									{
										type: 'text',
										version: 1,
										text: line,
										format: 0,
										style: '',
										mode: 'normal',
										detail: 0,
									},
								]
							: []),
					]),
					{ language: block.lang ?? null },
				)
			case 'image':
				return { type: 'image', version: 1, src: block.src, altText: block.alt }
			case 'rule':
				return { type: 'horizontalrule', version: 1 }
		}
		return null
	})
	const root = isObject(template) && isObject(template.root) ? template.root : {}
	return {
		...(isObject(template) ? template : {}),
		root: { ...root, ...lexicalElement('root', children), direction: root.direction ?? 'ltr' },
	}
}

// ─── Editor.js ───────────────────────────────────────────────────────────────

/** Editor.js keeps inline formatting as a small HTML subset. */
function htmlToInline(html: string): Inline[] {
	const out: Inline[] = []
	const marks: Array<'bold' | 'italic' | 'code' | 'strike'> = []
	let link: { href: string; children: Inline[] } | null = null
	const push = (node: Inline) => (link ? link.children : out).push(node)
	const re = /<\/?([a-zA-Z0-9]+)([^>]*)>|([^<]+)/g
	for (let match = re.exec(html); match; match = re.exec(html)) {
		const [whole, tag, attrs, text] = match
		if (text !== undefined) {
			push({
				kind: 'text',
				text: decodeEntities(text.replace(/&nbsp;/g, '\u00a0')),
				...(marks.includes('bold') && { bold: true }),
				...(marks.includes('italic') && { italic: true }),
				...(marks.includes('code') && { code: true }),
				...(marks.includes('strike') && { strike: true }),
			})
			continue
		}
		const closing = whole.startsWith('</')
		const name = tag.toLowerCase()
		const mark =
			name === 'b' || name === 'strong'
				? 'bold'
				: name === 'i' || name === 'em'
					? 'italic'
					: name === 'code'
						? 'code'
						: name === 's' || name === 'del' || name === 'strike'
							? 'strike'
							: null
		if (mark) {
			if (closing) marks.splice(marks.lastIndexOf(mark), 1)
			else marks.push(mark)
		} else if (name === 'br') {
			push({ kind: 'break' })
		} else if (name === 'a') {
			if (closing) {
				if (link) out.push({ kind: 'link', ...link })
				link = null
			} else {
				const href = /href\s*=\s*"([^"]*)"/i.exec(attrs)?.[1] ?? ''
				link = { href: decodeEntities(href), children: [] }
			}
		} else {
			unsupported(`<${name}>`)
		}
	}
	return normalizeInline(out)
}

function escapeHtml(text: string): string {
	return text
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
}

function inlineToHtml(children: Inline[]): string {
	return normalizeInline(children)
		.map((child) => {
			if (child.kind === 'break') return '<br>'
			if (child.kind === 'link') {
				return `<a href="${escapeHtml(child.href)}">${inlineToHtml(child.children)}</a>`
			}
			let html = escapeHtml(child.text)
			if (child.code) html = `<code class="inline-code">${html}</code>`
			if (child.strike) html = `<s>${html}</s>`
			if (child.italic) html = `<i>${html}</i>`
			if (child.bold) html = `<b>${html}</b>`
			return html
		})
		.join('')
}

function editorJsToBlocks(value: Record<string, unknown>): Block[] {
	const blocks: Block[] = []
	for (const block of (value.blocks as unknown[]) ?? []) {
		if (!isObject(block)) continue
		const data = isObject(block.data) ? block.data : {}
		switch (block.type) {
			case 'paragraph':
				blocks.push({ kind: 'paragraph', children: htmlToInline(String(data.text ?? '')) })
				break
			case 'header':
				blocks.push({
					kind: 'heading',
					level: Number(data.level) || 2,
					children: htmlToInline(String(data.text ?? '')),
				})
				break
			case 'list': {
				if (data.style !== 'ordered' && data.style !== 'unordered') unsupported('checklist')
				const items = ((data.items as unknown[]) ?? []).map((item) => {
					if (isObject(item)) {
						if (Array.isArray(item.items) && item.items.length > 0) unsupported('nested list')
						return htmlToInline(String(item.content ?? ''))
					}
					return htmlToInline(String(item ?? ''))
				})
				blocks.push({ kind: 'list', ordered: data.style === 'ordered', items })
				break
			}
			case 'quote':
				if (data.caption) unsupported('quote caption')
				blocks.push({ kind: 'quote', children: htmlToInline(String(data.text ?? '')) })
				break
			case 'code':
				blocks.push({ kind: 'code', text: String(data.code ?? '') })
				break
			case 'image':
			case 'simpleImage': {
				if (data.withBorder || data.stretched || data.withBackground) unsupported('image layout')
				const file = isObject(data.file) ? data.file : {}
				blocks.push({
					kind: 'image',
					src: String(file.url ?? data.url ?? ''),
					alt: String(data.caption ?? ''),
				})
				break
			}
			case 'delimiter':
				blocks.push({ kind: 'rule' })
				break
			default:
				unsupported(String(block.type))
		}
	}
	return blocks
}

/**
 * Identity a regenerated block keeps from the stored document: the block at the
 * same position, when it is of the same type. Sites and editors key on these
 * (Editor.js block ids, Portable Text `_key`s), so an edit should not churn them.
 */
function templateIds(
	entries: unknown,
	typeOf: (entry: Record<string, unknown>) => string,
	idOf: string,
) {
	const list = Array.isArray(entries) ? entries.filter(isObject) : []
	return (index: number, type: string, fallback: () => string): string => {
		const entry = list[index]
		const id = entry?.[idOf]
		return entry && typeOf(entry) === type && typeof id === 'string' ? id : fallback()
	}
}

const EDITORJS_TYPES: Record<Block['kind'], string> = {
	paragraph: 'paragraph',
	heading: 'header',
	list: 'list',
	quote: 'quote',
	code: 'code',
	image: 'image',
	rule: 'delimiter',
}

function blocksToEditorJs(blocks: Block[], template: unknown): Record<string, unknown> {
	const reuse = templateIds(
		isObject(template) ? template.blocks : undefined,
		(entry) => String(entry.type),
		'id',
	)
	const out = blocks.flatMap((block, index) => {
		const id = reuse(index, EDITORJS_TYPES[block.kind], () => key(5))
		switch (block.kind) {
			case 'paragraph':
				return [{ id, type: 'paragraph', data: { text: inlineToHtml(block.children) } }]
			case 'heading':
				return [
					{ id, type: 'header', data: { text: inlineToHtml(block.children), level: block.level } },
				]
			case 'list':
				return [
					{
						id,
						type: 'list',
						data: {
							style: block.ordered ? 'ordered' : 'unordered',
							items: block.items.map((item) => inlineToHtml(item)),
						},
					},
				]
			case 'quote':
				return [
					{
						id,
						type: 'quote',
						data: { text: inlineToHtml(block.children), caption: '', alignment: 'left' },
					},
				]
			case 'code':
				return [{ id, type: 'code', data: { code: block.text } }]
			case 'image':
				return [
					{
						id,
						type: 'image',
						data: {
							file: { url: block.src },
							caption: block.alt,
							withBorder: false,
							stretched: false,
							withBackground: false,
						},
					},
				]
			case 'rule':
				return [{ id, type: 'delimiter', data: {} }]
		}
		return []
	})
	return { ...(isObject(template) ? template : {}), time: Date.now(), blocks: out }
}

// ─── Portable Text ───────────────────────────────────────────────────────────

const PT_DECORATORS: Record<string, 'bold' | 'italic' | 'code' | 'strike'> = {
	strong: 'bold',
	em: 'italic',
	code: 'code',
	'strike-through': 'strike',
}

function portableTextToBlocks(value: unknown[]): Block[] {
	const blocks: Block[] = []
	for (const entry of value) {
		if (!isObject(entry)) continue
		if (entry._type === 'block') {
			const defs = new Map(
				((entry.markDefs as unknown[]) ?? [])
					.filter(isObject)
					.map((def) => [String(def._key), def]),
			)
			const children: Inline[] = []
			for (const span of (entry.children as unknown[]) ?? []) {
				if (!isObject(span)) continue
				if (span._type !== 'span') unsupported(String(span._type))
				const leaf: TextLeaf = { kind: 'text', text: String(span.text ?? '') }
				let href: string | null = null
				for (const mark of (span.marks as string[]) ?? []) {
					const decorator = PT_DECORATORS[mark]
					if (decorator) leaf[decorator] = true
					else {
						const def = defs.get(mark)
						if (def?._type === 'link' && typeof def.href === 'string') href = def.href
						else unsupported(`mark ${mark}`)
					}
				}
				const last = children[children.length - 1]
				if (href) {
					if (last?.kind === 'link' && last.href === href) last.children.push(leaf)
					else children.push({ kind: 'link', href, children: [leaf] })
				} else {
					children.push(leaf)
				}
			}
			const inline = normalizeInline(children)
			if (entry.listItem) {
				if (entry.listItem !== 'bullet' && entry.listItem !== 'number')
					unsupported(String(entry.listItem))
				if (Number(entry.level ?? 1) > 1) unsupported('nested list')
				const ordered = entry.listItem === 'number'
				const last = blocks[blocks.length - 1]
				if (last?.kind === 'list' && last.ordered === ordered) last.items.push(inline)
				else blocks.push({ kind: 'list', ordered, items: [inline] })
				continue
			}
			const style = String(entry.style ?? 'normal')
			if (style === 'normal') blocks.push({ kind: 'paragraph', children: inline })
			else if (/^h[1-6]$/.test(style)) {
				blocks.push({ kind: 'heading', level: Number(style.slice(1)), children: inline })
			} else if (style === 'blockquote') blocks.push({ kind: 'quote', children: inline })
			else unsupported(`style ${style}`)
			continue
		}
		if (entry._type === 'code') {
			blocks.push({
				kind: 'code',
				...(typeof entry.language === 'string' && { lang: entry.language }),
				text: String(entry.code ?? ''),
			})
			continue
		}
		if (entry._type === 'image') {
			// A Sanity image is an asset reference; only an expanded one carries a URL.
			const asset = isObject(entry.asset) ? entry.asset : {}
			const src = typeof entry.url === 'string' ? entry.url : asset.url
			if (typeof src !== 'string') unsupported('image asset reference')
			blocks.push({ kind: 'image', src: src as string, alt: String(entry.alt ?? '') })
			continue
		}
		unsupported(String(entry._type))
	}
	return blocks
}

function portableTextSpans(
	children: Inline[],
	markDefs: Array<Record<string, unknown>>,
): unknown[] {
	const spans: unknown[] = []
	const visit = (nodes: Inline[], linkKey?: string) => {
		for (const node of normalizeInline(nodes)) {
			if (node.kind === 'break') {
				spans.push({ _type: 'span', _key: key(), text: '\n', marks: linkKey ? [linkKey] : [] })
			} else if (node.kind === 'link') {
				const defKey = key()
				markDefs.push({ _type: 'link', _key: defKey, href: node.href })
				visit(node.children, defKey)
			} else {
				const marks = [
					...(node.bold ? ['strong'] : []),
					...(node.italic ? ['em'] : []),
					...(node.code ? ['code'] : []),
					...(node.strike ? ['strike-through'] : []),
					...(linkKey ? [linkKey] : []),
				]
				spans.push({ _type: 'span', _key: key(), text: node.text, marks })
			}
		}
	}
	visit(children)
	return spans.length > 0 ? spans : [{ _type: 'span', _key: key(), text: '', marks: [] }]
}

function blocksToPortableText(blocks: Block[], template?: unknown): unknown[] {
	const reuse = templateIds(template, (entry) => String(entry._type), '_key')
	let position = 0
	const nextKey = (type: string) => reuse(position++, type, () => key())
	const textBlock = (children: Inline[], extra: Record<string, unknown>) => {
		const markDefs: Array<Record<string, unknown>> = []
		const spans = portableTextSpans(children, markDefs)
		return {
			_type: 'block',
			_key: nextKey('block'),
			style: 'normal',
			markDefs,
			children: spans,
			...extra,
		}
	}
	return blocks.flatMap((block): unknown[] => {
		switch (block.kind) {
			case 'paragraph':
				return [textBlock(block.children, {})]
			case 'heading':
				return [textBlock(block.children, { style: `h${block.level}` })]
			case 'quote':
				return [textBlock(block.children, { style: 'blockquote' })]
			case 'list':
				return block.items.map((item) =>
					textBlock(item, { listItem: block.ordered ? 'number' : 'bullet', level: 1 }),
				)
			case 'code':
				return [
					{
						_type: 'code',
						_key: nextKey('code'),
						code: block.text,
						...(block.lang && { language: block.lang }),
					},
				]
			case 'image':
				return [{ _type: 'image', _key: nextKey('image'), url: block.src, alt: block.alt }]
			case 'rule':
				return unsupported('horizontal rule')
		}
		return []
	})
}

// ─── Slate (and Plate) ───────────────────────────────────────────────────────

const SLATE_HEADINGS: Record<string, number> = {
	'heading-one': 1,
	'heading-two': 2,
	'heading-three': 3,
	'heading-four': 4,
	'heading-five': 5,
	'heading-six': 6,
	h1: 1,
	h2: 2,
	h3: 3,
	h4: 4,
	h5: 5,
	h6: 6,
}
const SLATE_LEAF_MARKS = new Set(['text', 'bold', 'italic', 'code', 'strikethrough'])

function slateInline(nodes: unknown[]): Inline[] {
	return nodes.flatMap((node): Inline[] => {
		if (!isObject(node)) return []
		if (typeof node.text === 'string') {
			for (const mark of Object.keys(node)) {
				if (!SLATE_LEAF_MARKS.has(mark) && node[mark]) unsupported(`mark ${mark}`)
			}
			return [
				{
					kind: 'text',
					text: node.text,
					...(node.bold === true && { bold: true }),
					...(node.italic === true && { italic: true }),
					...(node.code === true && { code: true }),
					...(node.strikethrough === true && { strike: true }),
				},
			]
		}
		if (node.type === 'link' || node.type === 'a') {
			return [
				{
					kind: 'link',
					href: String(node.url ?? node.href ?? ''),
					children: slateInline((node.children as unknown[]) ?? []),
				},
			]
		}
		return unsupported(String(node.type))
	})
}

function slateText(node: Record<string, unknown>): string {
	const children = (node.children as unknown[]) ?? []
	return children
		.filter(isObject)
		.map((child) => (typeof child.text === 'string' ? child.text : slateText(child)))
		.join(isObject(children[0]) && children[0].type ? '\n' : '')
}

function slateToBlocks(value: unknown[]): Block[] {
	const blocks: Block[] = []
	for (const node of value) {
		if (!isObject(node)) continue
		const type = String(node.type)
		const children = (node.children as unknown[]) ?? []
		if (type === 'paragraph' || type === 'p') {
			blocks.push({ kind: 'paragraph', children: slateInline(children) })
		} else if (type in SLATE_HEADINGS || type === 'heading') {
			blocks.push({
				kind: 'heading',
				level: SLATE_HEADINGS[type] ?? (Number(node.level) || 1),
				children: slateInline(children),
			})
		} else if (['block-quote', 'blockquote', 'quote'].includes(type)) {
			blocks.push({ kind: 'quote', children: slateInline(children) })
		} else if (
			['bulleted-list', 'numbered-list', 'ul', 'ol', 'unordered-list', 'ordered-list'].includes(
				type,
			)
		) {
			const ordered = ['numbered-list', 'ol', 'ordered-list'].includes(type)
			const items = children.filter(isObject).map((item) => {
				const content = (item.children as unknown[]) ?? []
				if (
					content.some(
						(child) =>
							isObject(child) &&
							['ul', 'ol', 'bulleted-list', 'numbered-list'].includes(String(child.type)),
					)
				) {
					unsupported('nested list')
				}
				// Plate wraps a list item's text in a `lic` element.
				const inline = content.flatMap((child) =>
					isObject(child) && child.type === 'lic' ? ((child.children as unknown[]) ?? []) : [child],
				)
				return slateInline(inline)
			})
			blocks.push({ kind: 'list', ordered, items })
		} else if (['code', 'code-block', 'code_block'].includes(type)) {
			blocks.push({
				kind: 'code',
				...(typeof node.lang === 'string' && { lang: node.lang }),
				text: slateText(node),
			})
		} else if (type === 'image' || type === 'img') {
			blocks.push({
				kind: 'image',
				src: String(node.url ?? node.src ?? ''),
				alt: String(node.alt ?? ''),
			})
		} else if (type === 'thematic-break' || type === 'hr') {
			blocks.push({ kind: 'rule' })
		} else {
			unsupported(type)
		}
	}
	return blocks
}

/** Whether a Slate document uses Plate's short element names. */
function isPlateFlavor(template: unknown): boolean {
	return (
		Array.isArray(template) &&
		template.some(
			(node) =>
				isObject(node) &&
				['p', 'h1', 'h2', 'h3', 'ul', 'ol', 'blockquote', 'img', 'code_block'].includes(
					String(node.type),
				),
		)
	)
}

function blocksToSlate(blocks: Block[], template: unknown): unknown[] {
	const plate = isPlateFlavor(template)
	const leaves = (children: Inline[]): unknown[] => {
		const out = normalizeInline(children).flatMap((child): unknown[] => {
			if (child.kind === 'break') return [{ text: '\n' }]
			if (child.kind === 'link') {
				return [{ type: plate ? 'a' : 'link', url: child.href, children: leaves(child.children) }]
			}
			return [
				{
					text: child.text,
					...(child.bold && { bold: true }),
					...(child.italic && { italic: true }),
					...(child.code && { code: true }),
					...(child.strike && { strikethrough: true }),
				},
			]
		})
		return out.length > 0 ? out : [{ text: '' }]
	}
	const headingNames = [
		'heading-one',
		'heading-two',
		'heading-three',
		'heading-four',
		'heading-five',
		'heading-six',
	]
	return blocks.map((block) => {
		switch (block.kind) {
			case 'paragraph':
				return { type: plate ? 'p' : 'paragraph', children: leaves(block.children) }
			case 'heading':
				return {
					type: plate ? `h${block.level}` : headingNames[block.level - 1],
					children: leaves(block.children),
				}
			case 'quote':
				return { type: plate ? 'blockquote' : 'block-quote', children: leaves(block.children) }
			case 'list':
				return {
					type: plate
						? block.ordered
							? 'ol'
							: 'ul'
						: block.ordered
							? 'numbered-list'
							: 'bulleted-list',
					children: block.items.map((item) =>
						plate
							? { type: 'li', children: [{ type: 'lic', children: leaves(item) }] }
							: { type: 'list-item', children: leaves(item) },
					),
				}
			case 'code':
				return {
					type: plate ? 'code_block' : 'code',
					...(block.lang && { lang: block.lang }),
					children: [{ text: block.text }],
				}
			case 'image':
				return {
					type: plate ? 'img' : 'image',
					url: block.src,
					alt: block.alt,
					children: [{ text: '' }],
				}
			case 'rule':
				return { type: plate ? 'hr' : 'thematic-break', children: [{ text: '' }] }
		}
		return null
	})
}

// ─── Entry points ────────────────────────────────────────────────────────────

export type RichTextConversion =
	| { format: RichTextFormat; markdown: string }
	| { format: RichTextFormat; unsupported: string; preview: string }

function readBlocks(format: RichTextFormat, value: unknown): Block[] {
	switch (format) {
		case 'lexical':
			return lexicalToBlocks(value as Record<string, unknown>)
		case 'editorjs':
			return editorJsToBlocks(value as Record<string, unknown>)
		case 'portable-text':
			return portableTextToBlocks(value as unknown[])
		case 'slate':
			return slateToBlocks(value as unknown[])
	}
}

/** Every text leaf of a document, for a read-only preview. */
function previewText(value: unknown): string {
	const parts: string[] = []
	const visit = (node: unknown, inBlock: boolean) => {
		if (Array.isArray(node)) {
			for (const child of node) visit(child, inBlock)
			return
		}
		if (!isObject(node)) return
		if (typeof node.text === 'string' && !Array.isArray(node.children)) {
			parts.push(inBlock ? node.text.replace(/<[^>]+>/g, '') : `${node.text}\n`)
			return
		}
		for (const [name, child] of Object.entries(node)) {
			if (['children', 'root', 'blocks', 'data', 'items'].includes(name)) visit(child, inBlock)
		}
		if (Array.isArray(node.children) || isObject(node.data)) parts.push('\n')
	}
	visit(value, true)
	return parts
		.join('')
		.replace(/\n{3,}/g, '\n\n')
		.trim()
}

/**
 * Editor state as markdown, when every block it uses converts losslessly;
 * otherwise what it uses that cannot, and a plain-text preview.
 */
export function richTextToMarkdown(value: unknown): RichTextConversion | null {
	const format = detectRichTextFormat(value)
	if (!format) return null
	try {
		return { format, markdown: blocksToMarkdown(readBlocks(format, value)) }
	} catch (err) {
		if (err instanceof Unsupported)
			return { format, unsupported: err.what, preview: previewText(value) }
		throw err
	}
}

/** Markdown as editor state of `format`, keeping the template's own wrapper. */
export function markdownToRichText(
	markdown: string,
	format: RichTextFormat,
	template?: unknown,
): unknown {
	const blocks = markdownToBlocks(markdown)
	switch (format) {
		case 'lexical':
			return blocksToLexical(blocks, template)
		case 'editorjs':
			return blocksToEditorJs(blocks, template)
		case 'portable-text':
			return blocksToPortableText(blocks, template)
		case 'slate':
			return blocksToSlate(blocks, template)
	}
}
