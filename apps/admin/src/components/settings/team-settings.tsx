import { useState, useEffect, useCallback } from 'react'
import { useAuth } from '../../lib/auth'
import { api } from '../../lib/api-client'
import { useToast } from '../../lib/toast'
import { Dropdown } from '../dropdown'

interface Member {
	id: string
	userId: string
	role: string
	createdAt: string
	userName: string
	userEmail: string
}

interface Invite {
	id: string
	email: string
	role: string
	createdAt: string
	expiresAt: string
	accepted: boolean
}

const ROLES = ['viewer', 'editor', 'admin'] as const
const ROLE_ORDER: Record<string, number> = { owner: 4, admin: 3, editor: 2, viewer: 1 }

export function TeamSettings() {
	const { currentProject, user } = useAuth()
	const toast = useToast()
	const [members, setMembers] = useState<Member[]>([])
	const [invites, setInvites] = useState<Invite[]>([])
	const [loading, setLoading] = useState(true)
	const [email, setEmail] = useState('')
	const [role, setRole] = useState<string>('viewer')
	const [sending, setSending] = useState(false)
	const [sent, setSent] = useState('')

	const isAdmin = currentProject && ROLE_ORDER[currentProject.role] >= ROLE_ORDER.admin

	const fetchData = useCallback(async () => {
		if (!currentProject) return
		setLoading(true)
		try {
			const [m, i] = await Promise.all([
				api.get<Member[]>(`/api/v1/projects/${currentProject.id}/members`),
				isAdmin ? api.get<Invite[]>('/api/v1/invites') : Promise.resolve([]),
			])
			setMembers(m)
			setInvites((i as Invite[]).filter((inv) => !inv.accepted))
		} catch {
			// silent
		} finally {
			setLoading(false)
		}
	}, [currentProject, isAdmin])

	useEffect(() => {
		fetchData()
	}, [fetchData])

	const sendInvite = async () => {
		if (!email.trim()) return
		setSending(true)
		try {
			await api.post('/api/v1/invites', { email, role })
			setSent(email)
			setEmail('')
			setTimeout(() => setSent(''), 3000)
			fetchData()
		} catch (err) {
			toast(err instanceof Error ? err.message : 'Failed to send invite', 'error')
		} finally {
			setSending(false)
		}
	}

	const updateRole = async (userId: string, newRole: string) => {
		if (!currentProject) return
		try {
			await api.put(`/api/v1/projects/${currentProject.id}/members/${userId}`, { role: newRole })
			fetchData()
		} catch (err) {
			toast(err instanceof Error ? err.message : 'Failed to update role', 'error')
		}
	}

	const removeMember = async (userId: string, name: string) => {
		if (!currentProject) return
		if (!confirm(`Remove ${name} from this project?`)) return
		try {
			await api.delete(`/api/v1/projects/${currentProject.id}/members/${userId}`)
			fetchData()
		} catch (err) {
			toast(err instanceof Error ? err.message : 'Failed to remove member', 'error')
		}
	}

	if (loading) return <p className="text-text-secondary text-sm">Loading team...</p>

	return (
		<div className="space-y-6">
			{/* Members */}
			<div>
				<h4 className="text-sm font-medium mb-3">Members</h4>
				<div className="space-y-2">
					{members.map((m) => (
						<div key={m.id} className="flex items-center justify-between py-2 px-3 rounded-lg bg-surface-alt">
							<div className="min-w-0">
								<p className="text-sm truncate">{m.userName}</p>
								<p className="text-xs text-text-muted truncate">{m.userEmail}</p>
							</div>
							<div className="flex items-center gap-2 ml-3 shrink-0">
								{isAdmin && m.role !== 'owner' && m.userId !== user?.id ? (
									<Dropdown
										value={m.role}
										onChange={(v) => updateRole(m.userId, v)}
										options={ROLES.map((r) => ({ value: r, label: r }))}
										className="px-2 py-1 bg-input border border-border rounded text-xs focus:outline-none"
									/>
								) : (
									<span className="px-2 py-0.5 bg-surface rounded text-xs text-text-secondary border border-border">
										{m.role}
									</span>
								)}
								{isAdmin && m.role !== 'owner' && m.userId !== user?.id && (
									<button
										type="button"
										onClick={() => removeMember(m.userId, m.userName)}
										className="text-danger text-xs hover:opacity-80"
									>
										Remove
									</button>
								)}
							</div>
						</div>
					))}
				</div>
			</div>

			{/* Pending invites */}
			{isAdmin && invites.length > 0 && (
				<div>
					<h4 className="text-sm font-medium mb-3">Pending Invites</h4>
					<div className="space-y-2">
						{invites.map((inv) => (
							<div key={inv.id} className="flex items-center justify-between py-2 px-3 rounded-lg bg-surface-alt">
								<div className="min-w-0">
									<p className="text-sm truncate">{inv.email}</p>
									<p className="text-xs text-text-muted">
										Expires {new Date(inv.expiresAt).toLocaleDateString()}
									</p>
								</div>
								<span className="px-2 py-0.5 bg-surface rounded text-xs text-text-secondary border border-border shrink-0 ml-3">
									{inv.role}
								</span>
							</div>
						))}
					</div>
				</div>
			)}

			{/* Invite form */}
			{isAdmin && (
				<div>
					<h4 className="text-sm font-medium mb-3">Invite Member</h4>
					<div className="flex gap-2">
						<input
							type="email"
							value={email}
							onChange={(e) => setEmail(e.target.value)}
							onKeyDown={(e) => e.key === 'Enter' && sendInvite()}
							placeholder="email@example.com"
							className="flex-1 px-3 py-2.5 bg-input border border-border-strong rounded text-sm focus:outline-none focus:border-border-strong"
						/>
						<Dropdown
							value={role}
							onChange={setRole}
							options={ROLES.map((r) => ({ value: r, label: r }))}
							className="w-28 shrink-0"
						/>
						<button
							type="button"
							onClick={sendInvite}
							disabled={sending || !email.trim()}
							className="px-6 py-2.5 bg-btn-primary text-btn-primary-text rounded text-sm font-medium hover:bg-btn-primary-hover disabled:opacity-50 transition-colors shrink-0"
						>
							{sending ? 'Sending...' : 'Send Invite'}
						</button>
					</div>
					{sent && (
						<p className="text-xs text-text-secondary mt-2">Invite sent to {sent}</p>
					)}
				</div>
			)}
		</div>
	)
}
