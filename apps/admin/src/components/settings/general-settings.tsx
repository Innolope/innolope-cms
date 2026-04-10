import { useState, useEffect, useRef } from 'react'
import { useAuth } from '../../lib/auth'
import { api } from '../../lib/api-client'
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
	const initialRef = useRef({ name: '', slug: '', defaultLocale: 'en', locales: 'en' })

	useEffect(() => {
		if (currentProject) {
			const settings = currentProject.settings as Record<string, unknown> || {}
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

	const dirty = name !== initialRef.current.name || slug !== initialRef.current.slug || defaultLocale !== initialRef.current.defaultLocale || locales !== initialRef.current.locales

	const save = async () => {
		if (!currentProject) return
		setSaving(true)
		try {
			const localeList = locales.split(',').map((l) => l.trim()).filter(Boolean)
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
				<label className="block text-xs text-text-secondary mb-1.5">Project name</label>
				<input
					type="text"
					value={name}
					onChange={(e) => setName(e.target.value)}
					className="w-full max-w-sm px-3 py-2 bg-input border border-border-strong rounded text-sm text-text focus:outline-none focus:border-border-strong"
				/>
			</div>
			<div>
				<label className="block text-xs text-text-secondary mb-1.5">Project slug</label>
				<input
					type="text"
					value={slug}
					onChange={(e) => setSlug(e.target.value)}
					className="w-full max-w-sm px-3 py-2 bg-input border border-border-strong rounded text-sm text-text font-mono focus:outline-none focus:border-border-strong"
				/>
				<p className="text-[11px] text-text-muted mt-1">Used in URLs and API. Changing this may break existing integrations.</p>
			</div>
			<div>
				<label className="block text-xs text-text-secondary mb-1.5">Default locale</label>
				<input
					type="text"
					value={defaultLocale}
					onChange={(e) => setDefaultLocale(e.target.value)}
					placeholder="en"
					className="w-full max-w-sm px-3 py-2 bg-input border border-border-strong rounded text-sm text-text focus:outline-none focus:border-border-strong"
				/>
			</div>
			<div>
				<label className="block text-xs text-text-secondary mb-1.5">Available locales</label>
				<input
					type="text"
					value={locales}
					onChange={(e) => setLocales(e.target.value)}
					placeholder="en, es, fr, de"
					className="w-full max-w-sm px-3 py-2 bg-input border border-border-strong rounded text-sm text-text focus:outline-none focus:border-border-strong"
				/>
				<p className="text-[11px] text-text-muted mt-1">Comma-separated locale codes.</p>
			</div>
			<SaveBar dirty={dirty} saving={saving} saved={saved} onSave={save} onReset={() => {
				setName(initialRef.current.name)
				setSlug(initialRef.current.slug)
				setDefaultLocale(initialRef.current.defaultLocale)
				setLocales(initialRef.current.locales)
			}} />
		</div>
	)
}
