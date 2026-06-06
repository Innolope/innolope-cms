import { useLayoutEffect, useRef } from 'react'

/**
 * Auto-grow a textarea to fit its content, up to any CSS-imposed `max-h`.
 *
 * Each time `value` changes, reset the height to `auto` (so the browser
 * recomputes `scrollHeight` for the current content), then pin the height to
 * that scrollHeight. A CSS `max-h-*` clamps the visual height and the textarea
 * scrolls once content exceeds the cap. `useLayoutEffect` runs before paint so
 * there's no one-frame flash at the default `rows` height.
 */
export function useAutoSizeTextarea(value: string) {
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
