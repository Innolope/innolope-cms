import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { api } from '../../lib/api-client'
import { useConfirm } from '../../lib/confirm'
import { useToast } from '../../lib/toast'

interface Webhook {
	id: string
	url: string
	events: string[]
	active: boolean
	secret?: string
	headerNames?: string[]
	customPayload?: string | null
	createdAt: string
}

interface Delivery {
	id: string
	event: string
	status: string
	statusCode: number | null
	attempts: number
	createdAt: string
}

interface HeaderRow {
	name: string
	value: string
}

const EVENT_TYPES = [
	'content:created',
	'content:updated',
	'content:published',
	'content:scheduled',
	'content:deleted',
	'content:submitted',
	'content:approved',
	'content:rejected',
	'media:uploaded',
	'media:deleted',
]

const HEADER_NAME_PATTERN = /^[A-Za-z0-9-]{1,128}$/

export function WebhookSettings() {
	const { t } = useTranslation()
	const toast = useToast()
	const confirm = useConfirm()
	const [hooks, setHooks] = useState<Webhook[]>([])
	const [loading, setLoading] = useState(true)
	const [createdSecret, setCreatedSecret] = useState<string | null>(null)
	const [expandedId, setExpandedId] = useState<string | null>(null)
	const [deliveries, setDeliveries] = useState<Delivery[]>([])

	// null = form closed, 'new' = creating, otherwise the webhook being edited
	const [editing, setEditing] = useState<'new' | Webhook | null>(null)
	const [formUrl, setFormUrl] = useState('')
	const [formEvents, setFormEvents] = useState<string[]>([])
	const [headerRows, setHeaderRows] = useState<HeaderRow[]>([])
	// Header values are write-only server-side; editing starts from the stored
	// names as read-only chips until the user chooses to replace the whole set.
	const [replaceHeaders, setReplaceHeaders] = useState(false)
	const [payloadMode, setPayloadMode] = useState<'default' | 'custom'>('default')
	const [payloadText, setPayloadText] = useState('')

	const fetchHooks = useCallback(async () => {
		setLoading(true)
		try {
			const res = await api.get<{ data: Webhook[] }>('/api/v1/ee/webhooks')
			setHooks(res.data)
		} catch {
			/* */
		}
		setLoading(false)
	}, [])

	useEffect(() => {
		fetchHooks()
	}, [fetchHooks])

	const openCreate = () => {
		setEditing('new')
		setFormUrl('')
		setFormEvents([])
		setHeaderRows([])
		setReplaceHeaders(true)
		setPayloadMode('default')
		setPayloadText('')
	}

	const openEdit = (hook: Webhook) => {
		setEditing(hook)
		setFormUrl(hook.url)
		setFormEvents(hook.events)
		setHeaderRows([])
		setReplaceHeaders(!hook.headerNames || hook.headerNames.length === 0)
		setPayloadMode(hook.customPayload ? 'custom' : 'default')
		setPayloadText(hook.customPayload ?? '')
	}

	const buildHeaders = (): Record<string, string> | null => {
		const headers: Record<string, string> = {}
		for (const row of headerRows) {
			const name = row.name.trim()
			if (!name && !row.value) continue
			if (!HEADER_NAME_PATTERN.test(name) || !row.value) {
				toast(t('settings.webhook.invalidHeaderName'), 'error')
				return null
			}
			headers[name] = row.value
		}
		return headers
	}

	const buildPayload = (): { customPayload: string | null } | null => {
		if (payloadMode === 'default') return { customPayload: null }
		try {
			const parsed = JSON.parse(payloadText)
			if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error()
		} catch {
			toast(t('settings.webhook.invalidJson'), 'error')
			return null
		}
		return { customPayload: payloadText }
	}

	const save = async () => {
		if (!formUrl.trim()) return
		const payload = buildPayload()
		if (!payload) return
		const headers = replaceHeaders ? buildHeaders() : undefined
		if (replaceHeaders && headers === null) return

		try {
			if (editing === 'new') {
				const created = await api.post<Webhook>('/api/v1/ee/webhooks', {
					url: formUrl,
					events: formEvents.length > 0 ? formEvents : undefined,
					...(headers && Object.keys(headers).length > 0 && { headers }),
					...(payload.customPayload && payload),
				})
				setCreatedSecret(created.secret || null)
			} else if (editing) {
				await api.put(`/api/v1/ee/webhooks/${editing.id}`, {
					url: formUrl,
					events: formEvents,
					...(replaceHeaders && { headers }),
					...payload,
				})
			}
			setEditing(null)
			fetchHooks()
		} catch (err) {
			toast(err instanceof Error ? err.message : t('settings.webhook.saveFailed'), 'error')
		}
	}

	const toggleActive = async (hook: Webhook) => {
		await api.put(`/api/v1/ee/webhooks/${hook.id}`, { active: !hook.active })
		fetchHooks()
	}

	const deleteHook = async (id: string) => {
		const ok = await confirm({
			title: t('settings.webhook.deleteConfirmTitle'),
			message: t('settings.webhook.deleteConfirmMessage'),
			confirmLabel: t('settings.webhook.deleteConfirmLabel'),
			danger: true,
		})
		if (!ok) return
		await api.delete(`/api/v1/ee/webhooks/${id}`)
		fetchHooks()
	}

	const testHook = async (id: string) => {
		try {
			const result = await api.post<{ success: boolean }>(`/api/v1/ee/webhooks/${id}/test`, {})
			toast(
				result.success ? t('settings.webhook.testSuccess') : t('settings.webhook.testFailed'),
				result.success ? 'success' : 'error',
			)
		} catch (err) {
			toast(err instanceof Error ? err.message : t('settings.webhook.testError'), 'error')
		}
	}

	const loadDeliveries = async (hookId: string) => {
		if (expandedId === hookId) {
			setExpandedId(null)
			return
		}
		try {
			const res = await api.get<{ data: Delivery[] }>(
				`/api/v1/ee/webhooks/${hookId}/deliveries?limit=10`,
			)
			setDeliveries(res.data)
			setExpandedId(hookId)
		} catch {
			/* */
		}
	}

	const toggleEvent = (event: string) => {
		setFormEvents((prev) =>
			prev.includes(event) ? prev.filter((e) => e !== event) : [...prev, event],
		)
	}

	const setHeaderRow = (index: number, patch: Partial<HeaderRow>) => {
		setHeaderRows((prev) => prev.map((row, i) => (i === index ? { ...row, ...patch } : row)))
	}

	if (loading) return <p className="text-sm text-text-secondary">{t('common.loading')}</p>

	const editingHook = editing !== null && editing !== 'new' ? editing : null

	return (
		<div className="space-y-4">
			<div className="flex items-center justify-between mb-4">
				<p className="text-text-secondary text-sm">{t('settings.webhook.intro')}</p>
				{!editing && (
					<button
						type="button"
						onClick={openCreate}
						className="px-3 py-1.5 bg-btn-primary text-btn-primary-text rounded text-sm font-medium hover:bg-btn-primary-hover transition-colors"
					>
						{t('settings.webhook.create')}
					</button>
				)}
			</div>

			{createdSecret && (
				<div className="p-3 bg-surface-alt border border-border rounded-lg">
					<p className="text-sm font-medium mb-1">{t('settings.webhook.secretReveal')}</p>
					<code className="text-xs font-mono bg-input px-2 py-1 rounded break-all">
						{createdSecret}
					</code>
					<button
						type="button"
						onClick={() => setCreatedSecret(null)}
						className="block mt-2 text-xs text-text-secondary hover:text-text"
					>
						{t('settings.webhook.dismiss')}
					</button>
				</div>
			)}

			{hooks.length === 0 && !editing && !createdSecret ? (
				<div className="flex flex-col items-center justify-center py-16 text-center">
					<div className="w-14 h-14 rounded-2xl bg-surface-alt flex items-center justify-center mb-4">
						<svg
							width="28"
							height="28"
							viewBox="0 0 24 24"
							fill="none"
							stroke="currentColor"
							strokeWidth="1.5"
							strokeLinecap="round"
							strokeLinejoin="round"
							className="text-text-muted"
						>
							<path d="M10 13a5 5 0 007.54.54l3-3a5 5 0 00-7.07-7.07l-1.72 1.71" />
							<path d="M14 11a5 5 0 00-7.54-.54l-3 3a5 5 0 007.07 7.07l1.71-1.71" />
						</svg>
					</div>
					<h3 className="font-semibold text-text mb-1">{t('settings.webhook.emptyTitle')}</h3>
					<p className="text-sm text-text-secondary max-w-xs mb-5">
						{t('settings.webhook.emptyDesc')}
					</p>
					<button
						type="button"
						onClick={openCreate}
						className="px-4 py-2 bg-btn-primary text-btn-primary-text rounded-lg text-sm font-medium hover:bg-btn-primary-hover transition-colors"
					>
						{t('settings.webhook.createFirst')}
					</button>
				</div>
			) : hooks.length === 0 ? null : (
				<div className="space-y-2">
					{hooks.map((hook) => (
						<div key={hook.id} className="border border-border rounded-lg">
							<div className="flex items-center justify-between p-3">
								<div className="min-w-0 flex-1">
									<p className="text-sm font-mono truncate">{hook.url}</p>
									<p className="text-xs text-text-secondary mt-0.5">
										{hook.events.length > 0
											? hook.events.join(', ')
											: t('settings.webhook.allEvents')}
										{' · '}
										{hook.active ? t('settings.webhook.active') : t('settings.webhook.paused')}
										{hook.headerNames && hook.headerNames.length > 0 && (
											<>
												{' · '}
												{t('settings.webhook.customHeadersBadge', {
													count: hook.headerNames.length,
												})}
											</>
										)}
										{hook.customPayload && (
											<>
												{' · '}
												{t('settings.webhook.customPayloadBadge')}
											</>
										)}
									</p>
								</div>
								<div className="flex gap-1.5 ml-3">
									<button
										type="button"
										onClick={() => loadDeliveries(hook.id)}
										className="px-2 py-1 bg-btn-secondary rounded text-xs hover:bg-btn-secondary-hover"
									>
										{t('settings.webhook.logs')}
									</button>
									<button
										type="button"
										onClick={() => testHook(hook.id)}
										className="px-2 py-1 bg-btn-secondary rounded text-xs hover:bg-btn-secondary-hover"
									>
										{t('settings.webhook.test')}
									</button>
									<button
										type="button"
										onClick={() => openEdit(hook)}
										className="px-2 py-1 bg-btn-secondary rounded text-xs hover:bg-btn-secondary-hover"
									>
										{t('settings.webhook.edit')}
									</button>
									<button
										type="button"
										onClick={() => toggleActive(hook)}
										className="px-2 py-1 bg-btn-secondary rounded text-xs hover:bg-btn-secondary-hover"
									>
										{hook.active ? t('settings.webhook.pause') : t('settings.webhook.enable')}
									</button>
									<button
										type="button"
										onClick={() => deleteHook(hook.id)}
										className="px-2 py-1 text-danger rounded text-xs hover:opacity-80"
									>
										{t('settings.webhook.delete')}
									</button>
								</div>
							</div>
							{expandedId === hook.id && (
								<div className="border-t border-border p-3 bg-surface-alt">
									<p className="text-xs font-medium mb-2">
										{t('settings.webhook.recentDeliveries')}
									</p>
									{deliveries.length === 0 ? (
										<p className="text-xs text-text-secondary">
											{t('settings.webhook.noDeliveries')}
										</p>
									) : (
										<div className="space-y-1">
											{deliveries.map((d) => (
												<div key={d.id} className="flex items-center justify-between text-xs">
													<span className="font-mono">{d.event}</span>
													<span className={d.status === 'success' ? 'text-text' : 'text-danger'}>
														{d.status} {d.statusCode ? `(${d.statusCode})` : ''}
													</span>
													<span className="text-text-secondary">
														{new Date(d.createdAt).toLocaleString()}
													</span>
												</div>
											))}
										</div>
									)}
								</div>
							)}
						</div>
					))}
				</div>
			)}

			{editing ? (
				<div className="border border-border rounded-lg p-4 space-y-3">
					<div>
						<label htmlFor="webhook-url" className="block text-xs text-text-secondary mb-1">
							{t('settings.webhook.endpointUrl')}
						</label>
						<input
							id="webhook-url"
							type="url"
							value={formUrl}
							onChange={(e) => setFormUrl(e.target.value)}
							placeholder="https://example.com/webhook"
							className="w-full px-3 py-2 bg-input border border-border rounded text-sm font-mono focus:outline-none focus:border-border-strong"
						/>
					</div>
					<div>
						<div className="block text-xs text-text-secondary mb-1.5">
							{t('settings.webhook.eventsLabel')}
						</div>
						<div className="flex flex-wrap gap-1.5">
							{EVENT_TYPES.map((event) => (
								<button
									key={event}
									type="button"
									onClick={() => toggleEvent(event)}
									className={`px-2 py-1 rounded text-xs border ${
										formEvents.includes(event)
											? 'border-border-strong bg-surface-alt text-text'
											: 'border-border text-text-secondary hover:border-border-strong'
									}`}
								>
									{event}
								</button>
							))}
						</div>
					</div>
					<div>
						<div className="block text-xs text-text-secondary mb-1.5">
							{t('settings.webhook.headersLabel')}
						</div>
						{editingHook && !replaceHeaders ? (
							<div className="flex flex-wrap items-center gap-1.5">
								{(editingHook.headerNames ?? []).map((name) => (
									<span
										key={name}
										className="px-2 py-1 rounded text-xs border border-border font-mono text-text-secondary"
									>
										{name}
									</span>
								))}
								<button
									type="button"
									onClick={() => setReplaceHeaders(true)}
									className="px-2 py-1 bg-btn-secondary rounded text-xs hover:bg-btn-secondary-hover"
								>
									{t('settings.webhook.replaceHeaders')}
								</button>
							</div>
						) : (
							<div className="space-y-1.5">
								{editingHook && (editingHook.headerNames?.length ?? 0) > 0 && (
									<p className="text-xs text-text-secondary">
										{t('settings.webhook.headersReplaceHint')}
									</p>
								)}
								{headerRows.map((row, index) => (
									// biome-ignore lint/suspicious/noArrayIndexKey: rows have no stable identity while being typed
									<div key={index} className="flex gap-1.5">
										<input
											type="text"
											value={row.name}
											onChange={(e) => setHeaderRow(index, { name: e.target.value })}
											placeholder={t('settings.webhook.headerName')}
											className="w-1/3 px-3 py-1.5 bg-input border border-border rounded text-xs font-mono focus:outline-none focus:border-border-strong"
										/>
										<input
											type="password"
											value={row.value}
											onChange={(e) => setHeaderRow(index, { value: e.target.value })}
											placeholder={t('settings.webhook.headerValue')}
											autoComplete="off"
											className="flex-1 px-3 py-1.5 bg-input border border-border rounded text-xs font-mono focus:outline-none focus:border-border-strong"
										/>
										<button
											type="button"
											onClick={() => setHeaderRows((prev) => prev.filter((_, i) => i !== index))}
											className="px-2 py-1 text-danger rounded text-xs hover:opacity-80"
										>
											{t('settings.webhook.removeHeader')}
										</button>
									</div>
								))}
								<button
									type="button"
									onClick={() => setHeaderRows((prev) => [...prev, { name: '', value: '' }])}
									className="px-2 py-1 bg-btn-secondary rounded text-xs hover:bg-btn-secondary-hover"
								>
									{t('settings.webhook.addHeader')}
								</button>
								<p className="text-xs text-text-secondary">{t('settings.webhook.headersHint')}</p>
							</div>
						)}
					</div>
					<div>
						<div className="block text-xs text-text-secondary mb-1.5">
							{t('settings.webhook.payloadModeLabel')}
						</div>
						<div className="flex gap-1.5 mb-1.5">
							{(['default', 'custom'] as const).map((mode) => (
								<button
									key={mode}
									type="button"
									onClick={() => setPayloadMode(mode)}
									className={`px-2 py-1 rounded text-xs border ${
										payloadMode === mode
											? 'border-border-strong bg-surface-alt text-text'
											: 'border-border text-text-secondary hover:border-border-strong'
									}`}
								>
									{mode === 'default'
										? t('settings.webhook.payloadModeDefault')
										: t('settings.webhook.payloadModeCustom')}
								</button>
							))}
						</div>
						{payloadMode === 'custom' && (
							<>
								<textarea
									value={payloadText}
									onChange={(e) => setPayloadText(e.target.value)}
									rows={4}
									placeholder={'{"event_type": "blog-published"}'}
									className="w-full px-3 py-2 bg-input border border-border rounded text-xs font-mono focus:outline-none focus:border-border-strong"
								/>
								<p className="text-xs text-text-secondary mt-1">
									{t('settings.webhook.customPayloadHint')}
								</p>
							</>
						)}
					</div>
					<div className="flex gap-2 pt-1">
						<button
							type="button"
							onClick={save}
							className="px-4 py-1.5 bg-btn-primary text-btn-primary-text rounded text-sm font-medium hover:bg-btn-primary-hover"
						>
							{editing === 'new' ? t('settings.webhook.create') : t('settings.webhook.save')}
						</button>
						<button
							type="button"
							onClick={() => setEditing(null)}
							className="px-4 py-1.5 bg-btn-secondary rounded text-sm hover:bg-btn-secondary-hover"
						>
							{t('settings.webhook.dismiss')}
						</button>
					</div>
				</div>
			) : null}
		</div>
	)
}
