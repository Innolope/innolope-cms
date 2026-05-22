import { useEffect, useRef, useState } from 'react'
import { api } from '../../lib/api-client'
import { useConfirm } from '../../lib/confirm'
import { useToast } from '../../lib/toast'
import { Dropdown } from '../dropdown'
import { SaveBar } from '../save-bar'

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

interface ProviderRow {
	provider: string
	apiKey: string
	connected: boolean
	enabled: boolean
}

const PROVIDER_LABELS: Record<string, string> = {
	anthropic: 'Anthropic',
	openai: 'OpenAI',
	google: 'Google AI',
	openrouter: 'OpenRouter',
}

const ALL_PROVIDERS = ['anthropic', 'openai', 'google', 'openrouter']

function GripIcon() {
	return (
		<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
			<circle cx="9" cy="5" r="1.7" />
			<circle cx="15" cy="5" r="1.7" />
			<circle cx="9" cy="12" r="1.7" />
			<circle cx="15" cy="12" r="1.7" />
			<circle cx="9" cy="19" r="1.7" />
			<circle cx="15" cy="19" r="1.7" />
		</svg>
	)
}

function AddProviderMenu({
	available,
	onAdd,
}: {
	available: string[]
	onAdd: (provider: string) => void
}) {
	const [open, setOpen] = useState(false)
	const ref = useRef<HTMLDivElement>(null)

	useEffect(() => {
		if (!open) return
		const handler = (e: MouseEvent) => {
			if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
		}
		document.addEventListener('mousedown', handler)
		return () => document.removeEventListener('mousedown', handler)
	}, [open])

	if (available.length === 0) return null

	return (
		<div className="relative inline-block" ref={ref}>
			<button
				type="button"
				onClick={() => setOpen(!open)}
				className="px-3 py-2 bg-btn-secondary text-text-secondary rounded text-sm hover:bg-btn-secondary-hover transition-colors"
			>
				+ Add provider
			</button>
			{open && (
				<div className="absolute left-0 top-full mt-1 min-w-44 bg-surface border border-border-strong rounded-lg shadow-xl z-50 overflow-hidden">
					{available.map((p) => (
						<button
							key={p}
							type="button"
							onClick={() => {
								onAdd(p)
								setOpen(false)
							}}
							className="w-full text-left px-3 py-2 text-sm text-text-secondary hover:bg-surface-alt hover:text-text transition-colors"
						>
							{PROVIDER_LABELS[p]}
						</button>
					))}
				</div>
			)}
		</div>
	)
}

export function AiSettingsPanel() {
	const toast = useToast()
	const confirm = useConfirm()
	const [settings, setSettings] = useState<AiSettingsData | null>(null)
	const [rows, setRows] = useState<ProviderRow[]>([])
	const [defaultModel, setDefaultModel] = useState('')
	const [saving, setSaving] = useState(false)
	const [saved, setSaved] = useState(false)
	const [dragOverIndex, setDragOverIndex] = useState<number | null>(null)
	const initialModel = useRef('')
	const initialRows = useRef<ProviderRow[]>([])
	const dragIndex = useRef<number | null>(null)

	const loadFrom = (data: AiSettingsData) => {
		setSettings(data)
		setDefaultModel(data.defaultModel)
		initialModel.current = data.defaultModel
		const loaded: ProviderRow[] = data.providers.map((p) => ({
			provider: p.provider,
			apiKey: '',
			connected: p.connected,
			enabled: p.enabled,
		}))
		setRows(loaded)
		initialRows.current = loaded
	}

	useEffect(() => {
		api
			.get<AiSettingsData>('/api/v1/ai/settings')
			.then(loadFrom)
			.catch(() => {})
	}, [])

	const dirty =
		defaultModel !== initialModel.current ||
		JSON.stringify(rows) !== JSON.stringify(initialRows.current)

	const save = async () => {
		setSaving(true)
		try {
			await api.put('/api/v1/ai/settings', {
				defaultModel,
				providers: rows.map((r) => ({
					provider: r.provider,
					apiKey: r.apiKey,
					enabled: r.enabled,
				})),
			})
			setSaved(true)
			setTimeout(() => setSaved(false), 2000)

			const updated = await api.get<AiSettingsData>('/api/v1/ai/settings')
			loadFrom(updated)
		} catch (err) {
			toast(err instanceof Error ? err.message : 'Failed to save', 'error')
		} finally {
			setSaving(false)
		}
	}

	const reset = () => {
		setDefaultModel(initialModel.current)
		setRows(initialRows.current)
	}

	const addProvider = (provider: string) => {
		setRows((prev) => [...prev, { provider, apiKey: '', connected: false, enabled: true }])
	}

	const updateKey = (provider: string, apiKey: string) => {
		setRows((prev) => prev.map((r) => (r.provider === provider ? { ...r, apiKey } : r)))
	}

	const removeRow = async (row: ProviderRow) => {
		const ok = await confirm({
			title: `Remove ${PROVIDER_LABELS[row.provider]}?`,
			message: row.connected
				? `This removes the ${PROVIDER_LABELS[row.provider]} provider. Its stored API key is deleted when you save.`
				: `This removes the ${PROVIDER_LABELS[row.provider]} provider row.`,
			confirmLabel: 'Remove',
			danger: true,
		})
		if (ok) setRows((prev) => prev.filter((r) => r.provider !== row.provider))
	}

	const handleDrop = (targetIndex: number) => {
		const from = dragIndex.current
		dragIndex.current = null
		setDragOverIndex(null)
		if (from === null || from === targetIndex) return
		setRows((prev) => {
			const next = [...prev]
			const [moved] = next.splice(from, 1)
			next.splice(from < targetIndex ? targetIndex - 1 : targetIndex, 0, moved)
			return next
		})
	}

	if (!settings) return <p className="text-text-secondary text-sm">Loading AI settings...</p>

	const modelOptions =
		settings.availableModels.length > 0
			? settings.availableModels.map((m) => ({ value: m.key, label: m.name }))
			: [{ value: '', label: 'No models available — connect a provider below' }]

	const defaultModelField = (
		<div className="shrink-0">
			<div className="block text-sm font-medium mb-2">Default Model</div>
			<Dropdown
				value={defaultModel}
				onChange={setDefaultModel}
				options={modelOptions}
				className="w-72"
			/>
		</div>
	)

	if (settings.cloudMode) {
		return (
			<div className="space-y-6">
				{defaultModelField}
				<p className="text-sm text-text-secondary">
					AI providers are managed by Innolope Cloud. All major models are available. Select your
					preferred default model above.
				</p>
				<SaveBar dirty={dirty} saving={saving} saved={saved} onSave={save} onReset={reset} />
			</div>
		)
	}

	const availableToAdd = ALL_PROVIDERS.filter((p) => !rows.some((r) => r.provider === p))

	return (
		<div className="space-y-6">
			<div>
				<div className="block text-sm font-medium mb-3">Provider API Keys</div>
				<p className="text-xs text-text-secondary mb-4">
					Add your own API keys to enable AI features. Keys are stored encrypted per project.
				</p>
				<div className="flex gap-8 items-start">
					<div className="flex-1 min-w-0 space-y-2">
						{rows.map((row, i) => (
							<div
								key={row.provider}
								onDragOver={(e) => {
									e.preventDefault()
									setDragOverIndex(i)
								}}
								onDragLeave={() => setDragOverIndex((cur) => (cur === i ? null : cur))}
								onDrop={() => handleDrop(i)}
								className={`flex items-center gap-3 rounded border-t-2 ${
									dragOverIndex === i ? 'border-border-strong' : 'border-transparent'
								}`}
							>
								<span
									draggable
									onDragStart={() => {
										dragIndex.current = i
									}}
									onDragEnd={() => {
										dragIndex.current = null
										setDragOverIndex(null)
									}}
									title="Drag to reorder"
									className="shrink-0 cursor-grab text-text-muted hover:text-text"
								>
									<GripIcon />
								</span>
								<span className="w-24 text-sm text-text-muted shrink-0">
									{PROVIDER_LABELS[row.provider]}
								</span>
								<input
									type="password"
									value={row.apiKey}
									onChange={(e) => updateKey(row.provider, e.target.value)}
									placeholder={
										row.connected ? 'Connected (enter new key to replace)' : 'Paste API key...'
									}
									className="flex-1 min-w-0 px-3 py-2 bg-input border border-border rounded text-sm font-mono focus:outline-none focus:border-border-strong"
								/>
								{row.connected && <span className="text-xs text-text shrink-0">Connected</span>}
								<button
									type="button"
									onClick={() => removeRow(row)}
									title="Remove provider"
									className="shrink-0 w-7 h-7 flex items-center justify-center text-text-muted hover:text-text rounded hover:bg-surface-alt transition-colors"
								>
									<svg
										width="14"
										height="14"
										viewBox="0 0 24 24"
										fill="none"
										stroke="currentColor"
										strokeWidth="2"
										strokeLinecap="round"
										strokeLinejoin="round"
									>
										<line x1="18" y1="6" x2="6" y2="18" />
										<line x1="6" y1="6" x2="18" y2="18" />
									</svg>
								</button>
							</div>
						))}
						<AddProviderMenu available={availableToAdd} onAdd={addProvider} />
					</div>
					{defaultModelField}
				</div>
			</div>

			<SaveBar dirty={dirty} saving={saving} saved={saved} onSave={save} onReset={reset} />
		</div>
	)
}
