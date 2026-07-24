import { useEffect, useId, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { api } from '../../lib/api-client'
import { useAuth } from '../../lib/auth'
import { useToast } from '../../lib/toast'
import { Dropdown } from '../dropdown'
import { SaveBar } from '../save-bar'

interface MediaEnvConfig {
	adapter: string
	cloudMode: boolean
	env: {
		accountId: boolean
		apiToken: boolean
		imagesAccountHash: boolean
		r2Bucket: boolean
		r2AccessKeyId: boolean
		r2SecretAccessKey: boolean
		r2Endpoint: boolean
	}
}

export function MediaSettings() {
	const { t } = useTranslation()
	const { currentProject, refreshProjects } = useAuth()
	const toast = useToast()
	const [adapter, setAdapter] = useState('local')
	const [cfAccountId, setCfAccountId] = useState('')
	const [cfApiToken, setCfApiToken] = useState('')
	const [cfImagesHash, setCfImagesHash] = useState('')
	const [cfR2Bucket, setCfR2Bucket] = useState('')
	const [cfR2AccessKey, setCfR2AccessKey] = useState('')
	const [cfR2SecretKey, setCfR2SecretKey] = useState('')
	const [cfR2Endpoint, setCfR2Endpoint] = useState('')
	const [saving, setSaving] = useState(false)
	const [saved, setSaved] = useState(false)
	const [envConfig, setEnvConfig] = useState<MediaEnvConfig | null>(null)
	const [hasStoredToken, setHasStoredToken] = useState(false)
	const [hasStoredR2Keys, setHasStoredR2Keys] = useState(false)
	const initialAdapter = useRef('local')

	useEffect(() => {
		if (currentProject) {
			const settings = (currentProject.settings as Record<string, unknown>) || {}
			const a = (settings.mediaAdapter as string) || 'local'
			setAdapter(a)
			initialAdapter.current = a
			// Secrets are stripped server-side; only `has*` flags arrive.
			const cf = (settings.cloudflare as Record<string, string | boolean>) || {}
			setCfAccountId((cf.accountId as string) || '')
			setCfApiToken('')
			setCfImagesHash((cf.imagesAccountHash as string) || '')
			setCfR2Bucket((cf.r2Bucket as string) || '')
			setCfR2AccessKey('')
			setCfR2SecretKey('')
			setCfR2Endpoint((cf.r2Endpoint as string) || '')
			setHasStoredToken(Boolean(cf.hasApiToken))
			setHasStoredR2Keys(Boolean(cf.hasR2Credentials))
		}
	}, [currentProject])

	// Fetch env config to know which fields are pre-configured
	useEffect(() => {
		api
			.get<MediaEnvConfig>('/api/v1/media/config')
			.then(setEnvConfig)
			.catch(() => {})
	}, [])

	const dirty = adapter !== initialAdapter.current
	const adapterSetViaEnv = envConfig && envConfig.adapter !== 'local'

	// If adapter is set via env, reflect that in the UI
	const effectiveAdapter = adapterSetViaEnv ? envConfig.adapter : adapter

	const save = async () => {
		if (!currentProject) return
		setSaving(true)
		try {
			await api.put(`/api/v1/projects/${currentProject.id}`, {
				settings: {
					...(currentProject.settings as Record<string, unknown>),
					mediaAdapter: adapter,
					cloudflare:
						adapter === 'cloudflare'
							? {
									accountId: cfAccountId,
									apiToken: cfApiToken,
									imagesAccountHash: cfImagesHash,
									r2Bucket: cfR2Bucket,
									r2AccessKeyId: cfR2AccessKey,
									r2SecretAccessKey: cfR2SecretKey,
									r2Endpoint: cfR2Endpoint,
								}
							: undefined,
				},
			})
			setSaved(true)
			setTimeout(() => setSaved(false), 2000)
			await refreshProjects()
		} catch (err) {
			toast(err instanceof Error ? err.message : t('settings.media.saveFailed'), 'error')
		} finally {
			setSaving(false)
		}
	}

	const allCfEnvSet =
		envConfig?.env?.accountId && envConfig.env.apiToken && envConfig.env.imagesAccountHash

	const adapterDisplayName = (a: string) => {
		if (a === 'cloudflare') return t('settings.media.adapters.cloudflare')
		if (a === 's3') return t('settings.media.adapters.s3')
		if (a === 'local') return t('settings.media.adapters.local')
		return a
	}

	return (
		<div className="space-y-4">
			<div>
				<div className="block text-xs text-text-secondary mb-1.5">
					{t('settings.media.storageAdapter')}
				</div>
				{adapterSetViaEnv ? (
					<div>
						<p className="text-sm font-medium text-text">{adapterDisplayName(effectiveAdapter)}</p>
						<p className="text-xs text-text-muted mt-1">
							{t('settings.media.setViaEnv')}{' '}
							<code className="bg-surface-alt px-1 rounded">MEDIA_ADAPTER</code>
						</p>
					</div>
				) : (
					<Dropdown
						value={adapter}
						onChange={setAdapter}
						options={[
							{ value: 'local', label: t('settings.media.adapters.local') },
							{ value: 'cloudflare', label: t('settings.media.adapters.cloudflare') },
							{ value: 's3', label: t('settings.media.adapters.s3') },
						]}
						className="w-full max-w-xs"
					/>
				)}
			</div>

			{effectiveAdapter === 'cloudflare' &&
				(allCfEnvSet ? (
					<div className="rounded-lg bg-surface-alt border border-border p-4">
						<div className="flex items-center gap-2 mb-2">
							<svg
								width="16"
								height="16"
								viewBox="0 0 24 24"
								fill="none"
								stroke="currentColor"
								strokeWidth="2"
								strokeLinecap="round"
								strokeLinejoin="round"
								className="text-accent"
							>
								<polyline points="20 6 9 17 4 12" />
							</svg>
							<p className="text-sm font-medium text-text">
								{t('settings.media.cfEnvConfiguredTitle')}
							</p>
						</div>
						<p className="text-xs text-text-muted">{t('settings.media.cfEnvConfiguredDesc')}</p>
					</div>
				) : (
					<div className="space-y-3 border-l-2 border-border pl-4">
						<CfField
							label={t('settings.media.fields.accountId')}
							value={cfAccountId}
							onChange={setCfAccountId}
							envConfigured={envConfig?.env.accountId}
						/>
						<CfField
							label={t('settings.media.fields.apiToken')}
							value={cfApiToken}
							onChange={setCfApiToken}
							password
							envConfigured={envConfig?.env.apiToken}
							stored={hasStoredToken}
						/>
						<CfField
							label={t('settings.media.fields.imagesAccountHash')}
							value={cfImagesHash}
							onChange={setCfImagesHash}
							envConfigured={envConfig?.env.imagesAccountHash}
						/>
						<CfField
							label={t('settings.media.fields.r2Bucket')}
							value={cfR2Bucket}
							onChange={setCfR2Bucket}
							envConfigured={envConfig?.env.r2Bucket}
						/>
						<CfField
							label={t('settings.media.fields.r2AccessKeyId')}
							value={cfR2AccessKey}
							onChange={setCfR2AccessKey}
							envConfigured={envConfig?.env.r2AccessKeyId}
							stored={hasStoredR2Keys}
						/>
						<CfField
							label={t('settings.media.fields.r2SecretAccessKey')}
							value={cfR2SecretKey}
							onChange={setCfR2SecretKey}
							password
							envConfigured={envConfig?.env.r2SecretAccessKey}
							stored={hasStoredR2Keys}
						/>
						<CfField
							label={t('settings.media.fields.r2Endpoint')}
							value={cfR2Endpoint}
							onChange={setCfR2Endpoint}
							placeholder="https://..."
							envConfigured={envConfig?.env.r2Endpoint}
						/>
					</div>
				))}

			{effectiveAdapter === 'local' && (
				<p className="text-xs text-text-muted">{t('settings.media.localDesc')}</p>
			)}

			{!adapterSetViaEnv && <SaveBar dirty={dirty} saving={saving} saved={saved} onSave={save} />}
		</div>
	)
}

function CfField({
	label,
	value,
	onChange,
	password,
	placeholder,
	envConfigured,
	stored,
}: {
	label: string
	value: string
	onChange: (v: string) => void
	password?: boolean
	placeholder?: string
	envConfigured?: boolean
	/** A secret is saved server-side (never echoed); blank keeps it, typing replaces it. */
	stored?: boolean
}) {
	const { t } = useTranslation()
	const fieldId = useId()
	if (envConfigured && !value) {
		return (
			<div>
				<div className="block text-xs text-text-secondary mb-1">{label}</div>
				<div className="flex items-center gap-2 px-3 py-2 bg-surface-alt border border-border rounded text-sm text-text-muted">
					<svg
						width="14"
						height="14"
						viewBox="0 0 24 24"
						fill="none"
						stroke="currentColor"
						strokeWidth="2"
						strokeLinecap="round"
						strokeLinejoin="round"
						className="shrink-0"
					>
						<rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
						<path d="M7 11V7a5 5 0 0110 0v4" />
					</svg>
					{t('settings.media.configuredViaEnv')}
				</div>
			</div>
		)
	}

	return (
		<div>
			<label htmlFor={fieldId} className="block text-xs text-text-secondary mb-1">
				{label}
			</label>
			<input
				id={fieldId}
				type={password ? 'password' : 'text'}
				value={value}
				onChange={(e) => onChange(e.target.value)}
				placeholder={
					stored
						? t('settings.media.replacePlaceholder')
						: envConfigured
							? t('settings.media.overridePlaceholder')
							: placeholder || ''
				}
				className="w-full max-w-sm px-3 py-2 bg-input border border-border-strong rounded text-sm text-text font-mono focus:outline-none focus:border-border-strong"
			/>
			{stored && !value && (
				<p className="text-[11px] text-text-muted mt-1">{t('settings.media.configuredStored')}</p>
			)}
			{envConfigured && value && (
				<p className="text-[11px] text-text-muted mt-1">{t('settings.media.overridingEnv')}</p>
			)}
		</div>
	)
}
