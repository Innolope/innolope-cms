import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

interface JsonFieldProps {
	value: unknown
	onChange: (value: unknown) => void
	disabled?: boolean
	/** Smaller textarea for use inside nested cells (e.g. ObjectArrayField). */
	compact?: boolean
}

/** Pretty-prints `value` for the textarea. Strings keep their literal form. */
function toText(value: unknown): string {
	if (value === undefined || value === null) return ''
	if (typeof value === 'string') return value
	try {
		return JSON.stringify(value, null, 2)
	} catch {
		return String(value)
	}
}

/**
 * Editor for nested object / array values. Pretty-prints JSON, commits the parsed
 * value on blur. Invalid JSON is rejected with an inline error and the prior value
 * is preserved — the user keeps editing until the JSON parses.
 */
export function JsonField({ value, onChange, disabled, compact }: JsonFieldProps) {
	const { t } = useTranslation()
	const [text, setText] = useState(() => toText(value))
	const [error, setError] = useState<string | null>(null)
	const lastExternalRef = useRef<string>(toText(value))

	// Sync from external value changes (e.g. parent resets the field) without
	// clobbering the user's in-progress edit.
	useEffect(() => {
		const next = toText(value)
		if (next !== lastExternalRef.current) {
			lastExternalRef.current = next
			setText(next)
			setError(null)
		}
	}, [value])

	/**
	 * Parse `text` and propagate to the parent.
	 *
	 * Called on every keystroke (so a Save click never loses unblurred JSON — see
	 * the bug where typed values were silently dropped because commit only fired
	 * on blur), AND on blur as a safety net. We tolerate partial/invalid JSON
	 * mid-typing by surfacing the parse error inline without clobbering the
	 * last known-good value: parent state stays at the previous parse-success
	 * until the user either fixes the JSON or clears the field entirely.
	 */
	const commit = (raw: string) => {
		const trimmed = raw.trim()
		if (trimmed === '') {
			setError(null)
			lastExternalRef.current = ''
			onChange(undefined)
			return
		}
		try {
			const parsed = JSON.parse(trimmed)
			setError(null)
			lastExternalRef.current = toText(parsed)
			onChange(parsed)
		} catch (e) {
			setError(e instanceof Error ? e.message : t('editor.jsonField.invalidJson'))
		}
	}

	const rows = compact ? 3 : 6
	const maxHeightClass = compact ? 'max-h-48' : 'max-h-96'

	// Auto-grow the textarea to fit content, capped by `max-h-*`. See the matching
	// `useAutoSizeTextarea` helper in localized-text-field.tsx for the rationale.
	const textareaRef = useRef<HTMLTextAreaElement>(null)
	// biome-ignore lint/correctness/useExhaustiveDependencies: `text` triggers re-measurement when content changes.
	useLayoutEffect(() => {
		const el = textareaRef.current
		if (!el) return
		el.style.height = 'auto'
		el.style.height = `${el.scrollHeight}px`
	}, [text])

	return (
		<div>
			<textarea
				ref={textareaRef}
				value={text}
				disabled={disabled}
				onChange={(e) => {
					setText(e.target.value)
					commit(e.target.value)
				}}
				onBlur={(e) => commit(e.target.value)}
				rows={rows}
				spellCheck={false}
				className={`w-full px-3 py-2 bg-input border ${
					error ? 'border-danger' : 'border-border'
				} rounded text-xs font-mono focus:outline-none focus:border-border-strong disabled:opacity-60 resize-none overflow-y-auto ${maxHeightClass}`}
			/>
			{error && (
				<p className="mt-1 text-[11px] text-danger font-mono">
					{t('editor.jsonField.invalidJsonWithMessage', { message: error })}
				</p>
			)}
		</div>
	)
}
