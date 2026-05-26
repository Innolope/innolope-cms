import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { api } from '../../lib/api-client'
import { useConfirm } from '../../lib/confirm'
import { useToast } from '../../lib/toast'

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
	const { t } = useTranslation()
	const toast = useToast()
	const confirm = useConfirm()
	const [versions, setVersions] = useState<Version[]>([])
	const [loading, setLoading] = useState(true)
	const [selected, setSelected] = useState<Version | null>(null)
	const [reverting, setReverting] = useState(false)

	// biome-ignore lint/correctness/useExhaustiveDependencies: currentVersion intentionally triggers a refetch after a revert creates a new version.
	useEffect(() => {
		api
			.get<Version[]>(`/api/v1/content/${contentId}/versions`)
			.then(setVersions)
			.catch(() => {})
			.finally(() => setLoading(false))
	}, [contentId, currentVersion])

	const revert = async (version: number) => {
		const ok = await confirm({
			title: t('versions.revertTitle'),
			message: t('versions.revertMessage', { version }),
			confirmLabel: t('versions.revert'),
		})
		if (!ok) return
		setReverting(true)
		try {
			await api.post(`/api/v1/content/${contentId}/revert/${version}`, {})
			onRevert()
			setSelected(null)
		} catch (err) {
			toast(err instanceof Error ? err.message : t('versions.revertFailed'), 'error')
		} finally {
			setReverting(false)
		}
	}

	if (loading) return <p className="text-text-secondary text-xs">{t('versions.loading')}</p>
	if (versions.length === 0)
		return <p className="text-text-secondary text-xs">{t('versions.noPrevious')}</p>

	return (
		<div className="space-y-2">
			<h4 className="text-xs font-medium text-text-secondary uppercase tracking-wide">
				{t('versions.history')}
			</h4>
			<div className="space-y-1 max-h-48 overflow-auto">
				{versions.map((v) => (
					<button
						type="button"
						key={v.id}
						onClick={() => setSelected(selected?.id === v.id ? null : v)}
						className={`w-full text-left px-3 py-2 rounded text-xs transition-colors ${
							selected?.id === v.id
								? 'bg-btn-primary text-btn-primary-text'
								: 'bg-surface text-text-muted hover:bg-surface-alt'
						}`}
					>
						<span className="font-mono">v{v.version}</span>
						<span className="text-text-secondary ml-2">
							{new Date(v.createdAt).toLocaleString()}
						</span>
					</button>
				))}
			</div>

			{selected && (
				<div className="mt-3 space-y-2">
					<div className="bg-surface rounded p-3 text-xs max-h-32 overflow-auto border border-border">
						<pre className="whitespace-pre-wrap text-text-muted">
							{selected.markdown.slice(0, 500)}
							{selected.markdown.length > 500 ? '...' : ''}
						</pre>
					</div>
					<button
						type="button"
						onClick={() => revert(selected.version)}
						disabled={reverting}
						className="w-full px-3 py-1.5 bg-btn-secondary text-text-secondary rounded text-xs hover:bg-btn-secondary-hover disabled:opacity-50"
					>
						{reverting
							? t('versions.reverting')
							: t('versions.revertToVersion', { version: selected.version })}
					</button>
				</div>
			)}
		</div>
	)
}
