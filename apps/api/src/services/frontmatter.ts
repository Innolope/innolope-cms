/**
 * Frontmatter normalization — makes `metadata` the single source of truth for
 * structured fields.
 *
 * Contract: `markdown` stores the prose body ONLY. Structured fields live in
 * `metadata`. Historically imported records embedded a YAML frontmatter copy of
 * their fields inside the markdown (while native records kept metadata
 * separate), which meant the same field existed in two places that could
 * disagree. New imports no longer embed frontmatter, and any frontmatter an API
 * caller pastes into `markdown` is stripped here and merged into `metadata`.
 */

/**
 * Parse a leading YAML frontmatter block. Mirrors the admin editor's parser:
 * flat key/value pairs with quoted-string, boolean, number, and JSON-array
 * coercion — the exact dialect `documentToMarkdown` used to emit. Returns the
 * body unchanged when no frontmatter is present.
 */
export function parseFrontmatter(md: string): { body: string; meta: Record<string, unknown> } {
	const match = md.match(/^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/)
	if (!match) return { body: md, meta: {} }

	const yamlBlock = match[1]
	const body = match[2]
	const meta: Record<string, unknown> = {}

	for (const line of yamlBlock.split('\n')) {
		const m = line.match(/^(\w[\w-]*):\s*(.*)$/)
		if (!m) continue
		const [, key, rawVal] = m
		let val: unknown = rawVal.trim()
		if (typeof val === 'string' && val.startsWith('"') && val.endsWith('"')) {
			val = val.slice(1, -1).replace(/\\"/g, '"').replace(/\\n/g, '\n')
		}
		if (val === 'true') val = true
		else if (val === 'false') val = false
		else if (typeof val === 'string' && val && !Number.isNaN(Number(val))) val = Number(val)
		else if (typeof val === 'string' && val.startsWith('[') && val.endsWith(']')) {
			try {
				val = JSON.parse(val)
			} catch {
				/* keep as string */
			}
		}
		meta[key] = val
	}

	return { body, meta }
}

/**
 * Normalize an incoming write: strip any YAML frontmatter out of `markdown`
 * and fold its fields into `metadata`. Explicitly provided metadata keys win
 * over frontmatter values — frontmatter is treated as a fallback spelling of
 * the same intent, never an override. Also coalesces a missing markdown to ""
 * (markdown is optional for data-shaped records).
 */
export function normalizeIncomingMarkdown(
	markdown: string | undefined,
	metadata: Record<string, unknown> | undefined,
): { markdown: string; metadata: Record<string, unknown> } {
	const md = markdown ?? ''
	const { body, meta } = parseFrontmatter(md)
	if (Object.keys(meta).length === 0) return { markdown: md, metadata: metadata ?? {} }
	return { markdown: body, metadata: { ...meta, ...(metadata ?? {}) } }
}
