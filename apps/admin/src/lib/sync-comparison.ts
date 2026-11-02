import { type ChangeObject, diffWordsWithSpace } from 'diff'

export interface ComparisonRow {
	path: string[]
	local: unknown
	external: unknown
}

/** Compare actual values, including absent keys and individual array entries. */
export function comparisonRows(local: unknown, external: unknown): ComparisonRow[] {
	const result: ComparisonRow[] = []
	const visit = (a: unknown, b: unknown, path: string[], depth: number) => {
		if (Object.is(a, b)) return
		const object = (value: unknown): value is Record<string, unknown> =>
			value !== null && typeof value === 'object'
		if (depth < 20 && object(a) && object(b) && Array.isArray(a) === Array.isArray(b)) {
			for (const key of [...new Set([...Object.keys(a), ...Object.keys(b)])].sort())
				visit(
					Object.hasOwn(a, key) ? a[key] : undefined,
					Object.hasOwn(b, key) ? b[key] : undefined,
					[...path, key],
					depth + 1,
				)
		} else result.push({ path, local: a, external: b })
	}
	visit(local, external, [], 0)
	return result
}

/** Strip common context first; bound word-diff work and disclose its fallback. */
export function comparisonText(
	local: string,
	external: string,
): { parts: ChangeObject<string>[]; grouped: boolean } {
	const a = Array.from(local)
	const b = Array.from(external)
	let prefix = 0
	while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix++
	let suffix = 0
	while (
		suffix < a.length - prefix &&
		suffix < b.length - prefix &&
		a[a.length - suffix - 1] === b[b.length - suffix - 1]
	)
		suffix++
	const left = a.slice(prefix, a.length - suffix).join('')
	const right = b.slice(prefix, b.length - suffix).join('')
	const middle = diffWordsWithSpace(left, right, { timeout: 50, maxEditLength: 1000 })
	const unchanged = (value: string): ChangeObject<string> => ({
		value,
		count: value.length,
		added: false,
		removed: false,
	})
	return {
		parts: [
			...(prefix ? [unchanged(a.slice(0, prefix).join(''))] : []),
			...(middle ?? [
				...(left ? [{ value: left, count: left.length, added: false, removed: true }] : []),
				...(right ? [{ value: right, count: right.length, added: true, removed: false }] : []),
			]),
			...(suffix ? [unchanged(a.slice(a.length - suffix).join(''))] : []),
		],
		grouped: middle === undefined,
	}
}
