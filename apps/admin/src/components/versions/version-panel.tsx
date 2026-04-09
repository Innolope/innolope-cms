import { useState, useEffect } from 'react'
import { api } from '../../lib/api-client'

interface Version {
	id: string
	version: number
	markdown: string
	metadata: Record<string, unknown>
	createdAt: string
}

interface VersionPanelProps {
	contentId: string
	currentVersion: number
	onRevert: () => void
}

export function VersionPanel({ contentId, currentVersion, onRevert }: VersionPanelProps) {
	const [versions, setVersions] = useState<Version[]>([])
	const [loading, setLoading] = useState(true)
	const [selected, setSelected] = useState<Version | null>(null)
	const [reverting, setReverting] = useState(false)

	useEffect(() => {
		api.get<Version[]>(`/api/v1/content/${contentId}/versions`)
			.then(setVersions)
			.catch(() => {})
			.finally(() => setLoading(false))
	}, [contentId, currentVersion])

	const revert = async (version: number) => {
		if (!confirm(`Revert to version ${version}? Current content will be saved as a new version.`))
			return
		setReverting(true)
		try {
			await api.post(`/api/v1/content/${contentId}/revert/${version}`, {})
			onRevert()
			setSelected(null)
		} catch (err) {
			alert(err instanceof Error ? err.message : 'Revert failed')
		} finally {
			setReverting(false)
		}
	}

	if (loading) return <p className="text-zinc-500 text-xs">Loading versions...</p>
	if (versions.length === 0) return <p className="text-zinc-600 text-xs">No previous versions.</p>

	return (
		<div className="space-y-2">
			<h4 className="text-xs font-medium text-zinc-500 uppercase tracking-wide">
				Version History
			</h4>
			<div className="space-y-1 max-h-48 overflow-auto">
				{versions.map((v) => (
					<button
						type="button"
						key={v.id}
						onClick={() => setSelected(selected?.id === v.id ? null : v)}
						className={`w-full text-left px-3 py-2 rounded text-xs transition-colors ${
							selected?.id === v.id
								? 'bg-zinc-700 text-zinc-900'
								: 'bg-white text-zinc-400 hover:bg-zinc-100'
						}`}
					>
						<span className="font-mono">v{v.version}</span>
						<span className="text-zinc-600 ml-2">
							{new Date(v.createdAt).toLocaleString()}
						</span>
					</button>
				))}
			</div>

			{selected && (
				<div className="mt-3 space-y-2">
					<div className="bg-white rounded p-3 text-xs max-h-32 overflow-auto">
						<pre className="whitespace-pre-wrap text-zinc-400">
							{selected.markdown.slice(0, 500)}
							{selected.markdown.length > 500 ? '...' : ''}
						</pre>
					</div>
					<button
						type="button"
						onClick={() => revert(selected.version)}
						disabled={reverting}
						className="w-full px-3 py-1.5 bg-zinc-100 text-zinc-500 rounded text-xs hover:bg-zinc-800 disabled:opacity-50"
					>
						{reverting ? 'Reverting...' : `Revert to v${selected.version}`}
					</button>
				</div>
			)}
		</div>
	)
}
