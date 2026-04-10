import { createFileRoute, Link, useNavigate } from '@tanstack/react-router'
import { useState, useEffect, useRef } from 'react'
import { api } from '../lib/api-client'
import { AnalyticsPanel } from '../components/settings/analytics-panel'
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

const COLLECTION_TEMPLATES = [
	{ name: 'Knowledge Base', slug: 'knowledge-base', description: 'Structured articles for AI agent retrieval and customer self-service', fields: [
		{ name: 'title', type: 'text', required: true, localized: true },
		{ name: 'category', type: 'enum', options: ['general', 'technical', 'onboarding', 'troubleshooting'] },
		{ name: 'tags', type: 'array' },
		{ name: 'summary', type: 'text', localized: true },
		{ name: 'difficulty', type: 'enum', options: ['beginner', 'intermediate', 'advanced'] },
		{ name: 'relatedArticles', type: 'relation' },
	]},
	{ name: 'FAQ', slug: 'faq', description: 'Question-answer pairs optimized for AI-powered support agents', fields: [
		{ name: 'question', type: 'text', required: true, localized: true },
		{ name: 'answer', type: 'text', required: true, localized: true },
		{ name: 'category', type: 'enum', options: ['general', 'billing', 'technical', 'account'] },
		{ name: 'order', type: 'number' },
		{ name: 'helpful', type: 'number' },
	]},
	{ name: 'Product Catalog', slug: 'product-catalog', description: 'Structured product data for AI-driven recommendations and search', fields: [
		{ name: 'title', type: 'text', required: true, localized: true },
		{ name: 'price', type: 'number', required: true },
		{ name: 'currency', type: 'enum', options: ['USD', 'EUR', 'GBP'] },
		{ name: 'sku', type: 'text', required: true },
		{ name: 'category', type: 'enum', options: ['software', 'hardware', 'service', 'subscription'] },
		{ name: 'inStock', type: 'boolean' },
		{ name: 'specs', type: 'object' },
		{ name: 'images', type: 'relation' },
	]},
	{ name: 'Documentation', slug: 'documentation', description: 'Technical docs with section ordering for developer-facing AI assistants', fields: [
		{ name: 'title', type: 'text', required: true, localized: true },
		{ name: 'section', type: 'text', required: true },
		{ name: 'order', type: 'number' },
		{ name: 'tags', type: 'array' },
		{ name: 'codeExamples', type: 'array' },
		{ name: 'deprecated', type: 'boolean' },
		{ name: 'relatedDocs', type: 'relation' },
	]},
	{ name: 'Changelog', slug: 'changelog', description: 'Version history and release notes for product updates', fields: [
		{ name: 'title', type: 'text', required: true },
		{ name: 'version', type: 'text', required: true },
		{ name: 'date', type: 'date', required: true },
		{ name: 'type', type: 'enum', required: true, options: ['feature', 'fix', 'improvement', 'breaking'] },
		{ name: 'breaking', type: 'boolean' },
	]},
	{ name: 'API Reference', slug: 'api-reference', description: 'Endpoint documentation for API-aware AI agents and developer tools', fields: [
		{ name: 'title', type: 'text', required: true },
		{ name: 'method', type: 'enum', required: true, options: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'] },
		{ name: 'endpoint', type: 'text', required: true },
		{ name: 'parameters', type: 'object' },
		{ name: 'responseSchema', type: 'object' },
		{ name: 'authenticated', type: 'boolean' },
		{ name: 'rateLimit', type: 'number' },
		{ name: 'deprecated', type: 'boolean' },
	]},
	{ name: 'CRM', slug: 'crm', description: 'Customer contacts and deals for AI-assisted sales workflows', fields: [
		{ name: 'name', type: 'text', required: true },
		{ name: 'email', type: 'text', required: true },
		{ name: 'company', type: 'text' },
		{ name: 'stage', type: 'enum', required: true, options: ['lead', 'qualified', 'proposal', 'negotiation', 'closed-won', 'closed-lost'] },
		{ name: 'dealValue', type: 'number' },
		{ name: 'lastContact', type: 'date' },
		{ name: 'notes', type: 'array' },
	]},
	{ name: 'Blog', slug: 'blog', description: 'Articles and posts with SEO metadata for content marketing', fields: [
		{ name: 'title', type: 'text', required: true, localized: true },
		{ name: 'excerpt', type: 'text', localized: true },
		{ name: 'author', type: 'text', required: true },
		{ name: 'publishDate', type: 'date' },
		{ name: 'category', type: 'enum', options: ['engineering', 'product', 'company', 'tutorial'] },
		{ name: 'tags', type: 'array' },
		{ name: 'featuredImage', type: 'relation' },
		{ name: 'seoDescription', type: 'text', localized: true },
	]},
	{ name: 'Job Board', slug: 'job-board', description: 'Open positions with structured requirements for recruiting agents', fields: [
		{ name: 'title', type: 'text', required: true },
		{ name: 'department', type: 'enum', required: true, options: ['engineering', 'design', 'product', 'marketing', 'sales', 'operations'] },
		{ name: 'location', type: 'text', required: true },
		{ name: 'remote', type: 'boolean' },
		{ name: 'salaryMin', type: 'number' },
		{ name: 'salaryMax', type: 'number' },
		{ name: 'requirements', type: 'array' },
	]},
]

function Dashboard() {
	const [stats, setStats] = useState<Stats | null>(null)
	const [recent, setRecent] = useState<RecentItem[]>([])
	const [ready, setReady] = useState(false)

	useEffect(() => {
		Promise.all([
			api.get<Stats>('/api/v1/stats').then(setStats).catch(() => {}),
			api.get<RecentItem[]>('/api/v1/stats/recent').then(setRecent).catch(() => {}),
		]).finally(() => setReady(true))
	}, [])

	const isEmpty = ready && stats && stats.content.total === 0 && stats.collections === 0

	if (isEmpty) return <EmptyDashboard />
	if (!ready) return <div className="p-8 pt-5" />

	return (
		<div className="p-8 pt-5">
			<h2 className="text-2xl font-bold mb-6">Dashboard</h2>

			{/* Stats grid */}
			<div className="grid grid-cols-2 md:grid-cols-5 gap-3 mb-8">
				<StatCard label="Total Content" value={stats?.content.total ?? '—'} to="/content" />
				<StatCard label="Published" value={stats?.content.published ?? '—'} to="/content" />
				<StatCard label="Drafts" value={stats?.content.draft ?? '—'} to="/content" />
				<StatCard label="Media Files" value={stats?.media ?? '—'} to="/media" />
				<StatCard label="API Keys" value={stats?.apiKeys ?? '—'} to="/settings" />
			</div>

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

function EmptyDashboard() {
	const navigate = useNavigate()
	const toast = useToast()
	const [step, setStep] = useState<'choose' | 'connect-db' | 'upload' | 'scratch'>('choose')
	const [scratchStep, setScratchStep] = useState<'choose' | 'template'>('choose')
	const [creating, setCreating] = useState(false)
	const fileInputRef = useRef<HTMLInputElement>(null)

	const createFromTemplate = async (template: typeof COLLECTION_TEMPLATES[0]) => {
		setCreating(true)
		try {
			await api.post('/api/v1/collections', {
				name: template.name,
				slug: template.slug,
				description: template.description,
				fields: template.fields,
			})
			navigate({ to: '/content/$id', params: { id: 'new' } })
		} catch (err) {
			toast(err instanceof Error ? err.message : 'Failed to create collection', 'error')
		} finally {
			setCreating(false)
		}
	}

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

						<button
							type="button"
							onClick={() => setStep('scratch')}
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
						</button>
					</div>
				</div>
			</div>
		)
	}

	if (step === 'connect-db') {
		return (
			<div className="p-8 pt-[15vh] flex justify-center min-h-[70vh]">
				<div className="max-w-md w-full">
					<div className="text-center mb-10">
						<h2 className="text-2xl font-bold mb-2">Connect Database</h2>
						<p className="text-text-secondary text-sm">
							Configure your external database connection in Project Settings to sync content.
						</p>
					</div>
					<div className="flex gap-3 justify-center">
						<button
							type="button"
							onClick={() => setStep('choose')}
							className="px-4 py-2 bg-btn-secondary text-text-secondary rounded text-sm hover:bg-btn-secondary-hover active:translate-x-px active:translate-y-px"
						>
							Back
						</button>
						<Link
							to="/settings"
							className="px-4 py-2 bg-btn-primary text-btn-primary-text rounded text-sm font-medium hover:bg-btn-primary-hover active:translate-x-px active:translate-y-px"
						>
							Go to Settings
						</Link>
					</div>
				</div>
			</div>
		)
	}

	if (step === 'upload') {
		return (
			<div className="p-8 pt-[15vh] flex justify-center min-h-[70vh]">
				<div className="max-w-md w-full">
					<div className="text-center mb-10">
						<h2 className="text-2xl font-bold mb-2">Upload Content</h2>
						<p className="text-text-secondary text-sm">
							Upload Markdown (.md) or JSON (.json) files to import content.
						</p>
					</div>
					<input
						ref={fileInputRef}
						type="file"
						accept=".md,.json,.jsonl"
						onChange={handleFileUpload}
						className="hidden"
					/>
					<div className="flex gap-3 justify-center">
						<button
							type="button"
							onClick={() => setStep('choose')}
							className="px-4 py-2 bg-btn-secondary text-text-secondary rounded text-sm hover:bg-btn-secondary-hover active:translate-x-px active:translate-y-px"
						>
							Back
						</button>
						<button
							type="button"
							onClick={() => fileInputRef.current?.click()}
							className="px-4 py-2 bg-btn-primary text-btn-primary-text rounded text-sm font-medium hover:bg-btn-primary-hover active:translate-x-px active:translate-y-px"
						>
							Choose File
						</button>
					</div>
				</div>
			</div>
		)
	}

	// step === 'scratch'
	if (scratchStep === 'choose') {
		return (
			<div className="p-8 pt-[15vh] flex justify-center min-h-[70vh]">
				<div className="max-w-4xl w-full">
					<div className="text-center mb-10">
						<h2 className="text-2xl font-bold mb-2">Start from Scratch</h2>
						<p className="text-text-secondary text-sm">Pick a template or create a custom collection.</p>
					</div>

					<div className="grid grid-cols-1 md:grid-cols-2 gap-4 max-w-[600px] mx-auto">
						<button
							type="button"
							onClick={() => setScratchStep('template')}
							className="rounded-xl bg-zinc-800 dark:bg-zinc-700 p-8 text-left hover:bg-zinc-700 dark:hover:bg-zinc-600 active:translate-x-px active:translate-y-px transition-all flex flex-col"
						>
							<div className="w-12 h-12 rounded-lg bg-white/10 flex items-center justify-center">
								<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="text-white">
									<rect x="3" y="3" width="7" height="7" rx="1" />
									<rect x="14" y="3" width="7" height="7" rx="1" />
									<rect x="3" y="14" width="7" height="7" rx="1" />
									<rect x="14" y="14" width="7" height="7" rx="1" />
								</svg>
							</div>
							<div className="mt-6">
								<h3 className="font-semibold text-white mb-1.5">Choose a Template</h3>
								<p className="text-sm text-white/70">Pre-built schemas for common content types</p>
							</div>
						</button>

						<Link
							to="/collections/$id"
							params={{ id: 'new' }}
							className="rounded-xl bg-zinc-800 dark:bg-zinc-700 p-8 text-left hover:bg-zinc-700 dark:hover:bg-zinc-600 active:translate-x-px active:translate-y-px transition-all flex flex-col"
						>
							<div className="w-12 h-12 rounded-lg bg-white/10 flex items-center justify-center">
								<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="text-white">
									<path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7" />
									<path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z" />
								</svg>
							</div>
							<div className="mt-6">
								<h3 className="font-semibold text-white mb-1.5">Create Custom</h3>
								<p className="text-sm text-white/70">Define your own collection schema from scratch</p>
							</div>
						</Link>
					</div>

					<div className="text-center mt-12">
						<button
							type="button"
							onClick={() => { setStep('choose'); setScratchStep('choose') }}
							className="text-sm text-text-muted hover:text-text-secondary inline-flex items-center gap-1.5"
						>
							<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M19 12H5" /><polyline points="12 19 5 12 12 5" /></svg>
							Back
						</button>
					</div>
				</div>
			</div>
		)
	}

	// scratchStep === 'template'
	return (
		<div className="p-8 pt-[15vh] flex justify-center min-h-[70vh]">
			<div className="max-w-4xl w-full">
				<div className="text-center mb-10">
					<h2 className="text-2xl font-bold mb-2">Choose a Template</h2>
					<p className="text-text-secondary text-sm">Select a pre-built collection schema to get started quickly.</p>
				</div>

				<div className="grid grid-cols-1 md:grid-cols-3 gap-4">
					{COLLECTION_TEMPLATES.map((t) => (
						<button
							type="button"
							key={t.slug}
							onClick={() => createFromTemplate(t)}
							disabled={creating}
							className="rounded-xl bg-zinc-800 dark:bg-zinc-700 p-6 text-left hover:bg-zinc-700 dark:hover:bg-zinc-600 active:translate-x-px active:translate-y-px transition-all disabled:opacity-50 flex flex-col"
						>
							<h3 className="font-semibold text-white mb-1">{t.name}</h3>
							<p className="text-xs text-white/70">{t.description}</p>
							<div className="bg-white/10 rounded-lg p-3 space-y-1 w-full mt-3">
								{t.fields.map((f) => (
									<div key={f.name} className="flex items-center justify-between text-xs font-mono">
										<span className="text-white">{f.name}{f.required ? <span className="text-white/40 ml-0.5">*</span> : ''}</span>
										<span className="text-white/50">{f.type}</span>
									</div>
								))}
							</div>
						</button>
					))}
				</div>

				<div className="text-center mt-12">
					<button
						type="button"
						onClick={() => setScratchStep('choose')}
						className="text-sm text-text-muted hover:text-text-secondary inline-flex items-center gap-1.5"
					>
						<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M19 12H5" /><polyline points="12 19 5 12 12 5" /></svg>
						Back
					</button>
				</div>
			</div>
		</div>
	)
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
