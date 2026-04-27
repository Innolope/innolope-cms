import { createFileRoute } from '@tanstack/react-router'
import { useState, useEffect, useCallback, useRef } from 'react'
import { api } from '../lib/api-client'
import { useAuth } from '../lib/auth'
import { useToast } from '../lib/toast'
import { AiSettingsPanel } from '../components/ai/ai-settings'
import { GeneralSettings } from '../components/settings/general-settings'
import { MediaSettings } from '../components/settings/media-settings'
import { DatabaseSettings } from '../components/settings/database-settings'
import { TeamSettings } from '../components/settings/team-settings'
import { WebhookSettings } from '../components/settings/webhook-settings'
import { SsoSettings } from '../components/settings/sso-settings'
import { LicenseGate, ProBadge, useLicense, hasFeature } from '../components/license-gate'
import { SaveBar } from '../components/save-bar'

export const Route = createFileRoute('/settings')({
	component: Settings,
})

interface ApiKeyItem {
	id: string
	name: string
	keyPrefix: string
	permissions: string[]
	createdAt: string
	lastUsedAt: string | null
}

interface NewKeyResponse extends ApiKeyItem {
	key: string
	warning: string
}

type SettingsTab = 'general' | 'team' | 'sso' | 'api-keys' | 'ai-models' | 'search' | 'webhooks' | 'media' | 'database'

const TABS: { id: SettingsTab; label: string; pro?: string; hideInCloud?: boolean }[] = [
	{ id: 'general', label: 'General' },
	{ id: 'team', label: 'Team' },
	{ id: 'sso', label: 'SSO', pro: 'sso' },
	{ id: 'database', label: 'Database' },
	{ id: 'api-keys', label: 'API Keys' },
	{ id: 'ai-models', label: 'AI Models' },
	{ id: 'search', label: 'Semantic Search', pro: 'ai-assistant' },
	{ id: 'webhooks', label: 'Webhooks', pro: 'webhooks' },
	{ id: 'media', label: 'Media', hideInCloud: true },
]

function Settings() {
	const license = useLicense()
	const [tab, setTabState] = useState<SettingsTab>(() => {
		const params = new URLSearchParams(window.location.search)
		return (params.get('tab') as SettingsTab) || 'general'
	})

	const setTab = (t: SettingsTab) => {
		setTabState(t)
		const url = new URL(window.location.href)
		url.searchParams.set('tab', t)
		window.history.replaceState({}, '', url.toString())
	}

	const visibleTabs = TABS.filter(t => !(t.hideInCloud && license.cloudMode))

	return (
		<div className="p-8 pt-5 relative min-h-full">
			<h2 className="text-2xl font-bold mb-6">Project Settings</h2>

			{/* Tabs */}
			<div className="flex border-b border-border mb-8">
				{visibleTabs.map((t) => (
					<button
						key={t.id}
						type="button"
						onClick={() => setTab(t.id)}
						className={`flex-1 px-6 py-3 text-sm font-medium -mb-px whitespace-nowrap transition-colors flex items-center justify-center ${
							tab === t.id
								? 'border-b-2 border-text text-text'
								: 'text-text-secondary hover:text-text'
						}`}
					>
						{t.label}
						{t.pro && !hasFeature(license, t.pro) && <ProBadge />}
					</button>
				))}
			</div>

			{/* Tab content — all mounted, inactive hidden to avoid reload flicker */}
			<div className={tab === 'general' ? '' : 'hidden'}><GeneralSettings /></div>
			<div className={tab === 'team' ? '' : 'hidden'}><TeamSettings /></div>
			<div className={tab === 'sso' ? '' : 'hidden'}>
				<LicenseGate feature="sso" featureLabel="Single Sign-On (SAML &amp; OIDC)">
					<SsoSettings />
				</LicenseGate>
			</div>
			<div className={tab === 'api-keys' ? '' : 'hidden'}><ApiKeysContent /></div>
			<div className={tab === 'ai-models' ? '' : 'hidden'}><AiSettingsPanel /></div>
			<div className={tab === 'search' ? '' : 'hidden'}>
				<LicenseGate feature="ai-assistant" featureLabel="Semantic Search">
					<EmbeddingSettings />
				</LicenseGate>
			</div>
			<div className={tab === 'webhooks' ? '' : 'hidden'}>
				<LicenseGate feature="webhooks" featureLabel="Webhooks">
					<WebhookSettings />
				</LicenseGate>
			</div>
			<div className={tab === 'media' ? '' : 'hidden'}><MediaSettings /></div>
			<div className={tab === 'database' ? '' : 'hidden'}><DatabaseSettings /></div>
		</div>
	)
}

function EmbeddingSettings() {
	const { currentProject, refreshProjects } = useAuth()
	const toast = useToast()
	const [autoEmbed, setAutoEmbed] = useState(false)
	const [status, setStatus] = useState<{ totalContent: number; embeddedContent: number } | null>(null)
	const [saving, setSaving] = useState(false)
	const [saved, setSaved] = useState(false)
	const initialAutoEmbed = useRef(false)

	useEffect(() => {
		if (currentProject) {
			const settings = currentProject.settings as Record<string, unknown> || {}
			const val = Boolean(settings.autoEmbed)
			setAutoEmbed(val)
			initialAutoEmbed.current = val
		}
		api.get<{ totalContent: number; embeddedContent: number }>('/api/v1/content/semantic-search/status')
			.then(setStatus)
			.catch(() => {})
	}, [currentProject])

	const dirty = autoEmbed !== initialAutoEmbed.current

	const save = async () => {
		if (!currentProject) return
		setSaving(true)
		try {
			await api.put(`/api/v1/projects/${currentProject.id}`, {
				settings: {
					...(currentProject.settings as Record<string, unknown>),
					autoEmbed,
				},
			})
			await refreshProjects()
			setSaved(true)
			setTimeout(() => setSaved(false), 2000)
		} catch (err) {
			toast(err instanceof Error ? err.message : 'Failed to save', 'error')
		} finally {
			setSaving(false)
		}
	}

	return (
		<div className="space-y-4">
			<p className="text-sm text-text-secondary">
				Semantic search uses vector embeddings to find content by meaning, not just keywords.
				Requires an OpenAI API key (configured in AI Models).
			</p>

			{status && (() => {
				const pct = status.totalContent > 0 ? Math.round((status.embeddedContent / status.totalContent) * 100) : 0
				return (
					<div className="rounded-lg bg-surface-alt p-4 space-y-3">
						<div className="flex items-center justify-between text-sm">
							<span className="text-text-secondary">Embedding coverage</span>
							<span className="font-semibold text-text">{status.embeddedContent} / {status.totalContent} items <span className="text-text-muted font-normal">({pct}%)</span></span>
						</div>
						<div className="h-2 rounded-full bg-border overflow-hidden">
							<div className="h-full rounded-full bg-btn-primary transition-all" style={{ width: `${pct}%` }} />
						</div>
						{pct === 100 && status.totalContent > 0 && (
							<p className="text-xs text-text-muted">All content is indexed for semantic search.</p>
						)}
						{pct < 100 && status.totalContent > 0 && (
							<p className="text-xs text-text-muted">{status.totalContent - status.embeddedContent} items not yet embedded. Enable auto-embed below or trigger manually via the API.</p>
						)}
					</div>
				)
			})()}

			<label className="flex items-center gap-2">
				<input
					type="checkbox"
					checked={autoEmbed}
					onChange={(e) => setAutoEmbed(e.target.checked)}
					className="rounded"
				/>
				<span className="text-sm">Auto-generate embeddings on content create/update</span>
			</label>

			<SaveBar dirty={dirty} saving={saving} saved={saved} onSave={save} onReset={() => setAutoEmbed(initialAutoEmbed.current)} />
		</div>
	)
}

function ApiKeysContent() {
	const toast = useToast()
	const [keys, setKeys] = useState<ApiKeyItem[]>([])
	const [loading, setLoading] = useState(true)
	const [showCreate, setShowCreate] = useState(false)
	const [newKeyName, setNewKeyName] = useState('')
	const [createdKey, setCreatedKey] = useState<string | null>(null)
	const [copied, setCopied] = useState(false)

	const fetchKeys = useCallback(async () => {
		try {
			const data = await api.get<ApiKeyItem[]>('/api/v1/auth/api-keys')
			setKeys(data)
		} catch {
			// Not authenticated or not admin
		} finally {
			setLoading(false)
		}
	}, [])

	useEffect(() => {
		fetchKeys()
	}, [fetchKeys])

	const createKey = async () => {
		if (!newKeyName.trim()) return
		try {
			const result = await api.post<NewKeyResponse>('/api/v1/auth/api-keys', {
				name: newKeyName,
				permissions: ['*'],
			})
			setCreatedKey(result.key)
			setNewKeyName('')
			setShowCreate(false)
			fetchKeys()
		} catch (err) {
			toast(err instanceof Error ? err.message : 'Failed to create key', 'error')
		}
	}

	const deleteKey = async (id: string) => {
		if (!confirm('Revoke this API key? This cannot be undone.')) return
		await api.delete(`/api/v1/auth/api-keys/${id}`)
		fetchKeys()
	}

	const copyKey = () => {
		if (createdKey) {
			navigator.clipboard.writeText(createdKey)
			setCopied(true)
			setTimeout(() => setCopied(false), 2000)
		}
	}

	return (
		<div>
			<div className="flex items-center justify-between mb-4">
				<p className="text-text-secondary text-sm">
					Generate keys for AI agents and external integrations
				</p>
				<button
					type="button"
					onClick={() => setShowCreate(true)}
					className="px-3 py-1.5 bg-btn-primary text-btn-primary-text rounded text-sm font-medium hover:bg-btn-primary-hover transition-colors"
				>
					Create API Key
				</button>
			</div>

			{createdKey && (
				<div className="mb-4 p-4 rounded-lg bg-surface-alt border border-border">
					<p className="text-sm font-medium text-text-secondary mb-2">
						Save this key now. It will not be shown again.
					</p>
					<div className="flex items-center gap-2">
						<code className="flex-1 text-sm bg-surface px-3 py-2 rounded font-mono break-all border border-border">
							{createdKey}
						</code>
						<button
							type="button"
							onClick={copyKey}
							className="px-3 py-2 bg-btn-secondary text-text-secondary rounded text-sm hover:bg-btn-secondary-hover"
						>
							{copied ? 'Copied' : 'Copy'}
						</button>
					</div>
					<details className="mt-3">
						<summary className="text-xs text-text-secondary cursor-pointer">
							Claude Desktop config
						</summary>
						<pre className="mt-2 text-xs bg-surface p-3 rounded overflow-x-auto border border-border">
							{JSON.stringify(
								{
									mcpServers: {
										innolope: {
											command: 'npx',
											args: ['@innolope/mcp-server'],
											env: {
												INNOLOPE_API_URL: window.location.origin,
												INNOLOPE_API_KEY: createdKey,
											},
										},
									},
								},
								null,
								2,
							)}
						</pre>
					</details>
					<button
						type="button"
						onClick={() => setCreatedKey(null)}
						className="mt-3 text-xs text-text-secondary hover:text-text"
					>
						Dismiss
					</button>
				</div>
			)}

			{showCreate && (
				<div className="mb-4 p-4 rounded-lg bg-surface border border-border-strong">
					<label className="block text-sm mb-2">Key name</label>
					<div className="flex gap-2">
						<input
							type="text"
							value={newKeyName}
							onChange={(e) => setNewKeyName(e.target.value)}
							onKeyDown={(e) => e.key === 'Enter' && createKey()}
							placeholder="e.g. Claude Agent, CI Pipeline"
							className="flex-1 px-3 py-2 bg-input border border-border-strong rounded text-sm focus:outline-none focus:border-border-strong"
							autoFocus
						/>
						<button
							type="button"
							onClick={createKey}
							className="px-4 py-2 bg-btn-primary text-btn-primary-text rounded text-sm font-medium hover:bg-btn-primary-hover"
						>
							Generate API Key
						</button>
						<button
							type="button"
							onClick={() => setShowCreate(false)}
							className="px-4 py-2 bg-btn-secondary rounded text-sm hover:bg-btn-secondary-hover"
						>
							Dismiss
						</button>
					</div>
				</div>
			)}

			{loading ? (
				<p className="text-text-secondary text-sm">Loading...</p>
			) : keys.length === 0 && !showCreate && !createdKey ? (
				<div className="flex flex-col items-center justify-center py-16 text-center">
					<div className="w-14 h-14 rounded-2xl bg-surface-alt flex items-center justify-center mb-4">
						<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="text-text-muted">
							<path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 11-7.778 7.778 5.5 5.5 0 017.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4" />
						</svg>
					</div>
					<h3 className="font-semibold text-text mb-1">No API keys yet</h3>
					<p className="text-sm text-text-secondary max-w-xs mb-5">
						API keys let Claude, AI agents, and external services access your content via the REST API and MCP server.
					</p>
					<button
						type="button"
						onClick={() => setShowCreate(true)}
						className="px-4 py-2 bg-btn-primary text-btn-primary-text rounded-lg text-sm font-medium hover:bg-btn-primary-hover transition-colors"
					>
						Create Your First API Key
					</button>
				</div>
			) : keys.length === 0 ? null : (
				<table className="w-full text-sm">
					<thead>
						<tr className="text-left text-text-secondary border-b border-border">
							<th className="pb-2 font-medium">Name</th>
							<th className="pb-2 font-medium">Key</th>
							<th className="pb-2 font-medium">Created</th>
							<th className="pb-2 font-medium">Last Used</th>
							<th className="pb-2 font-medium" />
						</tr>
					</thead>
					<tbody>
						{keys.map((k) => (
							<tr key={k.id} className="border-b border-border">
								<td className="py-3">{k.name}</td>
								<td className="py-3 font-mono text-text-secondary">{k.keyPrefix}...</td>
								<td className="py-3 text-text-secondary">
									{new Date(k.createdAt).toLocaleDateString()}
								</td>
								<td className="py-3 text-text-secondary">
									{k.lastUsedAt ? new Date(k.lastUsedAt).toLocaleDateString() : 'Never'}
								</td>
								<td className="py-3 text-right">
									<button
										type="button"
										onClick={() => deleteKey(k.id)}
										className="text-danger hover:opacity-80 text-xs"
									>
										Revoke
									</button>
								</td>
							</tr>
						))}
					</tbody>
				</table>
			)}
		</div>
	)
}

