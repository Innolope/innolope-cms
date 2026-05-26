import { useLayoutEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'

/**
 * Auto-grow a textarea to fit its content, up to a CSS-imposed `max-h`.
 *
 * Approach: each render, reset the height to `auto` (forces the browser to
 * recompute `scrollHeight` for the current content), then set the height to
 * that scrollHeight. CSS `max-h-*` clamps the visual height; the browser keeps
 * the textarea scrollable once content exceeds the cap.
 *
 * `useLayoutEffect` runs before paint so users don't see a one-frame flash
 * of the textarea at its default `rows` height before settling.
 */
function useAutoSizeTextarea(value: string) {
	const ref = useRef<HTMLTextAreaElement>(null)
	// biome-ignore lint/correctness/useExhaustiveDependencies: `value` triggers re-measurement when content changes; the effect doesn't read it directly but it's the right trigger.
	useLayoutEffect(() => {
		const el = ref.current
		if (!el) return
		el.style.height = 'auto'
		el.style.height = `${el.scrollHeight}px`
	}, [value])
	return ref
}

interface LocalizedTextFieldProps {
	value: unknown
	mode: 'single' | 'compare'
	activeLocale: string
	leftLocale: string
	rightLocale: string
	defaultLocale: string
	onChange: (next: Record<string, string>) => void
	/**
	 * When provided (the AI assistant is licensed), a translate button appears
	 * between the two compare-mode panes. Translates the left (source) locale
	 * value into the right (target) locale.
	 */
	onTranslate?: (sourceLocale: string, targetLocale: string) => void
	translating?: boolean
	disabled?: boolean
}

/** Coerce `value` into a `{ locale: string }` map, seeding bare strings under the default locale. */
function toLocaleMap(value: unknown, defaultLocale: string): Record<string, string> {
	if (value && typeof value === 'object' && !Array.isArray(value)) {
		const out: Record<string, string> = {}
		for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
			out[k] = typeof v === 'string' ? v : v == null ? '' : String(v)
		}
		return out
	}
	if (typeof value === 'string' && value !== '') {
		return { [defaultLocale]: value }
	}
	return {}
}

const inputClass =
	'w-full px-3 py-2 bg-input border border-border rounded text-sm focus:outline-none focus:border-border-strong disabled:opacity-60'

function LocaleInput({
	locale,
	value,
	onChange,
	disabled,
}: {
	locale: string
	value: string
	onChange: (v: string) => void
	disabled?: boolean
}) {
	// Always an auto-growing `<textarea rows={1}>`: it looks like a single-line input
	// when empty/short and grows seamlessly as content is added — no `<input>`↔
	// `<textarea>` element swap (which would lose focus mid-typing) and no fixed
	// multi-row minimum height.
	// Padding-right makes room for the locale tag inside the input frame.
	// `pr-12` (3rem) fits 2-3 character codes (`EN`, `UA`, `EN-US`) comfortably.
	const inputWithTag = `${inputClass} pr-12`
	const textareaRef = useAutoSizeTextarea(value)
	return (
		<div className="relative">
			<textarea
				ref={textareaRef}
				value={value}
				disabled={disabled}
				onChange={(e) => onChange(e.target.value)}
				rows={1}
				// `max-h-80` (20rem ≈ 320px) caps the auto-grow; past this the textarea
				// becomes scrollable. `resize-none` because we manage height in JS now.
				className={`${inputWithTag} max-h-80 resize-none overflow-y-auto`}
			/>
			{/* Locale tag — faded, lives at the right edge of the input frame. Anchored to
			    the top so it stays put once the textarea grows past one line. */}
			<span
				aria-hidden="true"
				className="pointer-events-none absolute right-2.5 top-2.5 text-[10px] font-mono font-medium uppercase tracking-wider text-text-muted/70 select-none"
			>
				{locale}
			</span>
		</div>
	)
}

/**
 * Edits a localized text field (`{ en: "...", ua: "..." }`).
 * - Single mode: one input bound to the active locale.
 * - Compare mode: two inputs side-by-side bound to leftLocale/rightLocale.
 *
 * Both inputs are always mounted so CSS can interpolate between layouts on
 * mode toggle — the right pane animates between `flex: 1` (compare) and
 * `flex: 0` (single) with matching opacity/scale. Locales not currently
 * visible are preserved through edits.
 */
export function LocalizedTextField({
	value,
	mode,
	activeLocale,
	leftLocale,
	rightLocale,
	defaultLocale,
	onChange,
	onTranslate,
	translating,
	disabled,
}: LocalizedTextFieldProps) {
	const { t } = useTranslation()
	const map = toLocaleMap(value, defaultLocale)

	const setLocale = (locale: string, text: string) => {
		onChange({ ...map, [locale]: text })
	}

	// In compare mode the left input shows `leftLocale`. In single mode it shows
	// `activeLocale`. The parent keeps these two in sync on mode toggle so the
	// visible value doesn't flip mid-animation.
	const primaryLocale = mode === 'compare' ? leftLocale : activeLocale

	return (
		<div className="flex gap-2">
			<div className="flex-1 min-w-0">
				<LocaleInput
					locale={primaryLocale}
					value={map[primaryLocale] ?? ''}
					onChange={(v) => setLocale(primaryLocale, v)}
					disabled={disabled}
				/>
			</div>
			{/* Translate button — sits in the gap between the two panes. Animated reveal
			    matching the right pane: visible only in compare mode. `-ml-2` cancels the
			    parent's `gap-2` when collapsed so it leaves no seam in single mode. */}
			{onTranslate && (
				<div
					aria-hidden={mode !== 'compare'}
					className={`shrink-0 origin-left overflow-hidden transition-all duration-500 ease-[cubic-bezier(0.16,1,0.3,1)] ${
						mode === 'compare'
							? 'w-7 opacity-100 scale-100'
							: 'w-0 -ml-2 opacity-0 scale-50 pointer-events-none'
					}`}
				>
					<button
						type="button"
						onClick={() => onTranslate(leftLocale, rightLocale)}
						disabled={disabled || translating || leftLocale === rightLocale}
						aria-label={t('editor.localizedTextField.translateAria', {
							source: leftLocale.toUpperCase(),
							target: rightLocale.toUpperCase(),
						})}
						title={t('editor.localizedTextField.translateTitle', {
							source: leftLocale.toUpperCase(),
							target: rightLocale.toUpperCase(),
						})}
						className="flex items-center justify-center w-7 h-9 rounded bg-input border border-border text-text-muted transition-colors hover:text-text hover:bg-surface-alt disabled:opacity-40 disabled:hover:bg-input disabled:hover:text-text-muted"
					>
						{translating ? (
							<svg
								width="13"
								height="13"
								viewBox="0 0 24 24"
								fill="none"
								stroke="currentColor"
								strokeWidth="2"
								strokeLinecap="round"
								className="animate-spin"
								aria-hidden="true"
							>
								<path d="M21 12a9 9 0 1 1-6.219-8.56" />
							</svg>
						) : (
							<svg
								width="14"
								height="14"
								viewBox="0 0 24 24"
								fill="none"
								stroke="currentColor"
								strokeWidth="2"
								strokeLinecap="round"
								strokeLinejoin="round"
								aria-hidden="true"
							>
								<path d="M5 12h14" />
								<path d="m12 5 7 7-7 7" />
							</svg>
						)}
					</button>
				</div>
			)}
			{/* Right pane — animated. `flex-[0_0_0]` collapses to zero basis with no
			    grow/shrink; `-ml-2` cancels the parent's `gap-2` so the collapsed pane
			    leaves no visual seam between siblings. */}
			<div
				aria-hidden={mode !== 'compare'}
				className={`origin-left overflow-hidden transition-all duration-500 ease-[cubic-bezier(0.16,1,0.3,1)] ${
					mode === 'compare'
						? 'flex-1 min-w-0 opacity-100 scale-x-100'
						: 'flex-[0_0_0] -ml-2 opacity-0 scale-x-50 pointer-events-none'
				}`}
			>
				<LocaleInput
					locale={rightLocale}
					value={map[rightLocale] ?? ''}
					onChange={(v) => setLocale(rightLocale, v)}
					disabled={disabled}
				/>
			</div>
		</div>
	)
}
