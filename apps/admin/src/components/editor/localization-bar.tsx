import { useTranslation } from 'react-i18next'
import i18n from '../../lib/i18n'
import { Dropdown } from '../dropdown'

/**
 * Look up a friendly language name for a locale code, localized to the user's
 * interface language (via `navigator.language`). Uses the browser-built `Intl.
 * DisplayNames` API. Non-standard codes (`ua`, `cn`, `kr`) get explicit fallbacks
 * — `Intl` only recognizes ISO 639-1, but legacy data often uses these aliases.
 */
const NON_STANDARD_LOCALE_NAMES: Record<string, string> = {
	ua: 'Ukrainian',
	cn: 'Chinese',
	kr: 'Korean',
}

export function localeDisplayName(code: string): string {
	try {
		const ui = i18n.language || 'en'
		const dn = new Intl.DisplayNames([ui], { type: 'language' })
		const result = dn.of(code)
		// `Intl.DisplayNames.of` echoes the input back uppercased when unknown
		// (e.g. `of('ua')` → `'UA'`). Treat that as a miss and use our fallback.
		if (result && result.toLowerCase() !== code.toLowerCase()) return result
	} catch {
		/* fall through */
	}
	return NON_STANDARD_LOCALE_NAMES[code.toLowerCase()] ?? code.toUpperCase()
}

interface LocalizationBarProps {
	mode: 'single' | 'compare'
	onModeChange: (mode: 'single' | 'compare') => void
	activeLocale: string
	onActiveLocaleChange: (locale: string) => void
	leftLocale: string
	onLeftLocaleChange: (locale: string) => void
	rightLocale: string
	onRightLocaleChange: (locale: string) => void
	locales: string[]
	/**
	 * When provided (the AI assistant is licensed), a "Translate" button appears in
	 * compare mode. Bulk-translates every localized field and the body from the left
	 * (source) locale into the right (target) locale.
	 */
	onTranslate?: () => void
	translating?: boolean
}

function ModeButton({
	active,
	onClick,
	label,
	children,
}: {
	active: boolean
	onClick: () => void
	label: string
	children: React.ReactNode
}) {
	return (
		<button
			type="button"
			onClick={onClick}
			aria-label={label}
			aria-pressed={active}
			title={label}
			className={`flex items-center justify-center w-7 h-7 rounded transition-colors ${
				active
					? 'bg-surface-alt text-text'
					: 'text-text-muted hover:text-text hover:bg-surface-alt/60'
			}`}
		>
			{children}
		</button>
	)
}

/** Top-of-sidebar control for switching between single-locale and side-by-side compare views. */
export function LocalizationBar({
	mode,
	onModeChange,
	activeLocale,
	onActiveLocaleChange,
	leftLocale,
	onLeftLocaleChange,
	rightLocale,
	onRightLocaleChange,
	locales,
	onTranslate,
	translating,
}: LocalizationBarProps) {
	const { t } = useTranslation()
	// Show full language names ("English", "Ukrainian") localized to the UI language,
	// not bare codes. Codes are still the underlying value passed via onChange.
	const baseOptions = locales.map((l) => ({ value: l, label: localeDisplayName(l) }))
	// No disabled-option rule here: with only 2 effective locales the rule locks
	// both panes (you'd have to leave compare mode to swap). Instead the parent's
	// change handlers swap panes automatically when the picked locale conflicts
	// with the other pane — see `onLeftLocaleChange` / `onRightLocaleChange`.
	const leftOptions = baseOptions
	const rightOptions = baseOptions

	return (
		// `items-stretch` makes the mode-toggle container match the Dropdown's intrinsic
		// height, so both controls visually share the same baseline & cap height with no
		// arbitrary pixel math. No background or border — the bar reads as a control row,
		// not a card, against the central content area.
		<div className="inline-flex items-stretch gap-2">
			<span className="self-center text-[11px] text-text-muted font-mono uppercase shrink-0">
				{t('editor.localizationBar.locale')}
			</span>
			{/* Dropdowns wrapper. Animates between two widths:
			    - single mode: w-[8.4rem] (one dropdown, 20% wider than the original 7rem)
			    - compare mode: w-[17.05rem] (two w-[8.4rem] + gap-1 0.25rem)
			    The right dropdown is always mounted but collapsed in single mode — that
			    lets CSS interpolate its width/opacity/scale cleanly instead of mount-flicker. */}
			{/* No `overflow-hidden` here: the dropdown menu opens below the button via
			    `position: absolute top-full`, and any clipping ancestor would crop it to
			    the bar's height. The collapsed second-dropdown wrapper relies on
			    opacity-0 + pointer-events-none for invisibility instead of clipping. */}
			<div
				className={`flex items-stretch gap-1 transition-[width] duration-500 ease-[cubic-bezier(0.16,1,0.3,1)] ${
					mode === 'compare' ? 'w-[17.05rem]' : 'w-[8.4rem]'
				}`}
			>
				{/* Primary dropdown — always visible. Binds to leftLocale in compare mode,
				    activeLocale in single mode; the parent keeps these two in sync on mode
				    toggle so the dropdown's displayed value doesn't flip mid-animation. */}
				<Dropdown
					value={mode === 'compare' ? leftLocale : activeLocale}
					onChange={mode === 'compare' ? onLeftLocaleChange : onActiveLocaleChange}
					options={leftOptions}
					className="w-[8.4rem] shrink-0"
				/>
				{/* Secondary dropdown — animated reveal. `origin-left` makes it appear to
				    grow out of the primary's right edge. */}
				<div
					aria-hidden={mode !== 'compare'}
					className={`origin-left transition-all duration-500 ease-[cubic-bezier(0.16,1,0.3,1)] ${
						mode === 'compare'
							? 'w-[8.4rem] opacity-100 scale-x-100'
							: 'w-0 opacity-0 scale-x-50 pointer-events-none'
					}`}
				>
					<Dropdown
						value={rightLocale}
						onChange={onRightLocaleChange}
						options={rightOptions}
						className="w-[8.4rem]"
					/>
				</div>
			</div>
			{/* `p-1` gives the mode-toggle container 4px padding on all four sides — horizontal
			    matches vertical, and the resulting outer height (4 + 28 + 4 + 2 border = 38px)
			    aligns perfectly with the Dropdown's intrinsic height.
			    Hidden when the project only has one locale — there's nothing to compare. */}
			<div
				className={`flex items-center gap-0.5 shrink-0 p-1 rounded bg-input border border-border ${locales.length < 2 ? 'hidden' : ''}`}
			>
				<ModeButton
					active={mode === 'single'}
					onClick={() => onModeChange('single')}
					label={t('editor.localizationBar.singleLocale')}
				>
					<svg
						width="14"
						height="14"
						viewBox="0 0 24 24"
						fill="none"
						stroke="currentColor"
						strokeWidth="2"
						strokeLinecap="round"
						strokeLinejoin="round"
					>
						<rect x="4" y="5" width="16" height="14" rx="2" />
					</svg>
				</ModeButton>
				<ModeButton
					active={mode === 'compare'}
					onClick={() => onModeChange('compare')}
					label={t('editor.localizationBar.compareLocales')}
				>
					<svg
						width="14"
						height="14"
						viewBox="0 0 24 24"
						fill="none"
						stroke="currentColor"
						strokeWidth="2"
						strokeLinecap="round"
						strokeLinejoin="round"
					>
						<rect x="3" y="5" width="8" height="14" rx="1.5" />
						<rect x="13" y="5" width="8" height="14" rx="1.5" />
					</svg>
				</ModeButton>
			</div>
			{/* Translate button — animated reveal, compare mode only. `overflow-hidden` is
			    safe here (no popup menu); `max-w` is used because `width: auto` isn't
			    transitionable. Bulk-translates left → right locale.
			    Hidden when source == target — "translate EN → EN" is meaningless. */}
			{onTranslate && leftLocale !== rightLocale && (
				<div
					aria-hidden={mode !== 'compare'}
					className={`flex items-stretch origin-left overflow-hidden transition-all duration-500 ease-[cubic-bezier(0.16,1,0.3,1)] ${
						mode === 'compare'
							? 'max-w-[12rem] opacity-100 scale-100'
							: 'max-w-0 opacity-0 scale-50 pointer-events-none'
					}`}
				>
					<button
						type="button"
						onClick={onTranslate}
						disabled={translating}
						title={t('editor.localizationBar.translateWithAiTitle', {
							source: leftLocale.toUpperCase(),
							target: rightLocale.toUpperCase(),
						})}
						className="flex items-center gap-1.5 px-2.5 rounded bg-input border border-border text-xs font-medium text-text-secondary whitespace-nowrap transition-colors hover:text-text hover:bg-surface-alt disabled:opacity-40 disabled:hover:bg-input disabled:hover:text-text-secondary"
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
								width="13"
								height="13"
								viewBox="0 0 24 24"
								fill="none"
								stroke="currentColor"
								strokeWidth="2"
								strokeLinecap="round"
								strokeLinejoin="round"
								aria-hidden="true"
							>
								<path d="m5 8 6 6" />
								<path d="m4 14 6-6 2-3" />
								<path d="M2 5h12" />
								<path d="M7 2h1" />
								<path d="m22 22-5-10-5 10" />
								<path d="M14 18h6" />
							</svg>
						)}
						{translating
							? t('editor.localizationBar.translating')
							: t('editor.localizationBar.translate')}
					</button>
				</div>
			)}
		</div>
	)
}
