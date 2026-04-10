import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useState, useEffect } from 'react'
import { api } from '../lib/api-client'
import { useToast } from '../lib/toast'
import { useCollections } from '../lib/collections'
import { Dropdown } from '../components/dropdown'

export const Route = createFileRoute('/collections/$slug_/edit')({
	component: CollectionSchemaEditor,
})

interface CollectionField {
	name: string
	type: string
	required?: boolean
	localized?: boolean
	options?: string[]
}

const FIELD_TYPES = ['text', 'number', 'boolean', 'date', 'enum', 'relation', 'object', 'array']

function CollectionSchemaEditor() {
	const { slug } = Route.useParams()
	const navigate = useNavigate()
	const toast = useToast()
	const { getCollectionBySlug, refreshCollections } = useCollections()
	const collection = getCollectionBySlug(slug)

	const [name, setName] = useState('')
	const [collectionSlug, setCollectionSlug] = useState('')
	const [description, setDescription] = useState('')
	const [fields, setFields] = useState<CollectionField[]>([])
	const [saving, setSaving] = useState(false)
	const [loading, setLoading] = useState(true)

	useEffect(() => {
		if (collection) {
			api.get<{ name: string; slug: string; description: string | null; fields: CollectionField[] }>(`/api/v1/collections/${collection.id}`)
				.then((col) => {
					setName(col.name)
					setCollectionSlug(col.slug)
					setDescription(col.description || '')
					setFields(col.fields)
				})
				.catch(() => navigate({ to: '/dashboard' }))
				.finally(() => setLoading(false))
		} else {
			setLoading(false)
		}
	}, [collection, navigate])

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
		if (!collection || !name.trim()) { toast('Name is required', 'error'); return }
		const validFields = fields.filter((f) => f.name.trim())
		setSaving(true)
		try {
			await api.put(`/api/v1/collections/${collection.id}`, {
				name,
				slug: collectionSlug,
				description: description || undefined,
				fields: validFields,
			})
			await refreshCollections()
			navigate({ to: `/collections/${collectionSlug}` })
		} catch (err) {
			toast(err instanceof Error ? err.message : 'Save failed', 'error')
		} finally {
			setSaving(false)
		}
	}

	const deleteCollection = async () => {
		if (!collection) return
		if (!confirm(`Delete "${name}" and all its content? This cannot be undone.`)) return
		try {
			await api.delete(`/api/v1/collections/${collection.id}`)
			await refreshCollections()
			navigate({ to: '/dashboard' })
		} catch (err) {
			toast(err instanceof Error ? err.message : 'Delete failed', 'error')
		}
	}

	if (loading) return <div className="p-8 pt-5" />
	if (!collection) return <div className="p-8 pt-5 text-text-secondary text-sm">Collection not found.</div>

	return (
		<div className="p-8 pt-5 max-w-3xl">
			<div className="flex items-center gap-2 text-sm text-text-muted mb-6">
				<button type="button" onClick={() => navigate({ to: `/collections/${slug}` })} className="hover:text-text transition-colors">
					{collection.name}
				</button>
				<span>/</span>
				<span className="text-text">Edit Schema</span>
			</div>

			<h2 className="text-2xl font-bold mb-6">Edit: {name}</h2>

			<div className="space-y-5">
				<Field label="Name">
					<input
						type='text'
						value={name}
						onChange={(e) => setName(e.target.value)}
						className="w-full px-3 py-2 bg-input border border-border rounded text-sm focus:outline-none focus:border-border-strong"
					/>
				</Field>

				<Field label="Slug">
					<input
						type='text'
						value={collectionSlug}
						onChange={(e) => setCollectionSlug(e.target.value)}
						className="w-full px-3 py-2 bg-input border border-border rounded text-sm font-mono focus:outline-none focus:border-border-strong"
					/>
				</Field>

				<Field label="Description">
					<input
						type='text'
						value={description}
						onChange={(e) => setDescription(e.target.value)}
						placeholder="What this collection is for"
						className="w-full px-3 py-2 bg-input border border-border rounded text-sm focus:outline-none focus:border-border-strong"
					/>
				</Field>

				<div>
					<div className="flex items-center justify-between mb-3">
						<label className="text-sm font-medium">Fields</label>
						<button type="button" onClick={addField} className="px-3 py-1 bg-btn-secondary rounded text-xs hover:bg-btn-secondary-hover">+ Add Field</button>
					</div>

					{fields.length === 0 ? (
						<p className="text-text-secondary text-sm">No fields yet. Every collection gets markdown content by default.</p>
					) : (
						<div className="space-y-2">
							{fields.map((field, i) => (
								<div key={i} className="flex items-center gap-2 p-3 bg-surface rounded-lg border border-border">
									<div className="flex flex-col gap-1">
										<button type="button" onClick={() => moveField(i, -1)} className="text-text-secondary hover:text-text text-xs leading-none">&#x25B2;</button>
										<button type="button" onClick={() => moveField(i, 1)} className="text-text-secondary hover:text-text text-xs leading-none">&#x25BC;</button>
									</div>
									<input type="text" value={field.name} onChange={(e) => updateField(i, { name: e.target.value })} placeholder="Field name" className="flex-1 px-2 py-1.5 bg-input border border-border-strong rounded text-sm font-mono focus:outline-none" />
									<Dropdown value={field.type} onChange={(v) => updateField(i, { type: v })} options={FIELD_TYPES.map((t) => ({ value: t, label: t }))} className="px-2 py-1.5 bg-input border border-border-strong rounded text-sm focus:outline-none" />
									<label className="flex items-center gap-1 text-xs text-text-secondary"><input type="checkbox" checked={field.required || false} onChange={(e) => updateField(i, { required: e.target.checked })} /> Required</label>
									<label className="flex items-center gap-1 text-xs text-text-secondary"><input type="checkbox" checked={field.localized || false} onChange={(e) => updateField(i, { localized: e.target.checked })} /> i18n</label>
									<button type="button" onClick={() => removeField(i)} className="text-danger hover:opacity-80 text-xs px-2">Remove</button>
								</div>
							))}
						</div>
					)}
				</div>

				<div className="flex items-center justify-between pt-4">
					<div className="flex gap-3">
						<button type="button" onClick={save} disabled={saving} className="px-6 py-2 bg-btn-primary text-btn-primary-text rounded text-sm font-medium hover:bg-btn-primary-hover disabled:opacity-50">
							{saving ? 'Saving...' : 'Save Changes'}
						</button>
						<button type="button" onClick={() => navigate({ to: `/collections/${slug}` })} className="px-6 py-2 bg-btn-secondary rounded text-sm hover:bg-btn-secondary-hover">Cancel</button>
					</div>
					<button type="button" onClick={deleteCollection} className="text-xs text-danger hover:opacity-80">Delete Collection</button>
				</div>
			</div>
		</div>
	)
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
	return (
		<div>
			<label className="block text-xs text-text-secondary mb-1.5">{label}</label>
			{children}
		</div>
	)
}
