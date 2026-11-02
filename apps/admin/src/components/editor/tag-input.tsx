import { useEffect, useState } from 'react'
import { api } from '../../lib/api-client'
import { PillInput } from './pill-input'

const normalized = (value: string) => value.trim().normalize('NFKC').toLowerCase()

/** Collection-scoped suggestions; a lookup never owns or clears the draft. */
export function TagInput({
	collectionId,
	projectId,
	value,
	onChange,
	disabled,
	placeholder,
}: {
	collectionId: string
	projectId?: string
	value: string[]
	onChange: (value: string[]) => void
	disabled?: boolean
	placeholder?: string
}) {
	const scope = `${projectId ?? ''}:${collectionId}`
	const [draft, setDraft] = useState({ scope, value: '' })
	const query = draft.scope === scope ? draft.value.trim().normalize('NFKC') : ''
	const [results, setResults] = useState({ scope, query: '', values: [] as string[] })
	useEffect(() => {
		if (disabled || !collectionId || Array.from(query).length < 3 || Array.from(query).length > 120)
			return
		let active = true
		const controller = new AbortController()
		let timeout: number | undefined
		const debounce = window.setTimeout(() => {
			timeout = window.setTimeout(() => {
				active = false
				controller.abort()
			}, 5000)
			void api
				.get<{ suggestions: string[] }>(
					`/api/v1/collections/${encodeURIComponent(collectionId)}/tag-suggestions?q=${encodeURIComponent(query)}`,
					{ signal: controller.signal },
				)
				.then((response) => {
					if (active)
						setResults({
							scope,
							query,
							values: response.suggestions.filter(
								(item) => typeof item === 'string' && item.trim(),
							),
						})
				})
				.catch(() => {
					if (active) setResults({ scope, query, values: [] })
				})
				.finally(() => window.clearTimeout(timeout))
		}, 200)
		return () => {
			active = false
			window.clearTimeout(debounce)
			window.clearTimeout(timeout)
			controller.abort()
		}
	}, [query, scope, collectionId, disabled])
	const selected = new Set(value.map(normalized))
	const suggestions =
		!disabled && results.scope === scope && results.query === query && Array.from(query).length >= 3
			? [
					...new Map(
						results.values
							.filter((item) => !selected.has(normalized(item)))
							.map((item) => [normalized(item), item]),
					).values(),
				]
			: []
	return (
		<PillInput
			key={scope}
			value={value}
			disabled={disabled}
			placeholder={placeholder}
			suggestions={suggestions}
			onDraftChange={(text) => setDraft({ scope, value: text })}
			onChange={(next) => {
				if (disabled) return
				const seen = new Set<string>()
				onChange(
					next.filter((item) => {
						const key = normalized(item)
						if (!key || seen.has(key)) return false
						seen.add(key)
						return true
					}),
				)
			}}
		/>
	)
}
