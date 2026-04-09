import { createFileRoute, Link } from '@tanstack/react-router'
import { useState, useEffect } from 'react'
import { api } from '../lib/api-client'

export const Route = createFileRoute('/dashboard')({
	component: Dashboard,
})

interface Stats {
	content: { total: number; published: number; draft: number }
	media: number
	apiKeys: number
	collections: number
	users: number
}

interface RecentItem {
	id: string
	slug: string
	status: string
	metadata: Record<string, unknown>
	version: number
	updatedAt: string
	locale: string
}

function Dashboard() {
	const [stats, setStats] = useState<Stats | null>(null)
	const [recent, setRecent] = useState<RecentItem[]>([])

	useEffect(() => {
		api.get<Stats>('/api/v1/stats').then(setStats).catch(() => {})
		api.get<RecentItem[]>('/api/v1/stats/recent').then(setRecent).catch(() => {})
	}, [])

	return (
		<div className="p-8">
			<h2 className="text-2xl font-bold mb-6">Dashboard</h2>

			{/* Stats grid */}
			<div className="grid grid-cols-2 md:grid-cols-5 gap-3 mb-8">
				<StatCard label="Total Content" value={stats?.content.total ?? '—'} to="/content" />
				<StatCard
					label="Published"
					value={stats?.content.published ?? '—'}
					to="/content"
				/>
				<StatCard
					label="Drafts"
					value={stats?.content.draft ?? '—'}
					to="/content"
				/>
				<StatCard label="Media Files" value={stats?.media ?? '—'} to="/media" />
				<StatCard label="API Keys" value={stats?.apiKeys ?? '—'} to="/settings" />
			</div>

			<div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
				{/* Recent activity */}
				<div className="rounded-lg border border-border p-5">
					<h3 className="text-sm font-semibold mb-3 text-text-muted uppercase tracking-wide">
						Recent Activity
					</h3>
					{recent.length === 0 ? (
						<p className="text-text-secondary text-sm">No activity yet.</p>
					) : (
						<div className="space-y-2">
							{recent.slice(0, 10).map((item) => (
								<Link
									key={item.id}
									to="/content/$id"
									params={{ id: item.id }}
									className="flex items-center justify-between py-2 px-3 rounded hover:bg-surface transition-colors"
								>
									<div className="flex-1 min-w-0">
										<p className="text-sm truncate">
											{(item.metadata?.title as string) || item.slug}
										</p>
										<p className="text-xs text-text-secondary">
											v{item.version} — {item.locale}
										</p>
									</div>
									<div className="flex items-center gap-2 ml-3">
										<StatusBadge status={item.status} />
										<span className="text-xs text-text-secondary">
											{timeAgo(item.updatedAt)}
										</span>
									</div>
								</Link>
							))}
						</div>
					)}
				</div>

				{/* Quick start */}
				<div className="rounded-lg border border-border p-5">
					<h3 className="text-sm font-semibold mb-3 text-text-muted uppercase tracking-wide">
						Quick Start
					</h3>
					<div className="space-y-3 text-sm text-text-muted">
						<Step n={1}>
							<Link to="/collections" className="text-text hover:underline">
								Create a collection
							</Link>{' '}
							to define your content types
						</Step>
						<Step n={2}>
							<Link to="/settings" className="text-text hover:underline">
								Generate an API key
							</Link>{' '}
							for Claude or other AI agents
						</Step>
						<Step n={3}>
							<Link to="/content/$id" params={{ id: 'new' }} className="text-text hover:underline">
								Create content
							</Link>{' '}
							manually or via MCP
						</Step>
						<Step n={4}>
							Consume via REST API at{' '}
							<code className="text-text-faint bg-surface-alt px-1 rounded text-xs">
								/api/v1/content
							</code>
						</Step>
						<Step n={5}>
							Or use the SDK:{' '}
							<code className="text-text-faint bg-surface-alt px-1 rounded text-xs">
								npm i @innolope/sdk
							</code>
						</Step>
					</div>

					<div className="mt-6 pt-4 border-t border-border">
						<h4 className="text-xs font-medium text-text-secondary mb-2">MCP Config</h4>
						<pre className="text-xs bg-surface p-3 rounded overflow-x-auto text-text-secondary border border-border">
{`{
  "mcpServers": {
    "innolope": {
      "command": "npx",
      "args": ["@innolope/mcp-server"],
      "env": {
        "INNOLOPE_API_URL": "${typeof window !== 'undefined' ? window.location.origin : 'http://localhost:3001'}",
        "INNOLOPE_API_KEY": "ink_..."
      }
    }
  }
}`}
						</pre>
					</div>
				</div>
			</div>
		</div>
	)
}

function StatCard({
	label,
	value,
	to,
}: {
	label: string
	value: number | string
	to: string
}) {
	return (
		<Link
			to={to}
			className="rounded-lg border border-border p-4 hover:border-text-muted transition-colors"
		>
			<p className="text-xs text-text-secondary">{label}</p>
			<p className="text-2xl font-bold mt-1 text-text">{value}</p>
		</Link>
	)
}

function StatusBadge({ status }: { status: string }) {
	const styles: Record<string, string> = {
		draft: 'bg-surface-alt text-text-secondary',
		published: 'bg-surface-alt text-text',
		archived: 'bg-surface-alt text-text-muted',
	}
	return (
		<span className={`px-1.5 py-0.5 rounded text-[10px] ${styles[status] || ''}`}>
			{status}
		</span>
	)
}

function Step({ n, children }: { n: number; children: React.ReactNode }) {
	return (
		<div className="flex items-start gap-3">
			<span className="text-text-secondary font-mono text-xs mt-0.5">{n}.</span>
			<span>{children}</span>
		</div>
	)
}

function timeAgo(dateStr: string): string {
	const seconds = Math.floor((Date.now() - new Date(dateStr).getTime()) / 1000)
	if (seconds < 60) return 'just now'
	const minutes = Math.floor(seconds / 60)
	if (minutes < 60) return `${minutes}m ago`
	const hours = Math.floor(minutes / 60)
	if (hours < 24) return `${hours}h ago`
	const days = Math.floor(hours / 24)
	return `${days}d ago`
}
