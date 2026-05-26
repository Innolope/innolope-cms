import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { api } from '../../lib/api-client'
import { useAuth } from '../../lib/auth'
import { useToast } from '../../lib/toast'
import { SaveBar } from '../save-bar'

export function GeneralSettings() {
	const { t } = useTranslation()
	const { currentProject, refreshProjects } = useAuth()
	const toast = useToast()
	const [name, setName] = useState('')
	const [slug, setSlug] = useState('')
	const [defaultLocale, setDefaultLocale] = useState('en')
	const [locales, setLocales] = useState('en')
	const [saving, setSaving] = useState(false)
	const [saved, setSaved] = useState(false)
	const [showDelete, setShowDelete] = useState(false)
	const [dangerOpen, setDangerOpen] = useState(false)
	const initialRef = useRef({ name: '', slug: '', defaultLocale: 'en', locales: 'en' })

	useEffect(() => {
		if (currentProject) {
			const settings = (currentProject.settings as Record<string, unknown>) || {}
			const init = {
				name: currentProject.name,
				slug: currentProject.slug,
				defaultLocale: (settings.defaultLocale as string) || 'en',
				locales: ((settings.locales as string[]) || ['en']).join(', '),
			}
			setName(init.name)
			setSlug(init.slug)
			setDefaultLocale(init.defaultLocale)
			setLocales(init.locales)
			initialRef.current = init
		}
	}, [currentProject])

	const dirty =
		name !== initialRef.current.name ||
		slug !== initialRef.current.slug ||
		defaultLocale !== initialRef.current.defaultLocale ||
		locales !== initialRef.current.locales

	const save = async () => {
		if (!currentProject) return
		setSaving(true)
		try {
			const localeList = locales
				.split(',')
				.map((l) => l.trim())
				.filter(Boolean)
			await api.put(`/api/v1/projects/${currentProject.id}`, {
				name,
				slug,
				settings: {
					...(currentProject.settings as Record<string, unknown>),
					defaultLocale,
					locales: localeList,
				},
			})
			setSaved(true)
			setTimeout(() => setSaved(false), 2000)
			await refreshProjects()
		} catch (err) {
			toast(err instanceof Error ? err.message : t('settings.general.saveFailed'), 'error')
		} finally {
			setSaving(false)
		}
	}

	return (
		<div className="space-y-4">
			<div>
				<label htmlFor="gs-project-name" className="block text-xs text-text-secondary mb-1.5">
					{t('settings.general.projectName')}
				</label>
				<input
					id="gs-project-name"
					type="text"
					value={name}
					onChange={(e) => setName(e.target.value)}
					className="w-full max-w-sm px-3 py-2 bg-input border border-border-strong rounded text-sm text-text focus:outline-none focus:border-border-strong"
				/>
			</div>
			<div>
				<label htmlFor="gs-project-slug" className="block text-xs text-text-secondary mb-1.5">
					{t('settings.general.projectSlug')}
				</label>
				<input
					id="gs-project-slug"
					type="text"
					value={slug}
					onChange={(e) => setSlug(e.target.value)}
					className="w-full max-w-sm px-3 py-2 bg-input border border-border-strong rounded text-sm text-text font-mono focus:outline-none focus:border-border-strong"
				/>
				<p className="text-[11px] text-text-muted mt-1">{t('settings.general.slugHelp')}</p>
			</div>
			<div>
				<label htmlFor="gs-default-locale" className="block text-xs text-text-secondary mb-1.5">
					{t('settings.general.defaultLocale')}
				</label>
				<input
					id="gs-default-locale"
					type="text"
					value={defaultLocale}
					onChange={(e) => setDefaultLocale(e.target.value)}
					placeholder="en"
					className="w-full max-w-sm px-3 py-2 bg-input border border-border-strong rounded text-sm text-text focus:outline-none focus:border-border-strong"
				/>
			</div>
			<div>
				<label htmlFor="gs-available-locales" className="block text-xs text-text-secondary mb-1.5">
					{t('settings.general.availableLocales')}
				</label>
				<input
					id="gs-available-locales"
					type="text"
					value={locales}
					onChange={(e) => setLocales(e.target.value)}
					placeholder="en, es, fr, de"
					className="w-full max-w-sm px-3 py-2 bg-input border border-border-strong rounded text-sm text-text focus:outline-none focus:border-border-strong"
				/>
				<p className="text-[11px] text-text-muted mt-1">{t('settings.general.localesHelp')}</p>
			</div>
			<SaveBar
				dirty={dirty}
				saving={saving}
				saved={saved}
				onSave={save}
				onReset={() => {
					setName(initialRef.current.name)
					setSlug(initialRef.current.slug)
					setDefaultLocale(initialRef.current.defaultLocale)
					setLocales(initialRef.current.locales)
				}}
			/>

			{currentProject?.role === 'owner' && (
				<div className="mt-10 pt-6 border-t border-border">
					<button
						type="button"
						onClick={() => setDangerOpen((v) => !v)}
						className="flex items-center gap-1.5 text-xs font-medium text-text-muted hover:text-text"
					>
						<span className={`inline-block transition-transform ${dangerOpen ? 'rotate-90' : ''}`}>
							&#8250;
						</span>
						{t('settings.general.dangerZone')}
					</button>
					{dangerOpen && (
						<div className="flex items-center justify-between gap-4 max-w-2xl mt-3 px-4 py-3 rounded-lg border border-border bg-surface-muted">
							<div className="min-w-0">
								<p className="text-sm text-text font-medium">
									{t('settings.general.deleteWorkspaceTitle')}
								</p>
								<p className="text-xs text-text-muted mt-0.5">
									{t('settings.general.deleteWorkspaceDesc')}
								</p>
							</div>
							<button
								type="button"
								onClick={() => setShowDelete(true)}
								className="shrink-0 px-3 py-2 rounded text-sm font-medium border border-danger/50 text-danger hover:bg-danger/10"
							>
								{t('settings.general.deleteWorkspace')}
							</button>
						</div>
					)}
				</div>
			)}

			{showDelete && currentProject && (
				<DeleteWorkspaceModal
					projectId={currentProject.id}
					projectName={currentProject.name}
					onCancel={() => setShowDelete(false)}
				/>
			)}
		</div>
	)
}

function DeleteWorkspaceModal({
	projectId,
	projectName,
	onCancel,
}: {
	projectId: string
	projectName: string
	onCancel: () => void
}) {
	const { t } = useTranslation()
	const toast = useToast()
	const [confirmText, setConfirmText] = useState('')
	const [deleting, setDeleting] = useState(false)
	const matches = confirmText.trim() === projectName

	useEffect(() => {
		const onKeyDown = (e: KeyboardEvent) => {
			if (e.key === 'Escape') onCancel()
		}
		document.addEventListener('keydown', onKeyDown)
		return () => document.removeEventListener('keydown', onKeyDown)
	}, [onCancel])

	const handleDelete = async () => {
		if (!matches) return
		setDeleting(true)
		try {
			await api.delete(`/api/v1/projects/${projectId}`)
			localStorage.removeItem('innolope_project')
			window.location.href = '/'
		} catch (err) {
			toast(err instanceof Error ? err.message : t('settings.general.deleteFailed'), 'error')
			setDeleting(false)
		}
	}

	return (
		<div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
			<button
				type="button"
				aria-label={t('common.closeDialog')}
				className="absolute inset-0 -z-10 cursor-default"
				onClick={onCancel}
			/>
			<div
				role="dialog"
				aria-modal="true"
				aria-label={t('settings.general.deleteWorkspace')}
				className="bg-surface border border-border rounded-xl shadow-2xl w-full max-w-sm p-6"
			>
				<h3 className="font-semibold text-text mb-2">{t('settings.general.deleteWorkspace')}</h3>
				<p className="text-sm text-text-secondary mb-4">
					{t('settings.general.deleteWorkspacePrompt1')}{' '}
					<span className="font-medium text-text">{projectName}</span>{' '}
					{t('settings.general.deleteWorkspacePrompt2')}
				</p>
				<label htmlFor="gs-delete-confirm" className="block text-xs text-text-secondary mb-1.5">
					{t('settings.general.typeToConfirmPrefix')}{' '}
					<span className="font-mono text-text">{projectName}</span>{' '}
					{t('settings.general.typeToConfirmSuffix')}
				</label>
				<input
					id="gs-delete-confirm"
					type="text"
					value={confirmText}
					onChange={(e) => setConfirmText(e.target.value)}
					placeholder={projectName}
					className="w-full px-3 py-2 bg-input border border-border-strong rounded text-sm text-text focus:outline-none focus:border-border-strong mb-6"
				/>
				<div className="flex gap-3 justify-end">
					<button
						type="button"
						onClick={onCancel}
						className="px-4 py-2 bg-btn-secondary text-text-secondary rounded-lg text-sm hover:bg-btn-secondary-hover transition-colors"
					>
						{t('common.cancel')}
					</button>
					<button
						type="button"
						onClick={handleDelete}
						disabled={!matches || deleting}
						className="px-4 py-2 bg-danger text-white rounded-lg text-sm font-medium hover:opacity-90 disabled:opacity-40"
					>
						{deleting ? t('settings.general.deleting') : t('settings.general.deleteWorkspace')}
					</button>
				</div>
			</div>
		</div>
	)
}
