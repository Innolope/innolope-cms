import { createFileRoute } from '@tanstack/react-router'
import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '../lib/api-client'
import { useAuth } from '../lib/auth'
import { useTheme } from '../lib/theme'
import { SaveBar } from '../components/save-bar'
import { hasFeature, useLicense } from '../components/license-gate'

export const Route = createFileRoute('/account')({
	component: AccountSettings,
})

type AccountTab = 'profile' | 'password' | 'sso' | 'appearance'

const TABS: { id: AccountTab; label: string; pro?: string }[] = [
	{ id: 'profile', label: 'Profile' },
	{ id: 'password', label: 'Password' },
	{ id: 'sso', label: 'Linked Accounts', pro: 'sso' },
	{ id: 'appearance', label: 'Appearance' },
]

function AccountSettings() {
	const license = useLicense()
	const [tab, setTabState] = useState<AccountTab>(() => {
		const params = new URLSearchParams(window.location.search)
		return (params.get('tab') as AccountTab) || 'profile'
	})

	const setTab = (t: AccountTab) => {
		setTabState(t)
		const url = new URL(window.location.href)
		url.searchParams.set('tab', t)
		window.history.replaceState({}, '', url.toString())
	}

	const visibleTabs = TABS.filter((t) => !t.pro || hasFeature(license, t.pro))

	return (
		<div className="p-8 pt-5">
			<h2 className="text-2xl font-bold mb-6">Account</h2>

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
					</button>
				))}
			</div>

			<div className="max-w-xl">
				<div className={tab === 'profile' ? '' : 'hidden'}><ProfileSettings /></div>
				<div className={tab === 'password' ? '' : 'hidden'}><PasswordSettings /></div>
				<div className={tab === 'sso' ? '' : 'hidden'}><SsoIdentitiesSettings /></div>
				<div className={tab === 'appearance' ? '' : 'hidden'}><AppearanceSettings /></div>
			</div>
		</div>
	)
}

interface LinkedIdentity {
	id: string
	connectionId: string
	provider: 'saml' | 'oidc'
	email: string | null
	lastLoginAt: string | null
	createdAt: string
	connectionName: string | null
	connectionSlug: string | null
	projectId: string | null
}

function SsoIdentitiesSettings() {
	const [items, setItems] = useState<LinkedIdentity[]>([])
	const [loading, setLoading] = useState(true)
	const [availableConnections, setAvailableConnections] = useState<Array<{ id: string; slug: string; name: string; protocol: string }>>([])

	const refresh = useCallback(async () => {
		try {
			const data = await api.get<LinkedIdentity[]>('/api/v1/auth/me/identities')
			setItems(data)
		} catch {
			// license disabled → ignore
		}
		try {
			const conns = await api.get<Array<{ id: string; slug: string; name: string; protocol: string }>>('/api/v1/ee/sso/connections')
			setAvailableConnections(conns)
		} catch {
			setAvailableConnections([])
		}
		setLoading(false)
	}, [])

	useEffect(() => {
		refresh()
	}, [refresh])

	const unlink = async (id: string) => {
		if (!confirm('Unlink this SSO identity?')) return
		try {
			await api.delete(`/api/v1/auth/me/identities/${id}`)
			await refresh()
		} catch (err) {
			alert(err instanceof Error ? err.message : 'Failed to unlink')
		}
	}

	const link = (slug: string) => {
		const next = `${window.location.pathname}?tab=sso`
		window.location.href = `/api/v1/auth/sso/${encodeURIComponent(slug)}/initiate?intent=link&next=${encodeURIComponent(next)}`
	}

	if (loading) return <p className="text-text-secondary text-sm">Loading...</p>

	const linkedConnIds = new Set(items.map((i) => i.connectionId))
	const linkable = availableConnections.filter((c) => !linkedConnIds.has(c.id))

	return (
		<div className="space-y-5">
			<p className="text-sm text-text-secondary">
				Identities from your identity provider that are linked to this account. Linking an SSO
				identity lets you sign in without a password.
			</p>

			{items.length === 0 ? (
				<div className="text-sm text-text-secondary py-3">No SSO identities linked yet.</div>
			) : (
				<div className="space-y-2">
					{items.map((i) => (
						<div key={i.id} className="flex items-center justify-between py-2 px-3 rounded-lg bg-surface-alt">
							<div className="min-w-0">
								<p className="text-sm">{i.connectionName ?? 'Unknown'} <span className="text-xs uppercase text-text-muted ml-2">{i.provider}</span></p>
								<p className="text-xs text-text-muted truncate">{i.email ?? '(no email in profile)'}</p>
								{i.lastLoginAt && (
									<p className="text-xs text-text-muted">Last sign-in: {new Date(i.lastLoginAt).toLocaleString()}</p>
								)}
							</div>
							<button
								type="button"
								onClick={() => unlink(i.id)}
								className="px-2 py-1 text-xs text-danger hover:opacity-80 shrink-0"
							>
								Unlink
							</button>
						</div>
					))}
				</div>
			)}

			{linkable.length > 0 && (
				<div className="pt-4 border-t border-border">
					<h4 className="text-sm font-medium mb-3">Link a new identity</h4>
					<div className="space-y-2">
						{linkable.map((c) => (
							<button
								key={c.id}
								type="button"
								onClick={() => link(c.slug)}
								className="w-full flex items-center justify-between px-3 py-2 border border-border rounded-lg hover:bg-surface-alt text-sm"
							>
								<span>{c.name} <span className="text-xs uppercase text-text-muted ml-2">{c.protocol}</span></span>
								<span className="text-xs text-text-muted">Link →</span>
							</button>
						))}
					</div>
				</div>
			)}
		</div>
	)
}

function ProfileSettings() {
	const { user, refreshUser } = useAuth()
	const [name, setName] = useState(user?.name || '')
	const [email, setEmail] = useState(user?.email || '')
	const [saving, setSaving] = useState(false)
	const [saved, setSaved] = useState(false)
	const initialRef = useRef({ name: user?.name || '', email: user?.email || '' })

	const dirty = name !== initialRef.current.name || email !== initialRef.current.email

	const save = async () => {
		setSaving(true)
		try {
			await api.put('/api/v1/auth/profile', { name, email })
			await refreshUser()
			initialRef.current = { name, email }
			setSaved(true)
			setTimeout(() => setSaved(false), 2000)
		} catch (err) {
			// handled by toast if needed
		} finally {
			setSaving(false)
		}
	}

	return (
		<div className="space-y-4">
			<div>
				<label className="block text-xs text-text-secondary mb-1.5">Name</label>
				<input
					type="text"
					value={name}
					onChange={(e) => setName(e.target.value)}
					className="w-full max-w-sm px-3 py-2 bg-input border border-border-strong rounded text-sm text-text focus:outline-none focus:border-border-strong"
				/>
			</div>
			<div>
				<label className="block text-xs text-text-secondary mb-1.5">Email</label>
				<input
					type="email"
					value={email}
					onChange={(e) => setEmail(e.target.value)}
					className="w-full max-w-sm px-3 py-2 bg-input border border-border-strong rounded text-sm text-text focus:outline-none focus:border-border-strong"
				/>
			</div>
			<SaveBar dirty={dirty} saving={saving} saved={saved} onSave={save} onReset={() => {
				setName(initialRef.current.name)
				setEmail(initialRef.current.email)
			}} />
		</div>
	)
}

function PasswordSettings() {
	const [currentPassword, setCurrentPassword] = useState('')
	const [newPassword, setNewPassword] = useState('')
	const [confirmPassword, setConfirmPassword] = useState('')
	const [saving, setSaving] = useState(false)
	const [saved, setSaved] = useState(false)
	const [error, setError] = useState('')

	const dirty = currentPassword.length > 0 || newPassword.length > 0 || confirmPassword.length > 0
	const valid = currentPassword.length > 0 && newPassword.length >= 8 && newPassword === confirmPassword

	const save = async () => {
		setError('')
		if (!valid) {
			if (!currentPassword || !newPassword) setError('All fields are required')
			else if (newPassword.length < 8) setError('New password must be at least 8 characters')
			else if (newPassword !== confirmPassword) setError('Passwords do not match')
			return
		}

		setSaving(true)
		try {
			await api.post('/api/v1/auth/change-password', { currentPassword, newPassword })
			setCurrentPassword('')
			setNewPassword('')
			setConfirmPassword('')
			setSaved(true)
			setTimeout(() => setSaved(false), 2000)
		} catch (err) {
			setError(err instanceof Error ? err.message : 'Failed to change password')
		} finally {
			setSaving(false)
		}
	}

	return (
		<div className="space-y-4">
			<div>
				<label className="block text-xs text-text-secondary mb-1.5">Current password</label>
				<input
					type="password"
					value={currentPassword}
					onChange={(e) => setCurrentPassword(e.target.value)}
					className="w-full max-w-sm px-3 py-2 bg-input border border-border-strong rounded text-sm text-text focus:outline-none focus:border-border-strong"
				/>
			</div>
			<div>
				<label className="block text-xs text-text-secondary mb-1.5">New password</label>
				<input
					type="password"
					value={newPassword}
					onChange={(e) => setNewPassword(e.target.value)}
					className="w-full max-w-sm px-3 py-2 bg-input border border-border-strong rounded text-sm text-text focus:outline-none focus:border-border-strong"
				/>
			</div>
			<div>
				<label className="block text-xs text-text-secondary mb-1.5">Confirm new password</label>
				<input
					type="password"
					value={confirmPassword}
					onChange={(e) => setConfirmPassword(e.target.value)}
					className="w-full max-w-sm px-3 py-2 bg-input border border-border-strong rounded text-sm text-text focus:outline-none focus:border-border-strong"
				/>
			</div>
			{error && <p className="text-sm text-danger">{error}</p>}
			<SaveBar dirty={dirty && valid} saving={saving} saved={saved} onSave={save} saveLabel="Change Password" onReset={() => {
				setCurrentPassword('')
				setNewPassword('')
				setConfirmPassword('')
				setError('')
			}} />
		</div>
	)
}

function AppearanceSettings() {
	const { theme, setTheme } = useTheme()

	return (
		<div className="space-y-3">
			<label className="block text-xs text-text-secondary mb-1.5">Theme</label>
			<div className="flex gap-2 max-w-sm">
				{(['light', 'dark', 'system'] as const).map((t) => (
					<button
						key={t}
						type="button"
						onClick={() => setTheme(t)}
						className={`flex-1 py-2 rounded text-sm font-medium transition-colors capitalize ${
							theme === t
								? 'bg-btn-primary text-btn-primary-text'
								: 'bg-btn-secondary text-text-secondary hover:bg-btn-secondary-hover'
						}`}
					>
						{t}
					</button>
				))}
			</div>
		</div>
	)
}
