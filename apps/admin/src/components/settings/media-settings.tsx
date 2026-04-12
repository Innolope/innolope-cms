import { useState, useEffect, useRef } from 'react'
import { useAuth } from '../../lib/auth'
import { api } from '../../lib/api-client'
import { useToast } from '../../lib/toast'
import { SaveBar } from '../save-bar'
import { Dropdown } from '../dropdown'

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
	const initialAdapter = useRef('local')

	useEffect(() => {
		if (currentProject) {
			const settings = currentProject.settings as Record<string, unknown> || {}
			const a = (settings.mediaAdapter as string) || 'local'
			setAdapter(a)
			initialAdapter.current = a
			const cf = (settings.cloudflare as Record<string, string>) || {}
			setCfAccountId(cf.accountId || '')
			setCfApiToken(cf.apiToken || '')
			setCfImagesHash(cf.imagesAccountHash || '')
			setCfR2Bucket(cf.r2Bucket || '')
			setCfR2AccessKey(cf.r2AccessKeyId || '')
			setCfR2SecretKey(cf.r2SecretAccessKey || '')
			setCfR2Endpoint(cf.r2Endpoint || '')
		}
	}, [currentProject])

	// Fetch env config to know which fields are pre-configured
	useEffect(() => {
		api.get<MediaEnvConfig>('/api/v1/media/config')
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
					cloudflare: adapter === 'cloudflare' ? {
						accountId: cfAccountId,
						apiToken: cfApiToken,
						imagesAccountHash: cfImagesHash,
						r2Bucket: cfR2Bucket,
						r2AccessKeyId: cfR2AccessKey,
						r2SecretAccessKey: cfR2SecretKey,
						r2Endpoint: cfR2Endpoint,
					} : undefined,
				},
			})
			setSaved(true)
			setTimeout(() => setSaved(false), 2000)
			await refreshProjects()
		} catch (err) {
			toast(err instanceof Error ? err.message : 'Failed to save', 'error')
		} finally {
			setSaving(false)
		}
	}

	const allCfEnvSet = envConfig?.env
		&& envConfig.env.accountId
		&& envConfig.env.apiToken
		&& envConfig.env.imagesAccountHash

	return (
		<div className="space-y-4">
			<div>
				<label className="block text-xs text-text-secondary mb-1.5">Storage adapter</label>
				{adapterSetViaEnv ? (
					<div>
						<p className="text-sm font-medium text-text">{
							effectiveAdapter === 'cloudflare' ? 'Cloudflare (Images + R2 + Stream)'
								: effectiveAdapter === 's3' ? 'S3-compatible'
								: effectiveAdapter
						}</p>
						<p className="text-xs text-text-muted mt-1">
							Set via environment variable <code className="bg-surface-alt px-1 rounded">MEDIA_ADAPTER</code>
						</p>
					</div>
				) : (
					<Dropdown
						value={adapter}
						onChange={setAdapter}
						options={[
							{ value: 'local', label: 'Local filesystem' },
							{ value: 'cloudflare', label: 'Cloudflare (Images + R2 + Stream)' },
							{ value: 's3', label: 'S3-compatible' },
						]}
						className="w-full max-w-xs"
					/>
				)}
			</div>

			{effectiveAdapter === 'cloudflare' && (
				allCfEnvSet ? (
					<div className="rounded-lg bg-surface-alt border border-border p-4">
						<div className="flex items-center gap-2 mb-2">
							<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-accent"><polyline points="20 6 9 17 4 12" /></svg>
							<p className="text-sm font-medium text-text">Cloudflare credentials configured via environment</p>
						</div>
						<p className="text-xs text-text-muted">
							All required Cloudflare credentials are set as environment variables on the server.
							No additional configuration is needed.
						</p>
					</div>
				) : (
					<div className="space-y-3 border-l-2 border-border pl-4">
						<CfField label="Account ID" value={cfAccountId} onChange={setCfAccountId} envConfigured={envConfig?.env.accountId} />
						<CfField label="API Token" value={cfApiToken} onChange={setCfApiToken} password envConfigured={envConfig?.env.apiToken} />
						<CfField label="Images Account Hash" value={cfImagesHash} onChange={setCfImagesHash} envConfigured={envConfig?.env.imagesAccountHash} />
						<CfField label="R2 Bucket" value={cfR2Bucket} onChange={setCfR2Bucket} envConfigured={envConfig?.env.r2Bucket} />
						<CfField label="R2 Access Key ID" value={cfR2AccessKey} onChange={setCfR2AccessKey} envConfigured={envConfig?.env.r2AccessKeyId} />
						<CfField label="R2 Secret Access Key" value={cfR2SecretKey} onChange={setCfR2SecretKey} password envConfigured={envConfig?.env.r2SecretAccessKey} />
						<CfField label="R2 Endpoint" value={cfR2Endpoint} onChange={setCfR2Endpoint} placeholder="https://..." envConfigured={envConfig?.env.r2Endpoint} />
					</div>
				)
			)}

			{effectiveAdapter === 'local' && (
				<p className="text-xs text-text-muted">Files stored on the server filesystem. Good for development and small deployments.</p>
			)}

			{!adapterSetViaEnv && (
				<SaveBar dirty={dirty} saving={saving} saved={saved} onSave={save} />
			)}
		</div>
	)
}

function CfField({ label, value, onChange, password, placeholder, envConfigured }: {
	label: string
	value: string
	onChange: (v: string) => void
	password?: boolean
	placeholder?: string
	envConfigured?: boolean
}) {
	if (envConfigured && !value) {
		return (
			<div>
				<label className="block text-xs text-text-secondary mb-1">{label}</label>
				<div className="flex items-center gap-2 px-3 py-2 bg-surface-alt border border-border rounded text-sm text-text-muted">
					<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0">
						<rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
						<path d="M7 11V7a5 5 0 0110 0v4" />
					</svg>
					Configured via environment
				</div>
			</div>
		)
	}

	return (
		<div>
			<label className="block text-xs text-text-secondary mb-1">{label}</label>
			<input
				type={password ? 'password' : 'text'}
				value={value}
				onChange={(e) => onChange(e.target.value)}
				placeholder={envConfigured ? 'Override environment value...' : (placeholder || '')}
				className="w-full max-w-sm px-3 py-2 bg-input border border-border-strong rounded text-sm text-text font-mono focus:outline-none focus:border-border-strong"
			/>
			{envConfigured && value && (
				<p className="text-[11px] text-text-muted mt-1">Overriding environment variable</p>
			)}
		</div>
	)
}
