import { useState, useEffect } from 'react'
import { api } from '../../lib/api-client'
import { useToast } from '../../lib/toast'

interface ProviderStatus {
	provider: string
	enabled: boolean
	connected: boolean
}

interface ModelInfo {
	key: string
	provider: string
	name: string
	modelId: string
}

interface AiSettingsData {
	defaultModel: string
	providers: ProviderStatus[]
	availableModels: ModelInfo[]
	cloudMode: boolean
}

const PROVIDER_LABELS: Record<string, string> = {
	anthropic: 'Anthropic',
	openai: 'OpenAI',
	google: 'Google AI',
	openrouter: 'OpenRouter',
}

export function AiSettingsPanel() {
	const toast = useToast()
	const [settings, setSettings] = useState<AiSettingsData | null>(null)
	const [keys, setKeys] = useState<Record<string, string>>({})
	const [defaultModel, setDefaultModel] = useState('')
	const [saving, setSaving] = useState(false)
	const [saved, setSaved] = useState(false)

	useEffect(() => {
		api.get<AiSettingsData>('/api/v1/ai/settings').then((data) => {
			setSettings(data)
			setDefaultModel(data.defaultModel)
		}).catch(() => {})
	}, [])

	const save = async () => {
		setSaving(true)
		try {
			const providers = Object.entries(keys)
				.filter(([_, key]) => key.trim())
				.map(([provider, apiKey]) => ({ provider, apiKey, enabled: true }))

			// Include existing connected providers that weren't changed
			if (settings) {
				for (const p of settings.providers) {
					if (p.connected && !keys[p.provider]) {
						providers.push({ provider: p.provider, apiKey: '', enabled: p.enabled })
					}
				}
			}

			await api.put('/api/v1/ai/settings', {
				defaultModel,
				...(providers.length > 0 ? { providers } : {}),
			})
			setSaved(true)
			setTimeout(() => setSaved(false), 2000)

			// Refresh settings
			const updated = await api.get<AiSettingsData>('/api/v1/ai/settings')
			setSettings(updated)
			setKeys({})
		} catch (err) {
			toast(err instanceof Error ? err.message : 'Failed to save', 'error')
		} finally {
			setSaving(false)
		}
	}

	if (!settings) return <p className="text-text-secondary text-sm">Loading AI settings...</p>

	return (
		<div className="space-y-6">
			<div>
				<label className="block text-sm font-medium mb-2">Default Model</label>
				<select
					value={defaultModel}
					onChange={(e) => setDefaultModel(e.target.value)}
					className="w-full max-w-xs px-3 py-2 bg-input border border-border rounded text-sm focus:outline-none focus:border-border-strong"
				>
					{settings.availableModels.length > 0 ? (
						settings.availableModels.map((m) => (
							<option key={m.key} value={m.key}>
								{m.name}
							</option>
						))
					) : (
						<option disabled>No models available — connect a provider below</option>
					)}
				</select>
			</div>

			{!settings.cloudMode && (
				<div>
					<label className="block text-sm font-medium mb-3">Provider API Keys</label>
					<p className="text-xs text-text-secondary mb-4">
						Add your own API keys to enable AI features. Keys are stored encrypted per project.
					</p>
					<div className="space-y-3">
						{['anthropic', 'openai', 'google', 'openrouter'].map((provider) => {
							const status = settings.providers.find((p) => p.provider === provider)
							const isConnected = status?.connected
							return (
								<div key={provider} className="flex items-center gap-3">
									<span className="w-24 text-sm text-text-muted shrink-0">
										{PROVIDER_LABELS[provider]}
									</span>
									<input
										type="password"
										value={keys[provider] || ''}
										onChange={(e) =>
											setKeys({ ...keys, [provider]: e.target.value })
										}
										placeholder={isConnected ? 'Connected (enter new key to replace)' : 'Paste API key...'}
										className="flex-1 px-3 py-2 bg-input border border-border rounded text-sm font-mono focus:outline-none focus:border-border-strong"
									/>
									{isConnected && (
										<span className="text-xs text-text shrink-0">Connected</span>
									)}
								</div>
							)
						})}
					</div>
				</div>
			)}

			{settings.cloudMode && (
				<p className="text-sm text-text-secondary bg-surface p-4 rounded-lg border border-border">
					AI providers are managed by Innolope Cloud. All major models are available. Select your preferred default model above.
				</p>
			)}

			<button
				type="button"
				onClick={save}
				disabled={saving}
				className="px-4 py-2 bg-btn-primary text-btn-primary-text rounded text-sm font-medium hover:bg-btn-primary-hover disabled:opacity-50 transition-colors"
			>
				{saving ? 'Saving...' : saved ? 'Saved' : 'Save AI Settings'}
			</button>
		</div>
	)
}
