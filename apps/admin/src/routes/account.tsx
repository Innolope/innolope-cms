import { createFileRoute } from '@tanstack/react-router'
import { useState, useRef } from 'react'
import { api } from '../lib/api-client'
import { useAuth } from '../lib/auth'
import { useTheme } from '../lib/theme'
import { SaveBar } from '../components/save-bar'

export const Route = createFileRoute('/account')({
	component: AccountSettings,
})

type AccountTab = 'profile' | 'password' | 'appearance'

const TABS: { id: AccountTab; label: string }[] = [
	{ id: 'profile', label: 'Profile' },
	{ id: 'password', label: 'Password' },
	{ id: 'appearance', label: 'Appearance' },
]

function AccountSettings() {
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

	return (
		<div className="p-8 pt-5">
			<h2 className="text-2xl font-bold mb-6">Account</h2>

			<div className="flex border-b border-border mb-8">
				{TABS.map((t) => (
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
				<div className={tab === 'appearance' ? '' : 'hidden'}><AppearanceSettings /></div>
			</div>
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
