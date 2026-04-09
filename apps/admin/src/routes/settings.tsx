import { createFileRoute } from '@tanstack/react-router'
import { useState, useEffect, useCallback } from 'react'
import { api } from '../lib/api-client'
import { AiSettingsPanel } from '../components/ai/ai-settings'

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
				<ApiKeysSection />
				<Section title="AI Models">
					<AiSettingsPanel />
				</Section>
				<Section title="General">
					<p className="text-zinc-400 text-sm">CMS name, locales, and defaults.</p>
				</Section>
				<Section title="Media">
					<p className="text-zinc-400 text-sm">
						Configure Cloudflare Images, Stream, R2, or local storage.
					</p>
				</Section>
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
		<div className="rounded-lg border border-zinc-800 p-6">
			<div className="flex items-center justify-between mb-4">
				<div>
					<h3 className="text-lg font-semibold">API Keys</h3>
					<p className="text-zinc-500 text-sm mt-1">
						Generate keys for AI agents and external integrations
					</p>
				</div>
				<button
					type="button"
					onClick={() => setShowCreate(true)}
					className="px-3 py-1.5 bg-white text-black rounded text-sm font-medium hover:bg-zinc-200 transition-colors"
				>
					Create Key
				</button>
			</div>

			{createdKey && (
				<div className="mb-4 p-4 rounded-lg bg-emerald-950 border border-emerald-800">
					<p className="text-sm font-medium text-emerald-300 mb-2">
						Save this key now. It will not be shown again.
					</p>
					<div className="flex items-center gap-2">
						<code className="flex-1 text-sm bg-black/30 px-3 py-2 rounded font-mono break-all">
							{createdKey}
						</code>
						<button
							type="button"
							onClick={copyKey}
							className="px-3 py-2 bg-emerald-800 text-emerald-100 rounded text-sm hover:bg-emerald-700"
						>
							{copied ? 'Copied' : 'Copy'}
						</button>
					</div>
					<details className="mt-3">
						<summary className="text-xs text-emerald-400 cursor-pointer">
							Claude Desktop config
						</summary>
						<pre className="mt-2 text-xs bg-black/30 p-3 rounded overflow-x-auto">
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
						className="mt-3 text-xs text-emerald-500 hover:text-emerald-400"
					>
						Dismiss
					</button>
				</div>
			)}

			{showCreate && (
				<div className="mb-4 p-4 rounded-lg bg-zinc-900 border border-zinc-700">
					<label className="block text-sm mb-2">Key name</label>
					<div className="flex gap-2">
						<input
							type="text"
							value={newKeyName}
							onChange={(e) => setNewKeyName(e.target.value)}
							onKeyDown={(e) => e.key === 'Enter' && createKey()}
							placeholder="e.g. Claude Agent, CI Pipeline"
							className="flex-1 px-3 py-2 bg-zinc-800 border border-zinc-700 rounded text-sm focus:outline-none focus:border-zinc-500"
							autoFocus
						/>
						<button
							type="button"
							onClick={createKey}
							className="px-4 py-2 bg-white text-black rounded text-sm font-medium hover:bg-zinc-200"
						>
							Create
						</button>
						<button
							type="button"
							onClick={() => setShowCreate(false)}
							className="px-4 py-2 bg-zinc-800 rounded text-sm hover:bg-zinc-700"
						>
							Cancel
						</button>
					</div>
				</div>
			)}

			{loading ? (
				<p className="text-zinc-500 text-sm">Loading...</p>
			) : keys.length === 0 ? (
				<p className="text-zinc-500 text-sm">No API keys yet.</p>
			) : (
				<table className="w-full text-sm">
					<thead>
						<tr className="text-left text-zinc-500 border-b border-zinc-800">
							<th className="pb-2 font-medium">Name</th>
							<th className="pb-2 font-medium">Key</th>
							<th className="pb-2 font-medium">Created</th>
							<th className="pb-2 font-medium">Last Used</th>
							<th className="pb-2 font-medium" />
						</tr>
					</thead>
					<tbody>
						{keys.map((k) => (
							<tr key={k.id} className="border-b border-zinc-800/50">
								<td className="py-3">{k.name}</td>
								<td className="py-3 font-mono text-zinc-500">{k.keyPrefix}...</td>
								<td className="py-3 text-zinc-500">
									{new Date(k.createdAt).toLocaleDateString()}
								</td>
								<td className="py-3 text-zinc-500">
									{k.lastUsedAt ? new Date(k.lastUsedAt).toLocaleDateString() : 'Never'}
								</td>
								<td className="py-3 text-right">
									<button
										type="button"
										onClick={() => deleteKey(k.id)}
										className="text-red-500 hover:text-red-400 text-xs"
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
		<div className="rounded-lg border border-zinc-800 p-6">
			<h3 className="text-lg font-semibold mb-2">{title}</h3>
			{children}
		</div>
	)
}
