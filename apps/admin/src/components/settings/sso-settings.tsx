import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { api } from '../../lib/api-client'
import { useConfirm } from '../../lib/confirm'
import { useToast } from '../../lib/toast'
import { Dropdown } from '../dropdown'

type Protocol = 'saml' | 'oidc'

interface Connection {
	id: string
	projectId: string
	protocol: Protocol
	name: string
	slug: string
	enabled: boolean
	enforceSso: boolean
	allowIdpInitiated: boolean
	domains: string[]
	oidcIssuer: string | null
	oidcClientId: string | null
	hasClientSecret: boolean
	oidcScopes: string[]
	samlEntityId: string | null
	samlSsoUrl: string | null
	samlIdpCertPems: string[]
	samlWantAssertionsSigned: boolean
	samlWantAssertionsEncrypted: boolean
	attrEmail: string
	attrName: string
	attrGroups: string
	defaultRole: 'admin' | 'editor' | 'viewer'
	groupRoleMap: Record<string, 'admin' | 'editor' | 'viewer'>
}

type ConnectionDraft = Partial<Connection> & { oidcClientSecret?: string }

const EMPTY: ConnectionDraft = {
	protocol: 'oidc',
	name: '',
	slug: '',
	enabled: false,
	enforceSso: false,
	allowIdpInitiated: false,
	domains: [],
	oidcScopes: ['openid', 'email', 'profile'],
	samlIdpCertPems: [],
	samlWantAssertionsSigned: true,
	samlWantAssertionsEncrypted: false,
	attrEmail: 'email',
	attrName: 'name',
	attrGroups: 'groups',
	defaultRole: 'viewer',
	groupRoleMap: {},
}

export function SsoSettings() {
	const { t } = useTranslation()
	const toast = useToast()
	const confirm = useConfirm()
	const [connections, setConnections] = useState<Connection[]>([])
	const [loading, setLoading] = useState(true)
	const [editing, setEditing] = useState<ConnectionDraft | null>(null)
	const [saving, setSaving] = useState(false)

	const fetchConnections = useCallback(async () => {
		try {
			const data = await api.get<Connection[]>('/api/v1/ee/sso/connections')
			setConnections(data)
		} catch (err) {
			toast(err instanceof Error ? err.message : t('settings.sso.loadFailed'), 'error')
		} finally {
			setLoading(false)
		}
	}, [toast, t])

	useEffect(() => {
		fetchConnections()
	}, [fetchConnections])

	const save = async () => {
		if (!editing) return
		if (!editing.name?.trim() || !editing.slug?.trim()) {
			toast(t('settings.sso.nameSlugRequired'), 'error')
			return
		}
		setSaving(true)
		try {
			if (editing.id) {
				await api.put(`/api/v1/ee/sso/connections/${editing.id}`, editing)
			} else {
				await api.post('/api/v1/ee/sso/connections', editing)
			}
			setEditing(null)
			await fetchConnections()
		} catch (err) {
			toast(err instanceof Error ? err.message : t('settings.sso.saveFailed'), 'error')
		} finally {
			setSaving(false)
		}
	}

	const remove = async (id: string, name: string) => {
		const ok = await confirm({
			title: t('settings.sso.deleteConfirmTitle'),
			message: t('settings.sso.deleteConfirmMessage'),
			requireText: name,
			confirmLabel: t('settings.sso.deleteConfirmLabel'),
			danger: true,
		})
		if (!ok) return
		try {
			await api.delete(`/api/v1/ee/sso/connections/${id}`)
			await fetchConnections()
		} catch (err) {
			toast(err instanceof Error ? err.message : t('settings.sso.deleteFailed'), 'error')
		}
	}

	if (loading) return <p className="text-text-secondary text-sm">{t('settings.sso.loading')}</p>

	if (editing) {
		return (
			<ConnectionForm
				draft={editing}
				onChange={setEditing}
				onCancel={() => setEditing(null)}
				onSave={save}
				saving={saving}
			/>
		)
	}

	return (
		<div className="space-y-4">
			<div className="flex items-center justify-between">
				<p className="text-sm text-text-secondary">{t('settings.sso.intro')}</p>
				<button
					type="button"
					onClick={() => setEditing(EMPTY)}
					className="px-3 py-1.5 bg-btn-primary text-btn-primary-text rounded text-sm font-medium hover:bg-btn-primary-hover shrink-0 ml-4"
				>
					{t('settings.sso.addConnection')}
				</button>
			</div>

			{connections.length === 0 ? (
				<div className="text-center py-10 border border-dashed border-border rounded-lg text-text-secondary text-sm">
					{t('settings.sso.empty')}
				</div>
			) : (
				<div className="space-y-2">
					{connections.map((c) => (
						<div key={c.id} className="border border-border rounded-lg p-4 bg-surface-alt">
							<div className="flex items-start justify-between gap-4">
								<div className="min-w-0">
									<div className="flex items-center gap-2">
										<span className="font-medium">{c.name}</span>
										<span className="text-xs uppercase tracking-wide px-1.5 py-0.5 rounded bg-surface border border-border text-text-secondary">
											{c.protocol}
										</span>
										{c.enabled ? (
											<span className="text-xs px-1.5 py-0.5 rounded bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200">
												{t('settings.sso.statusEnabled')}
											</span>
										) : (
											<span className="text-xs px-1.5 py-0.5 rounded bg-surface border border-border text-text-muted">
												{t('settings.sso.statusDisabled')}
											</span>
										)}
										{c.enforceSso && (
											<span className="text-xs px-1.5 py-0.5 rounded bg-amber-100 text-amber-800 dark:bg-amber-900 dark:text-amber-200">
												{t('settings.sso.statusEnforced')}
											</span>
										)}
									</div>
									<p className="text-xs text-text-muted mt-1">
										{c.domains.length > 0
											? t('settings.sso.domainsList', { domains: c.domains.join(', ') })
											: t('settings.sso.noDomainFilter')}
									</p>
									<p className="text-xs text-text-muted mt-0.5 font-mono">
										{t('settings.sso.slugLabel', { slug: c.slug })}
									</p>
								</div>
								<div className="flex items-center gap-2 shrink-0">
									<button
										type="button"
										onClick={() => setEditing({ ...c, oidcClientSecret: undefined })}
										className="px-2 py-1 text-xs bg-btn-secondary text-text-secondary rounded hover:bg-btn-secondary-hover"
									>
										{t('settings.sso.edit')}
									</button>
									<button
										type="button"
										onClick={() => remove(c.id, c.name)}
										className="px-2 py-1 text-xs text-danger hover:opacity-80"
									>
										{t('settings.sso.delete')}
									</button>
								</div>
							</div>
						</div>
					))}
				</div>
			)}
		</div>
	)
}

function ConnectionForm({
	draft,
	onChange,
	onCancel,
	onSave,
	saving,
}: {
	draft: ConnectionDraft
	onChange: (d: ConnectionDraft) => void
	onCancel: () => void
	onSave: () => void
	saving: boolean
}) {
	const { t } = useTranslation()
	const set = <K extends keyof ConnectionDraft>(k: K, v: ConnectionDraft[K]) =>
		onChange({ ...draft, [k]: v })

	const domainsStr = (draft.domains ?? []).join(', ')

	const roleLabel = (r: string) => {
		const key = `settings.sso.roles.${r}`
		const translated = t(key)
		return translated === key ? r : translated
	}

	return (
		<div className="space-y-5 max-w-2xl">
			<div className="flex items-center justify-between">
				<h3 className="text-lg font-semibold">
					{draft.id ? t('settings.sso.editTitle') : t('settings.sso.newTitle')}
				</h3>
				<button
					type="button"
					onClick={onCancel}
					className="text-sm text-text-secondary hover:text-text"
				>
					{t('common.cancel')}
				</button>
			</div>

			<Field label={t('settings.sso.fields.displayName')}>
				<input
					type="text"
					value={draft.name ?? ''}
					onChange={(e) => set('name', e.target.value)}
					className="w-full px-3 py-2 bg-input border border-border rounded text-sm"
					placeholder="Acme Okta"
				/>
			</Field>

			<Field label={t('settings.sso.fields.slug')}>
				<input
					type="text"
					value={draft.slug ?? ''}
					onChange={(e) => set('slug', e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '-'))}
					className="w-full px-3 py-2 bg-input border border-border rounded text-sm font-mono"
					placeholder="acme"
					disabled={Boolean(draft.id)}
				/>
			</Field>

			<Field label={t('settings.sso.fields.protocol')}>
				{draft.id ? (
					<input
						type="text"
						value={draft.protocol ?? 'oidc'}
						disabled
						className="w-full px-3 py-2 bg-input border border-border rounded text-sm font-mono opacity-60"
					/>
				) : (
					<Dropdown
						value={draft.protocol ?? 'oidc'}
						onChange={(v) => set('protocol', v as Protocol)}
						options={[
							{ value: 'oidc', label: t('settings.sso.protocols.oidc') },
							{ value: 'saml', label: t('settings.sso.protocols.saml') },
						]}
					/>
				)}
			</Field>

			<Field label={t('settings.sso.fields.domainAllowlist')}>
				<input
					type="text"
					value={domainsStr}
					onChange={(e) =>
						set(
							'domains',
							e.target.value
								.split(',')
								.map((s) => s.trim())
								.filter(Boolean),
						)
					}
					className="w-full px-3 py-2 bg-input border border-border rounded text-sm"
					placeholder="acme.com, corp.acme.com"
				/>
			</Field>

			<div className="flex gap-4">
				<Checkbox
					checked={Boolean(draft.enabled)}
					onChange={(v) => set('enabled', v)}
					label={t('settings.sso.flags.enabled')}
				/>
				<Checkbox
					checked={Boolean(draft.enforceSso)}
					onChange={(v) => set('enforceSso', v)}
					label={t('settings.sso.flags.enforceSso')}
				/>
				{draft.protocol === 'saml' && (
					<Checkbox
						checked={Boolean(draft.allowIdpInitiated)}
						onChange={(v) => set('allowIdpInitiated', v)}
						label={t('settings.sso.flags.allowIdpInitiated')}
					/>
				)}
			</div>

			{draft.protocol === 'oidc' ? (
				<OidcFields draft={draft} set={set} />
			) : (
				<SamlFields draft={draft} set={set} />
			)}

			{draft.id && <ScimTokensPanel connectionId={draft.id} />}

			<div>
				<h4 className="text-sm font-medium mb-2">{t('settings.sso.attrRolesTitle')}</h4>
				<div className="grid grid-cols-2 gap-3">
					<Field label={t('settings.sso.fields.emailClaim')}>
						<input
							type="text"
							value={draft.attrEmail ?? 'email'}
							onChange={(e) => set('attrEmail', e.target.value)}
							className="w-full px-3 py-2 bg-input border border-border rounded text-sm"
						/>
					</Field>
					<Field label={t('settings.sso.fields.nameClaim')}>
						<input
							type="text"
							value={draft.attrName ?? 'name'}
							onChange={(e) => set('attrName', e.target.value)}
							className="w-full px-3 py-2 bg-input border border-border rounded text-sm"
						/>
					</Field>
					<Field label={t('settings.sso.fields.groupsClaim')}>
						<input
							type="text"
							value={draft.attrGroups ?? 'groups'}
							onChange={(e) => set('attrGroups', e.target.value)}
							className="w-full px-3 py-2 bg-input border border-border rounded text-sm"
						/>
					</Field>
					<Field label={t('settings.sso.fields.defaultRole')}>
						<Dropdown
							value={draft.defaultRole ?? 'viewer'}
							onChange={(v) => set('defaultRole', v as 'admin' | 'editor' | 'viewer')}
							options={['viewer', 'editor', 'admin'].map((r) => ({
								value: r,
								label: roleLabel(r),
							}))}
						/>
					</Field>
				</div>

				<div className="mt-4">
					<label htmlFor="sso-group-role-map" className="block text-xs text-text-secondary mb-1.5">
						{t('settings.sso.fields.groupRoleMap')}
					</label>
					<textarea
						id="sso-group-role-map"
						value={Object.entries(draft.groupRoleMap ?? {})
							.map(([g, r]) => `${g}=${r}`)
							.join('\n')}
						onChange={(e) => {
							const map: Record<string, 'admin' | 'editor' | 'viewer'> = {}
							for (const line of e.target.value.split('\n')) {
								const [g, r] = line.split('=').map((s) => s.trim())
								if (g && (r === 'admin' || r === 'editor' || r === 'viewer')) map[g] = r
							}
							set('groupRoleMap', map)
						}}
						rows={4}
						className="w-full px-3 py-2 bg-input border border-border rounded text-sm font-mono"
						placeholder="cms-admins=admin&#10;cms-editors=editor"
					/>
				</div>
			</div>

			<div className="flex items-center gap-3 pt-2 border-t border-border">
				<button
					type="button"
					onClick={onSave}
					disabled={saving}
					className="px-4 py-2 bg-btn-primary text-btn-primary-text rounded text-sm font-medium hover:bg-btn-primary-hover disabled:opacity-50"
				>
					{saving
						? t('settings.sso.saving')
						: draft.id
							? t('settings.sso.saveChanges')
							: t('settings.sso.createConnection')}
				</button>
				<button
					type="button"
					onClick={onCancel}
					className="px-4 py-2 bg-btn-secondary text-text-secondary rounded text-sm hover:bg-btn-secondary-hover"
				>
					{t('common.cancel')}
				</button>
			</div>
		</div>
	)
}

function OidcFields({
	draft,
	set,
}: {
	draft: ConnectionDraft
	set: <K extends keyof ConnectionDraft>(k: K, v: ConnectionDraft[K]) => void
}) {
	const { t } = useTranslation()
	return (
		<div className="space-y-3 p-4 bg-surface-alt rounded-lg">
			<Field label={t('settings.sso.fields.issuerUrl')}>
				<input
					type="url"
					value={draft.oidcIssuer ?? ''}
					onChange={(e) => set('oidcIssuer', e.target.value)}
					className="w-full px-3 py-2 bg-input border border-border rounded text-sm"
					placeholder="https://login.example.com/realms/acme"
				/>
			</Field>
			<Field label={t('settings.sso.fields.clientId')}>
				<input
					type="text"
					value={draft.oidcClientId ?? ''}
					onChange={(e) => set('oidcClientId', e.target.value)}
					className="w-full px-3 py-2 bg-input border border-border rounded text-sm"
				/>
			</Field>
			<Field
				label={
					draft.hasClientSecret
						? t('settings.sso.fields.clientSecretExisting')
						: t('settings.sso.fields.clientSecret')
				}
			>
				<input
					type="password"
					value={draft.oidcClientSecret ?? ''}
					onChange={(e) => set('oidcClientSecret', e.target.value)}
					className="w-full px-3 py-2 bg-input border border-border rounded text-sm font-mono"
					placeholder={draft.hasClientSecret ? '••••••••' : ''}
				/>
			</Field>
			<Field label={t('settings.sso.fields.scopes')}>
				<input
					type="text"
					value={(draft.oidcScopes ?? []).join(' ')}
					onChange={(e) => set('oidcScopes', e.target.value.split(/\s+/).filter(Boolean))}
					className="w-full px-3 py-2 bg-input border border-border rounded text-sm"
				/>
			</Field>
		</div>
	)
}

function SamlFields({
	draft,
	set,
}: {
	draft: ConnectionDraft
	set: <K extends keyof ConnectionDraft>(k: K, v: ConnectionDraft[K]) => void
}) {
	const { t } = useTranslation()
	return (
		<div className="space-y-3 p-4 bg-surface-alt rounded-lg">
			<Field label={t('settings.sso.fields.idpEntityId')}>
				<input
					type="text"
					value={draft.samlEntityId ?? ''}
					onChange={(e) => set('samlEntityId', e.target.value)}
					className="w-full px-3 py-2 bg-input border border-border rounded text-sm"
				/>
			</Field>
			<Field label={t('settings.sso.fields.idpSsoUrl')}>
				<input
					type="url"
					value={draft.samlSsoUrl ?? ''}
					onChange={(e) => set('samlSsoUrl', e.target.value)}
					className="w-full px-3 py-2 bg-input border border-border rounded text-sm"
				/>
			</Field>
			<div>
				<label htmlFor="sso-idp-certs" className="block text-xs text-text-secondary mb-1.5">
					{t('settings.sso.fields.idpCerts')}
				</label>
				<textarea
					id="sso-idp-certs"
					rows={8}
					value={(draft.samlIdpCertPems ?? []).join('\n')}
					onChange={(e) => {
						const certs = e.target.value
							.split(/-----END CERTIFICATE-----/)
							.map((p) => p.trim())
							.filter(Boolean)
							.map((p) => `${p}\n-----END CERTIFICATE-----`)
						set('samlIdpCertPems', certs)
					}}
					className="w-full px-3 py-2 bg-input border border-border rounded text-xs font-mono"
					placeholder="-----BEGIN CERTIFICATE-----..."
				/>
				{(draft.samlIdpCertPems ?? []).length === 1 && (
					<p className="text-xs text-amber-600 dark:text-amber-400 mt-1">
						{t('settings.sso.addSecondCertWarning')}
					</p>
				)}
			</div>
			<div className="flex gap-4">
				<Checkbox
					checked={Boolean(draft.samlWantAssertionsSigned)}
					onChange={(v) => set('samlWantAssertionsSigned', v)}
					label={t('settings.sso.flags.signedAssertions')}
				/>
				<Checkbox
					checked={Boolean(draft.samlWantAssertionsEncrypted)}
					onChange={(v) => set('samlWantAssertionsEncrypted', v)}
					label={t('settings.sso.flags.encryptedAssertions')}
				/>
			</div>
		</div>
	)
}

interface ScimTokenRow {
	id: string
	name: string
	tokenPrefix: string
	createdAt: string
	lastUsedAt: string | null
	revokedAt: string | null
}

function ScimTokensPanel({ connectionId }: { connectionId: string }) {
	const { t } = useTranslation()
	const toast = useToast()
	const confirm = useConfirm()
	const [tokens, setTokens] = useState<ScimTokenRow[]>([])
	const [loading, setLoading] = useState(true)
	const [name, setName] = useState('')
	const [newToken, setNewToken] = useState<string | null>(null)
	const [creating, setCreating] = useState(false)

	const fetchTokens = useCallback(async () => {
		try {
			const rows = await api.get<ScimTokenRow[]>(
				`/api/v1/ee/sso/connections/${connectionId}/scim-tokens`,
			)
			setTokens(rows)
		} catch {
			// license or permission issue — silent
		} finally {
			setLoading(false)
		}
	}, [connectionId])

	useEffect(() => {
		fetchTokens()
	}, [fetchTokens])

	const create = async () => {
		if (!name.trim()) return
		setCreating(true)
		try {
			const res = await api.post<ScimTokenRow & { token: string }>(
				`/api/v1/ee/sso/connections/${connectionId}/scim-tokens`,
				{ name: name.trim() },
			)
			setNewToken(res.token)
			setName('')
			await fetchTokens()
		} catch (err) {
			toast(err instanceof Error ? err.message : t('settings.sso.scim.createFailed'), 'error')
		} finally {
			setCreating(false)
		}
	}

	const revoke = async (id: string) => {
		const ok = await confirm({
			title: t('settings.sso.scim.revokeConfirmTitle'),
			message: t('settings.sso.scim.revokeConfirmMessage'),
			confirmLabel: t('settings.sso.scim.revokeConfirmLabel'),
			danger: true,
		})
		if (!ok) return
		await api.delete(`/api/v1/ee/sso/connections/${connectionId}/scim-tokens/${id}`)
		await fetchTokens()
	}

	return (
		<div className="p-4 bg-surface-alt rounded-lg space-y-3">
			<div className="flex items-center justify-between">
				<h4 className="text-sm font-medium">{t('settings.sso.scim.title')}</h4>
				<span className="text-xs text-text-muted">
					{t('settings.sso.scim.baseUrlLabel')}{' '}
					<code className="font-mono">/api/v1/scim/&lt;slug&gt;/v2</code>
				</span>
			</div>
			<p className="text-xs text-text-secondary">{t('settings.sso.scim.description')}</p>

			{newToken && (
				<div className="border border-border rounded p-3 bg-surface">
					<p className="text-xs text-text-secondary mb-2">
						{t('settings.sso.scim.saveTokenNotice')}
					</p>
					<code className="block text-xs font-mono break-all p-2 bg-input border border-border rounded">
						{newToken}
					</code>
					<button
						type="button"
						className="mt-2 text-xs text-text-secondary hover:text-text"
						onClick={() => setNewToken(null)}
					>
						{t('settings.sso.scim.dismiss')}
					</button>
				</div>
			)}

			{loading ? (
				<p className="text-xs text-text-secondary">{t('settings.sso.scim.loading')}</p>
			) : tokens.length === 0 ? (
				<p className="text-xs text-text-muted">{t('settings.sso.scim.noTokens')}</p>
			) : (
				<table className="w-full text-xs">
					<thead>
						<tr className="text-left text-text-secondary">
							<th className="pb-1 font-medium">{t('settings.sso.scim.colName')}</th>
							<th className="pb-1 font-medium">{t('settings.sso.scim.colPrefix')}</th>
							<th className="pb-1 font-medium">{t('settings.sso.scim.colCreated')}</th>
							<th className="pb-1 font-medium">{t('settings.sso.scim.colLastUsed')}</th>
							<th className="pb-1 font-medium" />
						</tr>
					</thead>
					<tbody>
						{tokens.map((tk) => (
							<tr key={tk.id} className="border-t border-border">
								<td className="py-1.5">
									{tk.name}
									{tk.revokedAt && (
										<span className="ml-2 text-danger text-[10px]">
											{t('settings.sso.scim.revoked')}
										</span>
									)}
								</td>
								<td className="py-1.5 font-mono text-text-secondary">{tk.tokenPrefix}…</td>
								<td className="py-1.5 text-text-secondary">
									{new Date(tk.createdAt).toLocaleDateString()}
								</td>
								<td className="py-1.5 text-text-secondary">
									{tk.lastUsedAt
										? new Date(tk.lastUsedAt).toLocaleDateString()
										: t('settings.sso.scim.never')}
								</td>
								<td className="py-1.5 text-right">
									{!tk.revokedAt && (
										<button
											type="button"
											className="text-danger hover:opacity-80 text-[11px]"
											onClick={() => revoke(tk.id)}
										>
											{t('settings.sso.scim.revoke')}
										</button>
									)}
								</td>
							</tr>
						))}
					</tbody>
				</table>
			)}

			<div className="flex gap-2 items-center pt-1">
				<input
					type="text"
					value={name}
					onChange={(e) => setName(e.target.value)}
					placeholder={t('settings.sso.scim.tokenNamePlaceholder')}
					className="flex-1 px-2 py-1.5 bg-input border border-border rounded text-xs"
				/>
				<button
					type="button"
					onClick={create}
					disabled={creating || !name.trim()}
					className="px-3 py-1.5 bg-btn-primary text-btn-primary-text rounded text-xs font-medium disabled:opacity-50"
				>
					{creating ? t('settings.sso.scim.generating') : t('settings.sso.scim.generateToken')}
				</button>
			</div>
		</div>
	)
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
	return (
		// biome-ignore lint/a11y/noLabelWithoutControl: generic field wrapper — the control is passed in as children and rendered inside this label.
		<label className="block">
			<span className="block text-xs text-text-secondary mb-1.5">{label}</span>
			{children}
		</label>
	)
}

function Checkbox({
	checked,
	onChange,
	label,
}: {
	checked: boolean
	onChange: (v: boolean) => void
	label: string
}) {
	return (
		<label className="flex items-center gap-2 text-sm">
			<input
				type="checkbox"
				checked={checked}
				onChange={(e) => onChange(e.target.checked)}
				className="rounded"
			/>
			{label}
		</label>
	)
}
