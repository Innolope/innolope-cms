import { useEffect, useRef, useState } from 'react'
import { api } from '../../lib/api-client'
import { useAuth } from '../../lib/auth'
import { useToast } from '../../lib/toast'
import { SaveBar } from '../save-bar'

export function GeneralSettings() {
	const { currentProject, refreshProjects } = useAuth()
	const toast = useToast()
	const [name, setName] = useState('')
	const [slug, setSlug] = useState('')
	const [defaultLocale, setDefaultLocale] = useState('en')
	const [locales, setLocales] = useState('en')
	const [saving, setSaving] = useState(false)
	const [saved, setSaved] = useState(false)
	const [showDelete, setShowDelete] = useState(false)
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
			toast(err instanceof Error ? err.message : 'Failed to save', 'error')
		} finally {
			setSaving(false)
		}
	}

	return (
		<div className="space-y-4">
			<div>
				<label htmlFor="gs-project-name" className="block text-xs text-text-secondary mb-1.5">
					Project name
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
					Project slug
				</label>
				<input
					id="gs-project-slug"
					type="text"
					value={slug}
					onChange={(e) => setSlug(e.target.value)}
					className="w-full max-w-sm px-3 py-2 bg-input border border-border-strong rounded text-sm text-text font-mono focus:outline-none focus:border-border-strong"
				/>
				<p className="text-[11px] text-text-muted mt-1">
					Used in URLs and API. Changing this may break existing integrations.
				</p>
			</div>
			<div>
				<label htmlFor="gs-default-locale" className="block text-xs text-text-secondary mb-1.5">
					Default locale
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
					Available locales
				</label>
				<input
					id="gs-available-locales"
					type="text"
					value={locales}
					onChange={(e) => setLocales(e.target.value)}
					placeholder="en, es, fr, de"
					className="w-full max-w-sm px-3 py-2 bg-input border border-border-strong rounded text-sm text-text focus:outline-none focus:border-border-strong"
				/>
				<p className="text-[11px] text-text-muted mt-1">Comma-separated locale codes.</p>
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
					<h3 className="text-sm font-semibold text-danger mb-1">Danger zone</h3>
					<div className="flex items-center justify-between gap-4 max-w-2xl px-4 py-3 rounded-lg border border-danger/40">
						<div className="min-w-0">
							<p className="text-sm text-text font-medium">Delete this workspace</p>
							<p className="text-xs text-text-muted mt-0.5">
								Permanently removes the workspace and its CMS content. Your external database and
								its data are not touched.
							</p>
						</div>
						<button
							type="button"
							onClick={() => setShowDelete(true)}
							className="shrink-0 px-3 py-2 rounded text-sm font-medium bg-danger text-white hover:opacity-90"
						>
							Delete workspace
						</button>
					</div>
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
			toast(err instanceof Error ? err.message : 'Failed to delete workspace', 'error')
			setDeleting(false)
		}
	}

	return (
		<div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
			<button
				type="button"
				aria-label="Close dialog"
				className="absolute inset-0 -z-10 cursor-default"
				onClick={onCancel}
			/>
			<div
				role="dialog"
				aria-modal="true"
				aria-label="Delete workspace"
				className="bg-surface border border-border rounded-xl shadow-2xl w-full max-w-sm p-6"
			>
				<h3 className="font-semibold text-text mb-2">Delete workspace</h3>
				<p className="text-sm text-text-secondary mb-4">
					This permanently deletes <span className="font-medium text-text">{projectName}</span> and
					all of its CMS content, collections, and members. This cannot be undone. Your connected
					external database and its data will not be deleted.
				</p>
				<label htmlFor="gs-delete-confirm" className="block text-xs text-text-secondary mb-1.5">
					Type <span className="font-mono text-text">{projectName}</span> to confirm
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
						Cancel
					</button>
					<button
						type="button"
						onClick={handleDelete}
						disabled={!matches || deleting}
						className="px-4 py-2 bg-danger text-white rounded-lg text-sm font-medium hover:opacity-90 disabled:opacity-40"
					>
						{deleting ? 'Deleting…' : 'Delete workspace'}
					</button>
				</div>
			</div>
		</div>
	)
}
