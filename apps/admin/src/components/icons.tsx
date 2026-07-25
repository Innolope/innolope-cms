/**
 * Shared line-art icons.
 *
 * The admin used to sprinkle emoji (`✉️`, `✨`, `✓`, `↑`) into markup as
 * pseudo-icons. They render as full-colour glyphs from whatever emoji font the
 * OS ships, ignore `currentColor`, and sit on a different baseline per platform.
 * These are plain strokes instead: they inherit text colour, hover and disabled
 * states, and look the same everywhere.
 *
 * Every icon takes `className` for sizing (default 1em, so they line up with
 * surrounding text) and is `aria-hidden` — the accessible name belongs on the
 * button or a sibling label, not on the glyph.
 */

interface IconProps {
	className?: string
}

function Svg({ className, children }: IconProps & { children: React.ReactNode }) {
	return (
		<svg
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth="2"
			strokeLinecap="round"
			strokeLinejoin="round"
			aria-hidden="true"
			className={`shrink-0 ${className ?? 'w-[1em] h-[1em]'}`}
		>
			{children}
		</svg>
	)
}

/** Sent-mail / check-your-inbox states. */
export function MailIcon({ className }: IconProps) {
	return (
		<Svg className={className}>
			<rect x="2" y="4" width="20" height="16" rx="2" />
			<path d="m2 7 10 6 10-6" />
		</Svg>
	)
}

/** Success confirmation. */
export function CheckIcon({ className }: IconProps) {
	return (
		<Svg className={className}>
			<path d="M20 6 9 17l-5-5" />
		</Svg>
	)
}

/** The AI affordance across the editor. */
export function SparklesIcon({ className }: IconProps) {
	return (
		<Svg className={className}>
			<path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9L12 3z" />
			<path d="M19 15l.9 2.1L22 18l-2.1.9L19 21l-.9-2.1L16 18l2.1-.9L19 15z" />
		</Svg>
	)
}

/** A publish date that hasn't arrived yet. */
export function ClockIcon({ className }: IconProps) {
	return (
		<Svg className={className}>
			<circle cx="12" cy="12" r="9" />
			<path d="M12 7v5l3 2" />
		</Svg>
	)
}

/** Column sort state: ascending, descending, or sortable-but-unsorted. */
export function SortIcon({ dir, className }: IconProps & { dir: 'asc' | 'desc' | null }) {
	if (dir === 'asc')
		return (
			<Svg className={className}>
				<path d="M12 19V5" />
				<path d="m5 12 7-7 7 7" />
			</Svg>
		)
	if (dir === 'desc')
		return (
			<Svg className={className}>
				<path d="M12 5v14" />
				<path d="m19 12-7 7-7-7" />
			</Svg>
		)
	return (
		<Svg className={className}>
			<path d="m7 15 5 5 5-5" />
			<path d="m7 9 5-5 5 5" />
		</Svg>
	)
}
