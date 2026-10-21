/**
 * The value a number input emits. A JS number when it holds the typed value
 * exactly; otherwise the typed digits as a string, so a bigint or a high-
 * precision decimal reaches the source unrounded (the API writes it as an exact
 * numeric, and a JS float would have rounded it on the way).
 */
export function toNumberValue(text: string): number | string {
	const n = Number(text)
	if (!Number.isFinite(n)) return text
	const digits = text.replace(/^[-+]?0*|[.eE].*$/g, '').length + (text.split('.')[1] ?? '').length
	return Number.isSafeInteger(n) || digits <= 15 ? n : text
}
