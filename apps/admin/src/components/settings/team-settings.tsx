import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { api } from '../../lib/api-client'
import { useAuth } from '../../lib/auth'
import { useConfirm } from '../../lib/confirm'
import { useToast } from '../../lib/toast'
import { Dropdown } from '../dropdown'
import { CollectionAccessPicker } from './collection-access-picker'

interface Member {
	id: string
	userId: string
	role: string
	createdAt: string
	userName: string
	userEmail: string
	/** null ⇒ unrestricted (full access); array ⇒ scoped to these collection ids. */
	collectionIds: string[] | null
	/**
	 * null ⇒ inherit project default; true/false ⇒ explicit override.
	 * Only meaningful when the project has `settings.requireReview === true`.
	 */
	canPublishDirectly?: boolean | null
}

interface Invite {
	id: string
	email: string
	role: string
	createdAt: string
	expiresAt: string
	accepted: boolean
	collectionIds: string[] | null
	canPublishDirectly?: boolean | null
}

const ROLES = ['viewer', 'editor', 'admin'] as const
const ROLE_ORDER: Record<string, number> = { owner: 4, admin: 3, editor: 2, viewer: 1 }

export function TeamSettings() {
	const { t } = useTranslation()
	const { currentProject, user } = useAuth()
	const toast = useToast()
	const confirm = useConfirm()
	const [members, setMembers] = useState<Member[]>([])
	const [invites, setInvites] = useState<Invite[]>([])
	const [loading, setLoading] = useState(true)
	const [email, setEmail] = useState('')
	const [role, setRole] = useState<string>('viewer')
	const [inviteCollectionIds, setInviteCollectionIds] = useState<string[] | null>(null)
	const [inviteCanPublish, setInviteCanPublish] = useState(false)

	// Reflect the project-level toggle so the per-member checkbox is only
	// surfaced when it can actually take effect.
	const projectRequiresReview =
		((currentProject?.settings as Record<string, unknown> | undefined)?.requireReview as
			| boolean
			| undefined) === true
	const [sending, setSending] = useState(false)
	const [sent, setSent] = useState('')
	const [editingMemberId, setEditingMemberId] = useState<string | null>(null)
	const [editingScope, setEditingScope] = useState<string[] | null>(null)
	const [savingScope, setSavingScope] = useState(false)

	const isAdmin = currentProject && ROLE_ORDER[currentProject.role] >= ROLE_ORDER.admin

	const roleLabel = (r: string) => {
		const key = `settings.team.roles.${r}`
		const translated = t(key)
		return translated === key ? r : translated
	}

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
			// admin/viewer/editor roles all accept a scope; the API ignores it for admin.
			await api.post('/api/v1/invites', {
				email,
				role,
				collectionIds: inviteCollectionIds,
				// Only meaningful for editor — admin always publishes, viewer never does.
				canPublishDirectly: role === 'editor' ? inviteCanPublish : null,
			})
			setSent(email)
			setEmail('')
			setInviteCollectionIds(null)
			setInviteCanPublish(false)
			setTimeout(() => setSent(''), 3000)
			fetchData()
		} catch (err) {
			toast(err instanceof Error ? err.message : t('settings.team.inviteFailed'), 'error')
		} finally {
			setSending(false)
		}
	}

	const saveMemberScope = async (userId: string) => {
		if (!currentProject) return
		setSavingScope(true)
		try {
			await api.put(`/api/v1/projects/${currentProject.id}/members/${userId}/collections`, {
				collectionIds: editingScope,
			})
			setEditingMemberId(null)
			setEditingScope(null)
			fetchData()
		} catch (err) {
			toast(err instanceof Error ? err.message : t('settings.team.updateAccessFailed'), 'error')
		} finally {
			setSavingScope(false)
		}
	}

	const updateRole = async (userId: string, newRole: string) => {
		if (!currentProject) return
		try {
			await api.put(`/api/v1/projects/${currentProject.id}/members/${userId}`, { role: newRole })
			fetchData()
		} catch (err) {
			toast(err instanceof Error ? err.message : t('settings.team.updateRoleFailed'), 'error')
		}
	}

	const updatePublishPermission = async (userId: string, canPublishDirectly: boolean | null) => {
		if (!currentProject) return
		try {
			await api.put(`/api/v1/projects/${currentProject.id}/members/${userId}`, {
				canPublishDirectly,
			})
			fetchData()
		} catch (err) {
			toast(err instanceof Error ? err.message : t('settings.team.updateRoleFailed'), 'error')
		}
	}

	const removeMember = async (userId: string, name: string) => {
		if (!currentProject) return
		const ok = await confirm({
			title: t('settings.team.removeConfirmTitle'),
			message: t('settings.team.removeConfirmMessage', { name }),
			confirmLabel: t('settings.team.removeConfirmLabel'),
			danger: true,
		})
		if (!ok) return
		try {
			await api.delete(`/api/v1/projects/${currentProject.id}/members/${userId}`)
			fetchData()
		} catch (err) {
			toast(err instanceof Error ? err.message : t('settings.team.removeFailed'), 'error')
		}
	}

	if (loading) return <p className="text-text-secondary text-sm">{t('settings.team.loading')}</p>

	const collectionsScopeLabel = (count: number) => t('settings.team.collectionsScope', { count })

	return (
		<div className="space-y-6">
			{/* Members */}
			<div>
				<h4 className="text-sm font-medium mb-3">{t('settings.team.members')}</h4>
				<div className="space-y-2">
					{members.map((m) => {
						const isOwnerOrAdmin = m.role === 'owner' || m.role === 'admin'
						const scopeLabel = isOwnerOrAdmin
							? t('settings.team.scope.fullAccess')
							: m.collectionIds === null
								? t('settings.team.scope.allCollections')
								: collectionsScopeLabel(m.collectionIds.length)
						const isEditingThis = editingMemberId === m.id
						return (
							<div key={m.id} className="rounded-lg bg-surface-alt">
								<div className="flex items-center justify-between py-2 px-3">
									<div className="min-w-0">
										<p className="text-sm truncate">{m.userName}</p>
										<p className="text-xs text-text-muted truncate">{m.userEmail}</p>
										<p className="text-[11px] text-text-muted mt-0.5">{scopeLabel}</p>
									</div>
									<div className="flex items-center gap-2 ml-3 shrink-0">
										{isAdmin && m.role !== 'owner' && m.userId !== user?.id ? (
											<Dropdown
												value={m.role}
												onChange={(v) => updateRole(m.userId, v)}
												options={ROLES.map((r) => ({ value: r, label: roleLabel(r) }))}
												className="px-2 py-1 bg-input border border-border rounded text-xs focus:outline-none"
											/>
										) : (
											<span className="px-2 py-0.5 bg-surface rounded text-xs text-text-secondary border border-border">
												{roleLabel(m.role)}
											</span>
										)}
										{isAdmin && m.role !== 'owner' && m.userId !== user?.id && (
											<>
												<button
													type="button"
													onClick={() => {
														if (isEditingThis) {
															setEditingMemberId(null)
															setEditingScope(null)
														} else {
															setEditingMemberId(m.id)
															setEditingScope(m.collectionIds)
														}
													}}
													className="text-xs text-text-secondary hover:text-text"
												>
													{isEditingThis ? t('common.cancel') : t('settings.team.editAccess')}
												</button>
												<button
													type="button"
													onClick={() => removeMember(m.userId, m.userName)}
													className="text-danger text-xs hover:opacity-80"
												>
													{t('settings.team.remove')}
												</button>
											</>
										)}
									</div>
								</div>
								{isEditingThis && (
									<div className="border-t border-border px-3 py-3 space-y-3">
										<CollectionAccessPicker
											value={editingScope}
											onChange={setEditingScope}
											disabled={isOwnerOrAdmin}
										/>
										{/* Publish permission — only surfaced for editors when the
										    project is in review mode. Admin always bypasses,
										    viewer can never publish; the toggle would be misleading
										    for either role. */}
										{projectRequiresReview && m.role === 'editor' && (
											<label className="flex items-center gap-2 text-xs cursor-pointer">
												<input
													type="checkbox"
													checked={m.canPublishDirectly === true}
													onChange={(e) =>
														updatePublishPermission(m.userId, e.target.checked ? true : null)
													}
													className="rounded"
												/>
												<span>
													{t('settings.team.canPublishDirectly', 'Can publish without review')}
												</span>
											</label>
										)}
										{!isOwnerOrAdmin && (
											<div className="flex justify-end gap-2">
												<button
													type="button"
													onClick={() => {
														setEditingMemberId(null)
														setEditingScope(null)
													}}
													className="px-3 py-1 text-xs text-text-secondary hover:text-text"
												>
													{t('common.cancel')}
												</button>
												<button
													type="button"
													onClick={() => saveMemberScope(m.userId)}
													disabled={savingScope}
													className="px-3 py-1 bg-btn-primary text-btn-primary-text rounded text-xs font-medium hover:bg-btn-primary-hover disabled:opacity-50"
												>
													{savingScope
														? t('settings.team.savingAccess')
														: t('settings.team.saveAccess')}
												</button>
											</div>
										)}
									</div>
								)}
							</div>
						)
					})}
				</div>
			</div>

			{/* Pending invites */}
			{isAdmin && invites.length > 0 && (
				<div>
					<h4 className="text-sm font-medium mb-3">{t('settings.team.pendingInvites')}</h4>
					<div className="space-y-2">
						{invites.map((inv) => {
							const scopeLabel =
								inv.role === 'admin'
									? t('settings.team.scope.fullAccess')
									: inv.collectionIds === null
										? t('settings.team.scope.allCollections')
										: collectionsScopeLabel(inv.collectionIds.length)
							return (
								<div
									key={inv.id}
									className="flex items-center justify-between py-2 px-3 rounded-lg bg-surface-alt"
								>
									<div className="min-w-0">
										<p className="text-sm truncate">{inv.email}</p>
										<p className="text-xs text-text-muted">
											{t('settings.team.expiresOn', {
												date: new Date(inv.expiresAt).toLocaleDateString(),
											})}{' '}
											· {scopeLabel}
										</p>
									</div>
									<span className="px-2 py-0.5 bg-surface rounded text-xs text-text-secondary border border-border shrink-0 ml-3">
										{roleLabel(inv.role)}
									</span>
								</div>
							)
						})}
					</div>
				</div>
			)}

			{/* Invite form */}
			{isAdmin && (
				<div>
					<h4 className="text-sm font-medium mb-3">{t('settings.team.inviteMember')}</h4>
					<div className="flex gap-2">
						<input
							type="email"
							value={email}
							onChange={(e) => setEmail(e.target.value)}
							onKeyDown={(e) => e.key === 'Enter' && sendInvite()}
							placeholder="email@example.com"
							className="flex-1 px-3 py-1.5 bg-input border border-border-strong rounded text-sm focus:outline-none focus:border-border-strong"
						/>
						<Dropdown
							value={role}
							onChange={setRole}
							options={ROLES.map((r) => ({ value: r, label: roleLabel(r) }))}
							className="w-28 shrink-0"
						/>
						<button
							type="button"
							onClick={sendInvite}
							disabled={sending || !email.trim()}
							className="px-6 py-1.5 bg-btn-primary text-btn-primary-text rounded text-sm font-medium hover:bg-btn-primary-hover disabled:opacity-50 transition-colors shrink-0"
						>
							{sending ? t('settings.team.sending') : t('settings.team.sendInvite')}
						</button>
					</div>
					<div className="mt-3 p-3 rounded-lg border border-border bg-surface">
						<p className="text-xs font-medium text-text-secondary mb-2">
							{t('settings.team.collectionAccess')}
						</p>
						<CollectionAccessPicker
							value={inviteCollectionIds}
							onChange={setInviteCollectionIds}
							disabled={role === 'admin'}
						/>
					</div>
					{projectRequiresReview && role === 'editor' && (
						<label className="flex items-center gap-2 mt-3 text-xs text-text-secondary cursor-pointer">
							<input
								type="checkbox"
								checked={inviteCanPublish}
								onChange={(e) => setInviteCanPublish(e.target.checked)}
								className="rounded"
							/>
							<span>
								{t(
									'settings.team.invite.canPublishDirectly',
									'Let this editor publish without review',
								)}
							</span>
						</label>
					)}
					{sent && (
						<p className="text-xs text-text-secondary mt-2">
							{t('settings.team.inviteSent', { email: sent })}
						</p>
					)}
				</div>
			)}
		</div>
	)
}
