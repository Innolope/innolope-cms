import { createFileRoute } from '@tanstack/react-router'
import { useState, useEffect, useCallback } from 'react'
import { api } from '../lib/api-client'
import { useTheme } from '../lib/theme'
import { AiSettingsPanel } from '../components/ai/ai-settings'
import { GeneralSettings } from '../components/settings/general-settings'
import { MediaSettings } from '../components/settings/media-settings'
import { DatabaseSettings } from '../components/settings/database-settings'
import { TeamSettings } from '../components/settings/team-settings'

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

function Settings() {
	return (
		<div className="p-8 max-w-4xl">
			<h2 className="text-2xl font-bold mb-8">Settings</h2>
			<div className="space-y-8">
				<Section title="Appearance">
					<AppearanceSettings />
				</Section>
				<Section title="Team">
					<TeamSettings />
				</Section>
				<ApiKeysSection />
				<Section title="AI Models">
					<AiSettingsPanel />
				</Section>
				<Section title="General">
					<GeneralSettings />
				</Section>
				<Section title="Media">
					<MediaSettings />
				</Section>
				<Section title="Database">
					<DatabaseSettings />
				</Section>
			</div>
		</div>
	)
}

function AppearanceSettings() {
	const { theme, setTheme } = useTheme()

	return (
		<div className="space-y-3">
			<label className="block text-xs text-text-secondary mb-1.5">Theme</label>
			<div className="flex gap-2">
				<button
					type="button"
					onClick={() => setTheme('light')}
					className={`px-4 py-2 rounded text-sm font-medium transition-colors ${
						theme === 'light'
							? 'bg-btn-primary text-btn-primary-text'
							: 'bg-btn-secondary text-text-secondary hover:bg-btn-secondary-hover'
					}`}
				>
					Light
				</button>
				<button
					type="button"
					onClick={() => setTheme('dark')}
					className={`px-4 py-2 rounded text-sm font-medium transition-colors ${
						theme === 'dark'
							? 'bg-btn-primary text-btn-primary-text'
							: 'bg-btn-secondary text-text-secondary hover:bg-btn-secondary-hover'
					}`}
				>
					Dark
				</button>
			</div>
		</div>
	)
}

function ApiKeysSection() {
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
			alert(err instanceof Error ? err.message : 'Failed to create key')
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
		<div className="rounded-lg border border-border p-6">
			<div className="flex items-center justify-between mb-4">
				<div>
					<h3 className="text-lg font-semibold">API Keys</h3>
					<p className="text-text-secondary text-sm mt-1">
						Generate keys for AI agents and external integrations
					</p>
				</div>
				<button
					type="button"
					onClick={() => setShowCreate(true)}
					className="px-3 py-1.5 bg-btn-primary text-btn-primary-text rounded text-sm font-medium hover:bg-btn-primary-hover transition-colors"
				>
					Create Key
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
							Create
						</button>
						<button
							type="button"
							onClick={() => setShowCreate(false)}
							className="px-4 py-2 bg-btn-secondary rounded text-sm hover:bg-btn-secondary-hover"
						>
							Cancel
						</button>
					</div>
				</div>
			)}

			{loading ? (
				<p className="text-text-secondary text-sm">Loading...</p>
			) : keys.length === 0 ? (
				<p className="text-text-secondary text-sm">No API keys yet.</p>
			) : (
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

function Section({ title, children }: { title: string; children: React.ReactNode }) {
	return (
		<div className="rounded-lg border border-border p-6">
			<h3 className="text-lg font-semibold mb-2">{title}</h3>
			{children}
		</div>
	)
}
