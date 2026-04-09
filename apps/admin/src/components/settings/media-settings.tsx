import { useState, useEffect } from 'react'
import { useAuth } from '../../lib/auth'
import { api } from '../../lib/api-client'

export function MediaSettings() {
	const { currentProject, refreshProjects } = useAuth()
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

	useEffect(() => {
		if (currentProject) {
			const settings = currentProject.settings as Record<string, unknown> || {}
			setAdapter((settings.mediaAdapter as string) || 'local')
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
			alert(err instanceof Error ? err.message : 'Failed to save')
		} finally {
			setSaving(false)
		}
	}

	return (
		<div className="space-y-4">
			<div>
				<label className="block text-xs text-zinc-500 mb-1.5">Storage adapter</label>
				<select
					value={adapter}
					onChange={(e) => setAdapter(e.target.value)}
					className="w-full max-w-xs px-3 py-2 bg-white border border-zinc-300 rounded text-sm text-zinc-900 focus:outline-none focus:border-zinc-500"
				>
					<option value="local">Local filesystem</option>
					<option value="cloudflare">Cloudflare (Images + R2 + Stream)</option>
					<option value="s3">S3-compatible</option>
				</select>
			</div>

			{adapter === 'cloudflare' && (
				<div className="space-y-3 pl-0 border-l-2 border-zinc-200 pl-4">
					<CfField label="Account ID" value={cfAccountId} onChange={setCfAccountId} />
					<CfField label="API Token" value={cfApiToken} onChange={setCfApiToken} password />
					<CfField label="Images Account Hash" value={cfImagesHash} onChange={setCfImagesHash} />
					<CfField label="R2 Bucket" value={cfR2Bucket} onChange={setCfR2Bucket} />
					<CfField label="R2 Access Key ID" value={cfR2AccessKey} onChange={setCfR2AccessKey} />
					<CfField label="R2 Secret Access Key" value={cfR2SecretKey} onChange={setCfR2SecretKey} password />
					<CfField label="R2 Endpoint" value={cfR2Endpoint} onChange={setCfR2Endpoint} placeholder="https://..." />
				</div>
			)}

			{adapter === 'local' && (
				<p className="text-xs text-zinc-400">Files stored on the server filesystem. Good for development and small deployments.</p>
			)}

			<button
				type="button"
				onClick={save}
				disabled={saving}
				className="px-4 py-2 bg-zinc-900 text-white rounded text-sm font-medium hover:bg-zinc-800 disabled:opacity-50 transition-colors"
			>
				{saving ? 'Saving...' : saved ? 'Saved' : 'Save'}
			</button>
		</div>
	)
}

function CfField({ label, value, onChange, password, placeholder }: {
	label: string
	value: string
	onChange: (v: string) => void
	password?: boolean
	placeholder?: string
}) {
	return (
		<div>
			<label className="block text-xs text-zinc-500 mb-1">{label}</label>
			<input
				type={password ? 'password' : 'text'}
				value={value}
				onChange={(e) => onChange(e.target.value)}
				placeholder={placeholder || ''}
				className="w-full max-w-sm px-3 py-2 bg-white border border-zinc-300 rounded text-sm text-zinc-900 font-mono focus:outline-none focus:border-zinc-500"
			/>
		</div>
	)
}
