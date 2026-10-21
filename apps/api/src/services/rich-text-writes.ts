/**
 * Markdown written to a field the source stores as rich-text editor state.
 *
 * The editor edits a rich-text field — or a body the source keeps as Lexical,
 * Editor.js, Portable Text or Slate — as markdown, and so may an MCP agent or
 * an SDK client. Before validation and the external write, that markdown is
 * converted back into the field's own editor format, using the stored document
 * as the template so its wrapper (Editor.js version, Lexical root props) is
 * kept. A document that uses blocks the converter cannot represent is refused
 * rather than flattened: the site renders those blocks with its own
 * components, and a markdown overwrite would silently remove them.
 */

import { type CollectionField, detectRichTextFormat, type RichTextFormat } from '@innolope/config'
import { BODY_FIELD_NAMES } from './localized-fields.js'
import { markdownToRichText, richTextToMarkdown } from './rich-text.js'
import { stableValue } from './sync-state.js'

export interface RichTextWriteIssue {
	field: string
	message: string
}

function label(field: CollectionField | undefined, name: string): string {
	return field?.label || name
}

/**
 * Convert `markdown` for one field. Returns the editor state, or an issue when
 * the stored document cannot be safely replaced or the format is unknown.
 */
function convert(
	name: string,
	field: CollectionField | undefined,
	markdown: string,
	current: unknown,
): { value?: unknown; issue?: RichTextWriteIssue } {
	const format: RichTextFormat | null =
		field?.ui?.richTextFormat ?? detectRichTextFormat(current) ?? null
	if (!format) {
		return {
			issue: {
				field: name,
				message: `${label(field, name)} is stored as rich-text editor state, but its format is unknown, so markdown cannot be converted into it.`,
			},
		}
	}
	const stored = current !== undefined && current !== null ? richTextToMarkdown(current) : null
	if (stored && 'unsupported' in stored) {
		return {
			issue: {
				field: name,
				message: `${label(field, name)} uses ${stored.unsupported}, which cannot be converted from markdown without losing it. Edit it where it was created.`,
			},
		}
	}
	try {
		return { value: markdownToRichText(markdown, format, current) }
	} catch (err) {
		const what = err instanceof Error ? err.message : 'some of this content'
		return {
			issue: {
				field: name,
				message: `${label(field, name)} cannot hold ${what} in its ${format} format.`,
			},
		}
	}
}

/**
 * Apply markdown writes to rich-text fields of `input.metadata`, and to the
 * body when the source stores it as editor state. Returns the metadata to use
 * (the original object when nothing changed) and any refusals.
 */
export function applyRichTextWrites(
	fields: CollectionField[] | null | undefined,
	input: { metadata?: Record<string, unknown>; markdown?: string },
	opts: { current?: { metadata: Record<string, unknown>; markdown: string } } = {},
): { metadata: Record<string, unknown> | undefined; issues: RichTextWriteIssue[] } {
	const declared = fields ?? []
	const issues: RichTextWriteIssue[] = []
	let out: Record<string, unknown> | null = null
	const target = () => {
		out ??= { ...(input.metadata ?? {}) }
		return out
	}
	const bodyField = BODY_FIELD_NAMES.find((name) => declared.some((field) => field.name === name))

	for (const field of declared) {
		if (field.name === bodyField || field.ui?.preset !== 'rich-text') continue
		const value = input.metadata?.[field.name]
		if (typeof value !== 'string') continue
		const result = convert(field.name, field, value, opts.current?.metadata[field.name])
		if (result.issue) issues.push(result.issue)
		else target()[field.name] = result.value
	}

	if (bodyField) {
		const field = declared.find((f) => f.name === bodyField)
		const currentBody = opts.current?.metadata[bodyField]
		const incomingBody = input.metadata?.[bodyField]
		const isRichBody =
			Boolean(detectRichTextFormat(currentBody)) || field?.ui?.preset === 'rich-text'
		// A caller that sends new editor state for the body has said what it wants.
		const sentNewState =
			incomingBody !== undefined &&
			typeof incomingBody !== 'string' &&
			stableValue(incomingBody) !== stableValue(currentBody)
		const markdown = typeof incomingBody === 'string' ? incomingBody : input.markdown
		if (isRichBody && !sentNewState && markdown !== undefined) {
			const stored = currentBody !== undefined ? richTextToMarkdown(currentBody) : null
			const unchanged =
				stored &&
				('markdown' in stored
					? stored.markdown === markdown
					: markdown.trim() === (opts.current?.markdown ?? '').trim())
			if (!unchanged) {
				const result = convert(bodyField, field, markdown, currentBody)
				if (result.issue) issues.push(result.issue)
				else target()[bodyField] = result.value
			} else if (typeof incomingBody === 'string') {
				// The same text sent as a string: keep the stored editor state.
				target()[bodyField] = currentBody
			}
		}
	}

	return { metadata: out ?? input.metadata, issues }
}
