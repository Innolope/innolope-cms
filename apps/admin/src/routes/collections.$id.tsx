import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useState, useEffect } from 'react'
import { api } from '../lib/api-client'

export const Route = createFileRoute('/collections/$id')({
	component: CollectionEditor,
})

interface CollectionField {
	name: string
	type: string
	required?: boolean
	localized?: boolean
	options?: string[]
}

const FIELD_TYPES = ['text', 'number', 'boolean', 'date', 'select', 'relation', 'json']

function CollectionEditor() {
	const { id } = Route.useParams()
	const navigate = useNavigate()
	const isNew = id === 'new'

	const [name, setName] = useState('')
	const [slug, setSlug] = useState('')
	const [description, setDescription] = useState('')
	const [fields, setFields] = useState<CollectionField[]>([])
	const [saving, setSaving] = useState(false)
	const [loading, setLoading] = useState(!isNew)

	useEffect(() => {
		if (!isNew) {
			api.get<{
				name: string
				slug: string
				description: string | null
				fields: CollectionField[]
			}>(`/api/v1/collections/${id}`)
				.then((col) => {
					setName(col.name)
					setSlug(col.slug)
					setDescription(col.description || '')
					setFields(col.fields)
				})
				.catch(() => navigate({ to: '/collections' }))
				.finally(() => setLoading(false))
		}
	}, [id, isNew, navigate])

	const generateSlug = (text: string) =>
		text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')

	const addField = () => {
		setFields([...fields, { name: '', type: 'text', required: false, localized: false }])
	}

	const updateField = (index: number, updates: Partial<CollectionField>) => {
		setFields(fields.map((f, i) => (i === index ? { ...f, ...updates } : f)))
	}

	const removeField = (index: number) => {
		setFields(fields.filter((_, i) => i !== index))
	}

	const moveField = (index: number, direction: -1 | 1) => {
		const newIndex = index + direction
		if (newIndex < 0 || newIndex >= fields.length) return
		const newFields = [...fields]
		;[newFields[index], newFields[newIndex]] = [newFields[newIndex], newFields[index]]
		setFields(newFields)
	}

	const save = async () => {
		if (!name.trim()) return alert('Name is required')
		const validFields = fields.filter((f) => f.name.trim())
		setSaving(true)
		try {
			if (isNew) {
				await api.post('/api/v1/collections', {
					name,
					slug: slug || generateSlug(name),
					description: description || undefined,
					fields: validFields,
				})
			} else {
				await api.put(`/api/v1/collections/${id}`, {
					name,
					slug,
					description: description || undefined,
					fields: validFields,
				})
			}
			navigate({ to: '/collections' })
		} catch (err) {
			alert(err instanceof Error ? err.message : 'Save failed')
		} finally {
			setSaving(false)
		}
	}

	if (loading) return <div className="p-8 text-zinc-500 text-sm">Loading...</div>

	return (
		<div className="p-8 max-w-3xl">
			<h2 className="text-2xl font-bold mb-6">
				{isNew ? 'New Collection' : `Edit: ${name}`}
			</h2>

			<div className="space-y-5">
				<Field label="Name">
					<input
						type="text"
						value={name}
						onChange={(e) => {
							setName(e.target.value)
							if (isNew) setSlug(generateSlug(e.target.value))
						}}
						placeholder="e.g. Articles, Products, FAQ"
						className="w-full px-3 py-2 bg-zinc-900 border border-zinc-800 rounded text-sm focus:outline-none focus:border-zinc-600"
					/>
				</Field>

				<Field label="Slug">
					<input
						type="text"
						value={slug}
						onChange={(e) => setSlug(e.target.value)}
						className="w-full px-3 py-2 bg-zinc-900 border border-zinc-800 rounded text-sm font-mono focus:outline-none focus:border-zinc-600"
					/>
				</Field>

				<Field label="Description">
					<input
						type="text"
						value={description}
						onChange={(e) => setDescription(e.target.value)}
						placeholder="What this collection is for"
						className="w-full px-3 py-2 bg-zinc-900 border border-zinc-800 rounded text-sm focus:outline-none focus:border-zinc-600"
					/>
				</Field>

				<div>
					<div className="flex items-center justify-between mb-3">
						<label className="text-sm font-medium">Fields</label>
						<button
							type="button"
							onClick={addField}
							className="px-3 py-1 bg-zinc-800 rounded text-xs hover:bg-zinc-700"
						>
							+ Add Field
						</button>
					</div>

					{fields.length === 0 ? (
						<p className="text-zinc-600 text-sm">
							No fields yet. Every collection gets markdown content by default.
						</p>
					) : (
						<div className="space-y-2">
							{fields.map((field, i) => (
								<div
									key={i}
									className="flex items-center gap-2 p-3 bg-zinc-900 rounded-lg border border-zinc-800"
								>
									<div className="flex flex-col gap-1">
										<button
											type="button"
											onClick={() => moveField(i, -1)}
											className="text-zinc-600 hover:text-zinc-400 text-xs leading-none"
										>
											&#x25B2;
										</button>
										<button
											type="button"
											onClick={() => moveField(i, 1)}
											className="text-zinc-600 hover:text-zinc-400 text-xs leading-none"
										>
											&#x25BC;
										</button>
									</div>
									<input
										type="text"
										value={field.name}
										onChange={(e) => updateField(i, { name: e.target.value })}
										placeholder="Field name"
										className="flex-1 px-2 py-1.5 bg-zinc-800 border border-zinc-700 rounded text-sm font-mono focus:outline-none"
									/>
									<select
										value={field.type}
										onChange={(e) => updateField(i, { type: e.target.value })}
										className="px-2 py-1.5 bg-zinc-800 border border-zinc-700 rounded text-sm focus:outline-none"
									>
										{FIELD_TYPES.map((t) => (
											<option key={t} value={t}>
												{t}
											</option>
										))}
									</select>
									<label className="flex items-center gap-1 text-xs text-zinc-500">
										<input
											type="checkbox"
											checked={field.required || false}
											onChange={(e) => updateField(i, { required: e.target.checked })}
											className="rounded"
										/>
										Required
									</label>
									<label className="flex items-center gap-1 text-xs text-zinc-500">
										<input
											type="checkbox"
											checked={field.localized || false}
											onChange={(e) => updateField(i, { localized: e.target.checked })}
											className="rounded"
										/>
										i18n
									</label>
									<button
										type="button"
										onClick={() => removeField(i)}
										className="text-red-500 hover:text-red-400 text-xs px-2"
									>
										Remove
									</button>
								</div>
							))}
						</div>
					)}
				</div>

				<div className="flex gap-3 pt-4">
					<button
						type="button"
						onClick={save}
						disabled={saving}
						className="px-6 py-2 bg-white text-black rounded text-sm font-medium hover:bg-zinc-200 disabled:opacity-50"
					>
						{saving ? 'Saving...' : isNew ? 'Create Collection' : 'Save Changes'}
					</button>
					<button
						type="button"
						onClick={() => navigate({ to: '/collections' })}
						className="px-6 py-2 bg-zinc-800 rounded text-sm hover:bg-zinc-700"
					>
						Cancel
					</button>
				</div>
			</div>
		</div>
	)
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
	return (
		<div>
			<label className="block text-sm font-medium mb-1.5">{label}</label>
			{children}
		</div>
	)
}
