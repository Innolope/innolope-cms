import { Link } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { api } from '../../lib/api-client'

interface AnalyticsData {
	topContent: { contentId: string | null; title: string; reads: number }[]
	topQueries: { query: string; total: number; hits: number; misses: number }[]
	bySource: { source: string; count: number }[]
}

export function AnalyticsPanel() {
	const { t } = useTranslation()
	const [data, setData] = useState<AnalyticsData | null>(null)
	const [loading, setLoading] = useState(true)

	useEffect(() => {
		api
			.get<AnalyticsData>('/api/v1/stats/analytics')
			.then(setData)
			.catch(() => {})
			.finally(() => setLoading(false))
	}, [])

	if (loading)
		return <p className="text-sm text-text-secondary">{t('settings.analytics.loading')}</p>
	if (!data)
		return <p className="text-sm text-text-secondary">{t('settings.analytics.unavailable')}</p>

	const totalReads = data.bySource.reduce((sum, s) => sum + s.count, 0)

	return (
		<div className="space-y-6">
			{/* Source breakdown */}
			<div>
				<h4 className="text-sm font-medium mb-2">{t('settings.analytics.readsBySource')}</h4>
				{totalReads === 0 ? (
					<p className="text-xs text-text-secondary">{t('settings.analytics.noReads')}</p>
				) : (
					<div className="flex gap-4">
						{data.bySource.map((s) => (
							<div key={s.source} className="text-center">
								<p className="text-2xl font-bold">{s.count}</p>
								<p className="text-xs text-text-secondary uppercase">{s.source}</p>
							</div>
						))}
						<div className="text-center">
							<p className="text-2xl font-bold">{totalReads}</p>
							<p className="text-xs text-text-secondary uppercase">
								{t('settings.analytics.total')}
							</p>
						</div>
					</div>
				)}
			</div>

			{/* Top content */}
			{data.topContent.length > 0 && (
				<div>
					<h4 className="text-sm font-medium mb-2">{t('settings.analytics.mostReadContent')}</h4>
					<div className="space-y-1">
						{data.topContent.slice(0, 10).map((item, i) => (
							<div key={item.contentId || i} className="flex items-center justify-between text-sm">
								<span className="truncate flex-1">
									{item.contentId ? (
										<Link
											to="/content/$id"
											params={{ id: item.contentId }}
											className="hover:text-text transition-colors"
										>
											{item.title}
										</Link>
									) : (
										<span className="text-text-muted">{item.title}</span>
									)}
								</span>
								<span className="text-text-secondary ml-3 tabular-nums">
									{t('settings.analytics.readsCount', { count: item.reads })}
								</span>
							</div>
						))}
					</div>
				</div>
			)}

			{/* Search queries */}
			{data.topQueries.length > 0 && (
				<div>
					<h4 className="text-sm font-medium mb-2">{t('settings.analytics.topSearchQueries')}</h4>
					<div className="space-y-1">
						{data.topQueries.slice(0, 10).map((q) => (
							<div key={q.query} className="flex items-center justify-between text-sm">
								<span className="font-mono text-xs truncate flex-1">{q.query}</span>
								<span className="text-text-secondary ml-3 text-xs tabular-nums">
									{t('settings.analytics.hitsMisses', { hits: q.hits, misses: q.misses })}
								</span>
							</div>
						))}
					</div>
				</div>
			)}

			{/* Content gaps */}
			{data.topQueries.filter((q) => q.misses > q.hits).length > 0 && (
				<div>
					<h4 className="text-sm font-medium mb-2">{t('settings.analytics.contentGaps')}</h4>
					<p className="text-xs text-text-secondary mb-2">
						{t('settings.analytics.contentGapsDesc')}
					</p>
					<div className="space-y-1">
						{data.topQueries
							.filter((q) => q.misses > q.hits)
							.slice(0, 5)
							.map((q) => (
								<div key={q.query} className="text-sm">
									<span className="font-mono text-xs">{q.query}</span>
									<span className="text-danger text-xs ml-2">
										{t('settings.analytics.missesCount', { count: q.misses })}
									</span>
								</div>
							))}
					</div>
				</div>
			)}
		</div>
	)
}
