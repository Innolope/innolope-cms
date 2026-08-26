import { Marked } from 'marked'
import TurndownService from 'turndown'

/**
 * The markdown ⇄ HTML pair the TipTap editor round-trips content through. Opening
 * a record parses its markdown to HTML for the editor; saving serialises the
 * editor's HTML back to markdown. They are defined together because they are only
 * ever correct together: anything the parser fails to recognise as a block
 * reaches TipTap as paragraph text, and the serialiser then writes it back with
 * escaped punctuation — a list saved as `\- item` joined by hard breaks, which no
 * site renders as a list. Merely opening a record was enough to destroy it.
 *
 * That is why the parser must be a real CommonMark implementation rather than a
 * handful of regexes: the failure is silent, and it corrupts content nobody
 * intended to edit.
 */
const turndown = new TurndownService({
	headingStyle: 'atx',
	codeBlockStyle: 'fenced',
	bulletListMarker: '-',
})

turndown.addRule('strikethrough', {
	filter: ['del', 's'],
	replacement: (content) => `~~${content}~~`,
})

const markdown = new Marked({ gfm: true, breaks: false, async: false })

// GFM tables are deliberately left unparsed. TipTap's schema has no table node,
// so a parsed <table> is dropped when the document loads and the table is gone on
// the next save. Left as paragraph text it survives the round trip intact, which
// is the lesser of the two failures until the editor gains a table node.
markdown.use({ tokenizer: { table: () => undefined } })

export function htmlFromMarkdown(md: string): string {
	return markdown.parse(md) as string
}

export function markdownFromHtml(html: string): string {
	return turndown.turndown(html)
}
