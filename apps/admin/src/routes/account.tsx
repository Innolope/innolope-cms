import { createFileRoute } from '@tanstack/react-router'
import { useState } from 'react'
import { api } from '../lib/api-client'
import { useAuth } from '../lib/auth'
import { useTheme } from '../lib/theme'

export const Route = createFileRoute('/account')({
	component: AccountSettings,
})

function AccountSettings() {
	return (
		<div className="p-8 max-w-4xl">
			<h2 className="text-2xl font-bold mb-8">Account</h2>
			<div className="space-y-8">
				<Section title="Profile">
					<ProfileSettings />
				</Section>
				<Section title="Password">
					<PasswordSettings />
				</Section>
				<Section title="Appearance">
					<AppearanceSettings />
				</Section>
			</div>
		</div>
	)
}

function ProfileSettings() {
	const { user, refreshUser } = useAuth()
	const [name, setName] = useState(user?.name || '')
	const [email, setEmail] = useState(user?.email || '')
	const [saving, setSaving] = useState(false)
	const [message, setMessage] = useState('')

	const save = async () => {
		setSaving(true)
		setMessage('')
		try {
			await api.put('/api/v1/auth/profile', { name, email })
			await refreshUser()
			setMessage('Profile updated')
		} catch (err) {
			setMessage(err instanceof Error ? err.message : 'Failed to save')
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
			<div className="flex items-center gap-3">
				<button
					type="button"
					onClick={save}
					disabled={saving}
					className="px-4 py-2 bg-btn-primary text-btn-primary-text rounded text-sm font-medium hover:bg-btn-primary-hover disabled:opacity-50"
				>
					{saving ? 'Saving...' : 'Save'}
				</button>
				{message && <p className="text-sm text-text-secondary">{message}</p>}
			</div>
		</div>
	)
}

function PasswordSettings() {
	const [currentPassword, setCurrentPassword] = useState('')
	const [newPassword, setNewPassword] = useState('')
	const [confirmPassword, setConfirmPassword] = useState('')
	const [saving, setSaving] = useState(false)
	const [message, setMessage] = useState('')
	const [isError, setIsError] = useState(false)

	const save = async () => {
		setMessage('')
		setIsError(false)

		if (!currentPassword || !newPassword) {
			setMessage('All fields are required')
			setIsError(true)
			return
		}
		if (newPassword.length < 8) {
			setMessage('New password must be at least 8 characters')
			setIsError(true)
			return
		}
		if (newPassword !== confirmPassword) {
			setMessage('Passwords do not match')
			setIsError(true)
			return
		}

		setSaving(true)
		try {
			await api.post('/api/v1/auth/change-password', { currentPassword, newPassword })
			setCurrentPassword('')
			setNewPassword('')
			setConfirmPassword('')
			setMessage('Password updated')
			setIsError(false)
		} catch (err) {
			setMessage(err instanceof Error ? err.message : 'Failed to change password')
			setIsError(true)
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
			<div className="flex items-center gap-3">
				<button
					type="button"
					onClick={save}
					disabled={saving}
					className="px-4 py-2 bg-btn-primary text-btn-primary-text rounded text-sm font-medium hover:bg-btn-primary-hover disabled:opacity-50"
				>
					{saving ? 'Saving...' : 'Change Password'}
				</button>
				{message && (
					<p className={`text-sm ${isError ? 'text-danger' : 'text-text-secondary'}`}>{message}</p>
				)}
			</div>
		</div>
	)
}

function AppearanceSettings() {
	const { theme, setTheme } = useTheme()

	return (
		<div className="space-y-3">
			<label className="block text-xs text-text-secondary mb-1.5">Theme</label>
			<div className="flex gap-2">
				<button
					type="button"
					onClick={() => setTheme('light')}
					className={`px-4 py-2 rounded text-sm font-medium transition-colors ${
						theme === 'light'
							? 'bg-btn-primary text-btn-primary-text'
							: 'bg-btn-secondary text-text-secondary hover:bg-btn-secondary-hover'
					}`}
				>
					Light
				</button>
				<button
					type="button"
					onClick={() => setTheme('dark')}
					className={`px-4 py-2 rounded text-sm font-medium transition-colors ${
						theme === 'dark'
							? 'bg-btn-primary text-btn-primary-text'
							: 'bg-btn-secondary text-text-secondary hover:bg-btn-secondary-hover'
					}`}
				>
					Dark
				</button>
			</div>
		</div>
	)
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
	return (
		<div className="rounded-lg border border-border p-6">
			<h3 className="text-lg font-semibold mb-2">{title}</h3>
			{children}
		</div>
	)
}
