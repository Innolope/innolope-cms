import { useState, useEffect } from 'react'
import { useAuth } from '../../lib/auth'
import { api } from '../../lib/api-client'

export function GeneralSettings() {
	const { currentProject, refreshProjects } = useAuth()
	const [name, setName] = useState('')
	const [slug, setSlug] = useState('')
	const [defaultLocale, setDefaultLocale] = useState('en')
	const [locales, setLocales] = useState('en')
	const [saving, setSaving] = useState(false)
	const [saved, setSaved] = useState(false)

	useEffect(() => {
		if (currentProject) {
			setName(currentProject.name)
			setSlug(currentProject.slug)
			const settings = currentProject.settings as Record<string, unknown> || {}
			setDefaultLocale((settings.defaultLocale as string) || 'en')
			setLocales(((settings.locales as string[]) || ['en']).join(', '))
		}
	}, [currentProject])

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
			alert(err instanceof Error ? err.message : 'Failed to save')
		} finally {
			setSaving(false)
		}
	}

	return (
		<div className="space-y-4">
			<div>
				<label className="block text-xs text-zinc-500 mb-1.5">Project name</label>
				<input
					type="text"
					value={name}
					onChange={(e) => setName(e.target.value)}
					className="w-full max-w-sm px-3 py-2 bg-white border border-zinc-300 rounded text-sm text-zinc-900 focus:outline-none focus:border-zinc-500"
				/>
			</div>
			<div>
				<label className="block text-xs text-zinc-500 mb-1.5">Project slug</label>
				<input
					type="text"
					value={slug}
					onChange={(e) => setSlug(e.target.value)}
					className="w-full max-w-sm px-3 py-2 bg-white border border-zinc-300 rounded text-sm text-zinc-900 font-mono focus:outline-none focus:border-zinc-500"
				/>
				<p className="text-[11px] text-zinc-400 mt-1">Used in URLs and API. Changing this may break existing integrations.</p>
			</div>
			<div>
				<label className="block text-xs text-zinc-500 mb-1.5">Default locale</label>
				<input
					type="text"
					value={defaultLocale}
					onChange={(e) => setDefaultLocale(e.target.value)}
					placeholder="en"
					className="w-full max-w-xs px-3 py-2 bg-white border border-zinc-300 rounded text-sm text-zinc-900 focus:outline-none focus:border-zinc-500"
				/>
			</div>
			<div>
				<label className="block text-xs text-zinc-500 mb-1.5">Available locales</label>
				<input
					type="text"
					value={locales}
					onChange={(e) => setLocales(e.target.value)}
					placeholder="en, es, fr, de"
					className="w-full max-w-sm px-3 py-2 bg-white border border-zinc-300 rounded text-sm text-zinc-900 focus:outline-none focus:border-zinc-500"
				/>
				<p className="text-[11px] text-zinc-400 mt-1">Comma-separated locale codes.</p>
			</div>
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
