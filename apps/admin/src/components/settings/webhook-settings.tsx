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

const EVENT_TYPES = [
	'content:created',
	'content:updated',
	'content:published',
	'content:deleted',
	'content:submitted',
	'content:approved',
	'content:rejected',
	'media:uploaded',
	'media:deleted',
]

export function WebhookSettings() {
	const { t } = useTranslation()
	const toast = useToast()
	const confirm = useConfirm()
	const [hooks, setHooks] = useState<Webhook[]>([])
	const [loading, setLoading] = useState(true)
	const [showCreate, setShowCreate] = useState(false)
	const [newUrl, setNewUrl] = useState('')
	const [newEvents, setNewEvents] = useState<string[]>([])
	const [createdSecret, setCreatedSecret] = useState<string | null>(null)
	const [expandedId, setExpandedId] = useState<string | null>(null)
	const [deliveries, setDeliveries] = useState<Delivery[]>([])

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

	const create = async () => {
		if (!newUrl.trim()) return
		try {
			const created = await api.post<Webhook>('/api/v1/ee/webhooks', {
				url: newUrl,
				events: newEvents.length > 0 ? newEvents : undefined,
			})
			setCreatedSecret(created.secret || null)
			setNewUrl('')
			setNewEvents([])
			setShowCreate(false)
			fetchHooks()
		} catch (err) {
			toast(err instanceof Error ? err.message : t('settings.webhook.createFailed'), 'error')
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
		setNewEvents((prev) =>
			prev.includes(event) ? prev.filter((e) => e !== event) : [...prev, event],
		)
	}

	if (loading) return <p className="text-sm text-text-secondary">{t('common.loading')}</p>

	return (
		<div className="space-y-4">
			<div className="flex items-center justify-between mb-4">
				<p className="text-text-secondary text-sm">{t('settings.webhook.intro')}</p>
				{!showCreate && (
					<button
						type="button"
						onClick={() => setShowCreate(true)}
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

			{hooks.length === 0 && !showCreate && !createdSecret ? (
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
						onClick={() => setShowCreate(true)}
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

			{showCreate ? (
				<div className="border border-border rounded-lg p-4 space-y-3">
					<div>
						<label htmlFor="webhook-url" className="block text-xs text-text-secondary mb-1">
							{t('settings.webhook.endpointUrl')}
						</label>
						<input
							id="webhook-url"
							type="url"
							value={newUrl}
							onChange={(e) => setNewUrl(e.target.value)}
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
										newEvents.includes(event)
											? 'border-border-strong bg-surface-alt text-text'
											: 'border-border text-text-secondary hover:border-border-strong'
									}`}
								>
									{event}
								</button>
							))}
						</div>
					</div>
					<div className="flex gap-2 pt-1">
						<button
							type="button"
							onClick={create}
							className="px-4 py-1.5 bg-btn-primary text-btn-primary-text rounded text-sm font-medium hover:bg-btn-primary-hover"
						>
							{t('settings.webhook.create')}
						</button>
						<button
							type="button"
							onClick={() => setShowCreate(false)}
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
