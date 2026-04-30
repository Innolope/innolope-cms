import { createFileRoute, Link, useNavigate } from '@tanstack/react-router'
import { useState, useEffect, useRef } from 'react'
import { api } from '../lib/api-client'
import { AnalyticsPanel } from '../components/settings/analytics-panel'
import { DatabaseSettings } from '../components/settings/database-settings'
import { useToast } from '../lib/toast'

export const Route = createFileRoute('/dashboard')({
	component: Dashboard,
})

interface Stats {
	content: { total: number; published: number; draft: number }
	media: number
	apiKeys: number
	collections: number
	users: number
	members?: number
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

type StatId = 'total' | 'published' | 'draft' | 'media' | 'apiKeys' | 'collections' | 'members'

const ALL_STATS: { id: StatId; label: string; to: string }[] = [
	{ id: 'total', label: 'Total Content', to: '/collections' },
	{ id: 'published', label: 'Published', to: '/collections' },
	{ id: 'draft', label: 'Drafts', to: '/collections' },
	{ id: 'media', label: 'Media Files', to: '/media' },
	{ id: 'apiKeys', label: 'API Keys', to: '/settings' },
	{ id: 'collections', label: 'Collections', to: '/collections' },
	{ id: 'members', label: 'Members', to: '/settings' },
]

const DEFAULT_VISIBLE_STATS: StatId[] = ['total', 'published', 'draft', 'media', 'apiKeys']
const STATS_STORAGE_KEY = 'dashboard.visibleStats'
const MCP_HIDDEN_STORAGE_KEY = 'dashboard.mcpConfigHidden'

function loadVisibleStats(): StatId[] {
	try {
		const raw = localStorage.getItem(STATS_STORAGE_KEY)
		if (!raw) return DEFAULT_VISIBLE_STATS
		const parsed = JSON.parse(raw)
		const validIds = new Set(ALL_STATS.map((s) => s.id))
		if (Array.isArray(parsed)) {
			const filtered = parsed.filter((id: unknown): id is StatId => typeof id === 'string' && validIds.has(id as StatId))
			return filtered.length > 0 ? filtered : DEFAULT_VISIBLE_STATS
		}
	} catch {}
	return DEFAULT_VISIBLE_STATS
}


function Dashboard() {
	const navigate = useNavigate()
	const [stats, setStats] = useState<Stats | null>(null)
	const [recent, setRecent] = useState<RecentItem[]>([])
	const [ready, setReady] = useState(false)
	const [visibleStats, setVisibleStats] = useState<StatId[]>(loadVisibleStats)
	const [statsCustomizeOpen, setStatsCustomizeOpen] = useState(false)
	const [mcpConfigHidden, setMcpConfigHidden] = useState<boolean>(() => {
		try {
			return localStorage.getItem(MCP_HIDDEN_STORAGE_KEY) === 'true'
		} catch {
			return false
		}
	})

	useEffect(() => {
		try {
			localStorage.setItem(STATS_STORAGE_KEY, JSON.stringify(visibleStats))
		} catch {}
	}, [visibleStats])

	useEffect(() => {
		try {
			localStorage.setItem(MCP_HIDDEN_STORAGE_KEY, String(mcpConfigHidden))
		} catch {}
	}, [mcpConfigHidden])

	const toggleStat = (id: StatId) => {
		setVisibleStats((prev) => (prev.includes(id) ? prev.filter((s) => s !== id) : [...prev, id]))
	}

	const resetStats = () => setVisibleStats(DEFAULT_VISIBLE_STATS)

	const getStatValue = (id: StatId): number | string => {
		if (!stats) return '—'
		switch (id) {
			case 'total': return stats.content.total
			case 'published': return stats.content.published
			case 'draft': return stats.content.draft
			case 'media': return stats.media
			case 'apiKeys': return stats.apiKeys
			case 'collections': return stats.collections
			case 'members': return stats.members ?? '—'
		}
	}

	useEffect(() => {
		Promise.all([
			api.get<Stats>('/api/v1/stats').then(setStats).catch(() => {}),
			api.get<RecentItem[]>('/api/v1/stats/recent').then(setRecent).catch(() => {}),
		]).finally(() => setReady(true))
	}, [])

	const isEmpty = ready && stats && stats.content.total === 0 && stats.collections === 0
	const hasCollectionsOnly = ready && stats && stats.collections > 0 && stats.content.total === 0

	// Redirect to collections when they exist but no content yet (e.g., after external DB import)
	if (hasCollectionsOnly) {
		navigate({ to: '/collections' })
		return null
	}

	if (isEmpty) return <EmptyDashboard />
	if (!ready) return <div className="p-8 pt-5" />

	const visibleStatItems = visibleStats
		.map((id) => ALL_STATS.find((s) => s.id === id))
		.filter((s): s is (typeof ALL_STATS)[number] => Boolean(s))

	return (
		<div className="p-8 pt-5">
			<div className="flex items-center justify-between mb-6">
				<h2 className="text-2xl font-bold">Dashboard</h2>
				<button
					type="button"
					onClick={() => setStatsCustomizeOpen(true)}
					className="flex items-center gap-1.5 px-2.5 py-1.5 text-text-secondary hover:text-text hover:bg-surface-alt rounded transition-colors"
					title="Customize statistics"
				>
					<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
						<line x1="4" y1="21" x2="4" y2="14" />
						<line x1="4" y1="10" x2="4" y2="3" />
						<line x1="12" y1="21" x2="12" y2="12" />
						<line x1="12" y1="8" x2="12" y2="3" />
						<line x1="20" y1="21" x2="20" y2="16" />
						<line x1="20" y1="12" x2="20" y2="3" />
						<line x1="1" y1="14" x2="7" y2="14" />
						<line x1="9" y1="8" x2="15" y2="8" />
						<line x1="17" y1="16" x2="23" y2="16" />
					</svg>
					<span className="text-xs">Customize</span>
				</button>
			</div>

			{/* Stats grid */}
			{visibleStatItems.length > 0 && (
				<div
					className={`grid grid-cols-2 gap-3 mb-8 ${
						visibleStatItems.length >= 5
							? 'md:grid-cols-5'
							: visibleStatItems.length === 4
								? 'md:grid-cols-4'
								: visibleStatItems.length === 3
									? 'md:grid-cols-3'
									: 'md:grid-cols-2'
					}`}
				>
					{visibleStatItems.map((stat) => (
						<StatCard key={stat.id} label={stat.label} value={getStatValue(stat.id)} to={stat.to} />
					))}
				</div>
			)}

			{/* Analytics */}
			<div className="rounded-lg border border-border p-5 mb-6">
				<h3 className="text-sm font-semibold mb-3 text-text-muted uppercase tracking-wide">
					Content Analytics (30d)
				</h3>
				<AnalyticsPanel />
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

					{!mcpConfigHidden ? (
						<div className="mt-6 pt-4 border-t border-border">
							<div className="flex items-center justify-between mb-2">
								<h4 className="text-xs font-medium text-text-secondary">MCP Config</h4>
								<button
									type="button"
									onClick={() => setMcpConfigHidden(true)}
									className="w-5 h-5 flex items-center justify-center text-text-muted hover:text-text hover:bg-surface-alt rounded transition-colors"
									title="Hide MCP Config"
								>
									<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
										<line x1="18" y1="6" x2="6" y2="18" />
										<line x1="6" y1="6" x2="18" y2="18" />
									</svg>
								</button>
							</div>
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
					) : (
						<div className="mt-6 pt-4 border-t border-border">
							<button
								type="button"
								onClick={() => setMcpConfigHidden(false)}
								className="text-xs text-text-secondary hover:text-text transition-colors"
							>
								Show MCP Config
							</button>
						</div>
					)}
				</div>
			</div>

			{statsCustomizeOpen && (
				<StatsCustomizeModal
					visibleStats={visibleStats}
					onToggle={toggleStat}
					onReset={resetStats}
					onClose={() => setStatsCustomizeOpen(false)}
				/>
			)}
		</div>
	)
}

function StatsCustomizeModal({
	visibleStats,
	onToggle,
	onReset,
	onClose,
}: {
	visibleStats: StatId[]
	onToggle: (id: StatId) => void
	onReset: () => void
	onClose: () => void
}) {
	const visibleSet = new Set(visibleStats)
	return (
		<div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={onClose}>
			<div
				className="bg-surface border border-border rounded-xl shadow-2xl w-full max-w-md p-6"
				onClick={(e) => e.stopPropagation()}
			>
				<div className="flex items-center justify-between mb-2">
					<h3 className="font-semibold text-text">Customize Statistics</h3>
					<button
						type="button"
						onClick={onClose}
						className="w-6 h-6 flex items-center justify-center text-text-muted hover:text-text hover:bg-surface-alt rounded transition-colors"
						title="Close"
					>
						<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
							<line x1="18" y1="6" x2="6" y2="18" />
							<line x1="6" y1="6" x2="18" y2="18" />
						</svg>
					</button>
				</div>
				<p className="text-sm text-text-secondary mb-4">
					Select which data points to show on your dashboard.
				</p>
				<div className="space-y-1 mb-6 max-h-80 overflow-y-auto">
					{ALL_STATS.map((stat) => {
						const checked = visibleSet.has(stat.id)
						return (
							<label
								key={stat.id}
								className="flex items-center gap-3 px-3 py-2 rounded hover:bg-surface-alt cursor-pointer"
							>
								<input
									type="checkbox"
									checked={checked}
									onChange={() => onToggle(stat.id)}
									className="cursor-pointer"
								/>
								<span className={`flex-1 text-sm ${checked ? 'text-text' : 'text-text-secondary'}`}>
									{stat.label}
								</span>
							</label>
						)
					})}
				</div>
				<div className="flex items-center justify-between">
					<button
						type="button"
						onClick={onReset}
						className="text-xs text-text-secondary hover:text-text transition-colors"
					>
						Reset to default
					</button>
					<button
						type="button"
						onClick={onClose}
						className="px-4 py-2 bg-btn-primary text-btn-primary-text rounded-lg text-sm font-medium hover:bg-btn-primary-hover transition-colors"
					>
						Done
					</button>
				</div>
			</div>
		</div>
	)
}

function EmptyDashboard() {
	const navigate = useNavigate()
	const toast = useToast()
	const [step, setStepState] = useState<'choose' | 'connect-db' | 'upload'>(() => {
		const params = new URLSearchParams(window.location.search)
		return (params.get('step') as 'choose' | 'connect-db' | 'upload') || 'choose'
	})

	const setStep = (s: typeof step) => {
		setStepState(s)
		const url = new URL(window.location.href)
		if (s === 'choose') url.searchParams.delete('step')
		else url.searchParams.set('step', s)
		window.history.replaceState({}, '', url.toString())
	}
	const fileInputRef = useRef<HTMLInputElement>(null)

	const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
		const file = e.target.files?.[0]
		if (!file) return
		// TODO: implement import endpoint
		toast('File import is coming soon. For now, use the MCP server or API to bulk-create content.', 'error')
	}

	if (step === 'choose') {
		return (
			<div className="p-8 pt-[15vh] flex justify-center min-h-[70vh]">
				<div className="max-w-4xl w-full">
					<div className="text-center mb-10">
						<h2 className="text-2xl font-bold mb-2">Welcome to Innolope CMS</h2>
						<p className="text-text-secondary text-sm">How would you like to add your first content?</p>
					</div>

					<div className="grid grid-cols-1 md:grid-cols-3 gap-4">
						<button
							type="button"
							onClick={() => setStep('connect-db')}
							className="rounded-xl bg-zinc-800 dark:bg-zinc-700 p-8 text-left hover:bg-zinc-700 dark:hover:bg-zinc-600 active:translate-x-px active:translate-y-px transition-all group flex flex-col"
						>
							<div className="w-12 h-12 rounded-lg bg-white/10 flex items-center justify-center">
								<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="text-white">
									<ellipse cx="12" cy="5" rx="9" ry="3" />
									<path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3" />
									<path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5" />
								</svg>
							</div>
							<div className="mt-6">
								<h3 className="font-semibold text-white mb-1.5">Connect Database</h3>
								<p className="text-sm text-white/70">I already have content in an external database</p>
							</div>
						</button>

						<button
							type="button"
							onClick={() => setStep('upload')}
							className="rounded-xl bg-zinc-800 dark:bg-zinc-700 p-8 text-left hover:bg-zinc-700 dark:hover:bg-zinc-600 active:translate-x-px active:translate-y-px transition-all group flex flex-col"
						>
							<div className="w-12 h-12 rounded-lg bg-white/10 flex items-center justify-center">
								<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="text-white">
									<path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4" />
									<polyline points="17 8 12 3 7 8" />
									<line x1="12" y1="3" x2="12" y2="15" />
								</svg>
							</div>
							<div className="mt-6">
								<h3 className="font-semibold text-white mb-1.5">Upload Files</h3>
								<p className="text-sm text-white/70">I have content in Markdown or JSON files</p>
							</div>
						</button>

						<Link
							to="/collections/new"
							className="rounded-xl bg-zinc-800 dark:bg-zinc-700 p-8 text-left hover:bg-zinc-700 dark:hover:bg-zinc-600 active:translate-x-px active:translate-y-px transition-all group flex flex-col"
						>
							<div className="w-12 h-12 rounded-lg bg-white/10 flex items-center justify-center">
								<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="text-white">
									<line x1="12" y1="5" x2="12" y2="19" />
									<line x1="5" y1="12" x2="19" y2="12" />
								</svg>
							</div>
							<div className="mt-6">
								<h3 className="font-semibold text-white mb-1.5">Start from Scratch</h3>
								<p className="text-sm text-white/70">Create a new collection and add content</p>
							</div>
						</Link>
					</div>
				</div>
			</div>
		)
	}

	if (step === 'connect-db') {
		return (
			<div className="p-8 pt-6">
				<button
					type="button"
					onClick={() => setStep('choose')}
					className="flex items-center gap-1.5 text-sm text-text-secondary hover:text-text transition-colors mb-6"
				>
					<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="15 18 9 12 15 6" /></svg>
					Choose a different method
				</button>
				<div className="flex justify-center min-h-[70vh]">
				<div className="max-w-4xl w-full">
					<div className="text-center mb-10">
						<h2 className="text-2xl font-bold mb-2">Connect Database</h2>
						<p className="text-text-secondary text-sm">
							Connect an external database to import existing content.
						</p>
					</div>
					<DatabaseSettings onChangeDatabase={() => setStep('choose')} />
				</div>
				</div>
			</div>
		)
	}

	if (step === 'upload') {
		return (
			<div className="p-8 pt-6">
				<button
					type="button"
					onClick={() => setStep('choose')}
					className="flex items-center gap-1.5 text-sm text-text-secondary hover:text-text transition-colors mb-6"
				>
					<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="15 18 9 12 15 6" /></svg>
					Choose a different method
				</button>
				<div className="flex justify-center min-h-[70vh]">
					<div className="max-w-lg w-full">
						<div className="text-center mb-10">
							<h2 className="text-2xl font-bold mb-2">Upload Content</h2>
							<p className="text-text-secondary text-sm">
								Upload Markdown (.md) or JSON (.json) files to import content.
							</p>
						</div>
						<div className="flex gap-3 justify-center mb-8">
							<button
								type="button"
								onClick={() => fileInputRef.current?.click()}
								className="px-5 py-2.5 bg-btn-primary text-btn-primary-text rounded-lg text-sm font-medium hover:bg-btn-primary-hover active:translate-x-px active:translate-y-px transition-colors cursor-pointer"
							>
								Choose Files
							</button>
						</div>
						<div
							className="border-2 border-dashed border-border rounded-lg py-16 px-6 text-text-secondary text-sm hover:border-text-muted transition-colors flex flex-col items-center justify-center cursor-pointer"
							onClick={() => fileInputRef.current?.click()}
							onDragOver={(e) => {
								e.preventDefault()
								e.currentTarget.classList.add('border-text-secondary')
							}}
							onDragLeave={(e) => {
								e.currentTarget.classList.remove('border-text-secondary')
							}}
							onDrop={(e) => {
								e.preventDefault()
								e.currentTarget.classList.remove('border-text-secondary')
								if (e.dataTransfer.files.length) handleFileUpload({ target: { files: e.dataTransfer.files } } as React.ChangeEvent<HTMLInputElement>)
							}}
						>
							<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="text-text-muted mb-3">
								<path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4" />
								<polyline points="17 8 12 3 7 8" />
								<line x1="12" y1="3" x2="12" y2="15" />
							</svg>
							Drop .md, .json, or .jsonl files here or click to browse
						</div>
					</div>
				</div>
				<input
					ref={fileInputRef}
					type="file"
					accept=".md,.json,.jsonl"
					onChange={handleFileUpload}
					className="hidden"
					multiple
				/>
			</div>
		)
	}

	return null
}

function StatCard({ label, value, to }: { label: string; value: number | string; to: string }) {
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
