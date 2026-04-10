import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useState, useEffect } from 'react'
import { api } from '../lib/api-client'
import { useToast } from '../lib/toast'
import { Dropdown } from '../components/dropdown'

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

interface CollectionTemplate {
	name: string
	slug: string
	description: string
	fields: CollectionField[]
}

const COLLECTION_TEMPLATES: CollectionTemplate[] = [
	{
		name: 'Knowledge Base',
		slug: 'knowledge-base',
		description: 'Structured articles for AI agent retrieval and customer self-service',
		fields: [
			{ name: 'title', type: 'text', required: true, localized: true },
			{ name: 'category', type: 'enum', options: ['general', 'technical', 'onboarding', 'troubleshooting'] },
			{ name: 'tags', type: 'array' },
			{ name: 'summary', type: 'text', localized: true },
			{ name: 'difficulty', type: 'enum', options: ['beginner', 'intermediate', 'advanced'] },
			{ name: 'relatedArticles', type: 'relation' },
		],
	},
	{
		name: 'FAQ',
		slug: 'faq',
		description: 'Question-answer pairs optimized for AI-powered support agents',
		fields: [
			{ name: 'question', type: 'text', required: true, localized: true },
			{ name: 'answer', type: 'text', required: true, localized: true },
			{ name: 'category', type: 'enum', options: ['general', 'billing', 'technical', 'account'] },
			{ name: 'order', type: 'number' },
			{ name: 'helpful', type: 'number' },
		],
	},
	{
		name: 'Product Catalog',
		slug: 'product-catalog',
		description: 'Structured product data for AI-driven recommendations and search',
		fields: [
			{ name: 'title', type: 'text', required: true, localized: true },
			{ name: 'price', type: 'number', required: true },
			{ name: 'currency', type: 'enum', options: ['USD', 'EUR', 'GBP'] },
			{ name: 'sku', type: 'text', required: true },
			{ name: 'category', type: 'enum', options: ['software', 'hardware', 'service', 'subscription'] },
			{ name: 'inStock', type: 'boolean' },
			{ name: 'specs', type: 'object' },
			{ name: 'images', type: 'relation' },
		],
	},
	{
		name: 'Documentation',
		slug: 'documentation',
		description: 'Technical docs with section ordering for developer-facing AI assistants',
		fields: [
			{ name: 'title', type: 'text', required: true, localized: true },
			{ name: 'section', type: 'text', required: true },
			{ name: 'order', type: 'number' },
			{ name: 'tags', type: 'array' },
			{ name: 'codeExamples', type: 'array' },
			{ name: 'deprecated', type: 'boolean' },
			{ name: 'relatedDocs', type: 'relation' },
		],
	},
	{
		name: 'Changelog',
		slug: 'changelog',
		description: 'Version history and release notes for product updates',
		fields: [
			{ name: 'title', type: 'text', required: true },
			{ name: 'version', type: 'text', required: true },
			{ name: 'date', type: 'date', required: true },
			{ name: 'type', type: 'enum', required: true, options: ['feature', 'fix', 'improvement', 'breaking'] },
			{ name: 'breaking', type: 'boolean' },
		],
	},
	{
		name: 'API Reference',
		slug: 'api-reference',
		description: 'Endpoint documentation for API-aware AI agents and developer tools',
		fields: [
			{ name: 'title', type: 'text', required: true },
			{ name: 'method', type: 'enum', required: true, options: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'] },
			{ name: 'endpoint', type: 'text', required: true },
			{ name: 'parameters', type: 'object' },
			{ name: 'responseSchema', type: 'object' },
			{ name: 'authenticated', type: 'boolean' },
			{ name: 'rateLimit', type: 'number' },
			{ name: 'deprecated', type: 'boolean' },
		],
	},
	{
		name: 'CRM',
		slug: 'crm',
		description: 'Customer contacts and deals for AI-assisted sales workflows',
		fields: [
			{ name: 'name', type: 'text', required: true },
			{ name: 'email', type: 'text', required: true },
			{ name: 'company', type: 'text' },
			{ name: 'stage', type: 'enum', required: true, options: ['lead', 'qualified', 'proposal', 'negotiation', 'closed-won', 'closed-lost'] },
			{ name: 'dealValue', type: 'number' },
			{ name: 'lastContact', type: 'date' },
			{ name: 'notes', type: 'array' },
		],
	},
	{
		name: 'Blog',
		slug: 'blog',
		description: 'Articles and posts with SEO metadata for content marketing',
		fields: [
			{ name: 'title', type: 'text', required: true, localized: true },
			{ name: 'excerpt', type: 'text', localized: true },
			{ name: 'author', type: 'text', required: true },
			{ name: 'publishDate', type: 'date' },
			{ name: 'category', type: 'enum', options: ['engineering', 'product', 'company', 'tutorial'] },
			{ name: 'tags', type: 'array' },
			{ name: 'featuredImage', type: 'relation' },
			{ name: 'seoDescription', type: 'text', localized: true },
		],
	},
	{
		name: 'Job Board',
		slug: 'job-board',
		description: 'Open positions with structured requirements for recruiting agents',
		fields: [
			{ name: 'title', type: 'text', required: true },
			{ name: 'department', type: 'enum', required: true, options: ['engineering', 'design', 'product', 'marketing', 'sales', 'operations'] },
			{ name: 'location', type: 'text', required: true },
			{ name: 'remote', type: 'boolean' },
			{ name: 'salaryMin', type: 'number' },
			{ name: 'salaryMax', type: 'number' },
			{ name: 'requirements', type: 'array' },
		],
	},
]

const FIELD_TYPES = ['text', 'number', 'boolean', 'date', 'enum', 'relation', 'object', 'array']

function CollectionEditor() {
	const { id } = Route.useParams()
	const navigate = useNavigate()
	const toast = useToast()
	const isNew = id === 'new'

	const [name, setName] = useState('')
	const [slug, setSlug] = useState('')
	const [description, setDescription] = useState('')
	const [fields, setFields] = useState<CollectionField[]>([])
	const [saving, setSaving] = useState(false)
	const [loading, setLoading] = useState(!isNew)
	const [showTemplatePicker, setShowTemplatePicker] = useState(isNew)

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
		if (!name.trim()) { toast('Name is required', 'error'); return }
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
			toast(err instanceof Error ? err.message : 'Save failed', 'error')
		} finally {
			setSaving(false)
		}
	}

	const applyTemplate = (template: CollectionTemplate) => {
		setName(template.name)
		setSlug(template.slug)
		setDescription(template.description)
		setFields(template.fields)
		setShowTemplatePicker(false)
	}

	if (loading) return <div className="p-8 text-text-secondary text-sm">Loading...</div>

	if (showTemplatePicker) {
		return (
			<div className="p-8 max-w-4xl">
				<h2 className="text-2xl font-bold mb-2">New Collection</h2>
				<p className="text-text-secondary text-sm mb-6">
					Start from a template or create a blank collection.
				</p>

				<div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3 mb-6">
					{COLLECTION_TEMPLATES.map((template) => (
						<button
							key={template.slug}
							type="button"
							onClick={() => applyTemplate(template)}
							className="text-left p-4 bg-surface border border-border rounded-lg hover:border-border-strong transition-colors"
						>
							<h3 className="text-sm font-semibold mb-1">{template.name}</h3>
							<p className="text-xs text-text-secondary mb-2">{template.description}</p>
							<p className="text-xs text-text-muted">
								{template.fields.length} fields: {template.fields.map((f) => f.name).join(', ')}
							</p>
						</button>
					))}
				</div>

				<button
					type="button"
					onClick={() => setShowTemplatePicker(false)}
					className="px-4 py-2 bg-btn-secondary rounded text-sm hover:bg-btn-secondary-hover"
				>
					Blank Collection
				</button>
			</div>
		)
	}

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
						className="w-full px-3 py-2 bg-input border border-border rounded text-sm focus:outline-none focus:border-border-strong"
					/>
				</Field>

				<Field label="Slug">
					<input
						type="text"
						value={slug}
						onChange={(e) => setSlug(e.target.value)}
						className="w-full px-3 py-2 bg-input border border-border rounded text-sm font-mono focus:outline-none focus:border-border-strong"
					/>
				</Field>

				<Field label="Description">
					<input
						type="text"
						value={description}
						onChange={(e) => setDescription(e.target.value)}
						placeholder="What this collection is for"
						className="w-full px-3 py-2 bg-input border border-border rounded text-sm focus:outline-none focus:border-border-strong"
					/>
				</Field>

				<div>
					<div className="flex items-center justify-between mb-3">
						<label className="text-sm font-medium">Fields</label>
						<button
							type="button"
							onClick={addField}
							className="px-3 py-1 bg-btn-secondary rounded text-xs hover:bg-btn-secondary-hover"
						>
							+ Add Field
						</button>
					</div>

					{fields.length === 0 ? (
						<p className="text-text-secondary text-sm">
							No fields yet. Every collection gets markdown content by default.
						</p>
					) : (
						<div className="space-y-2">
							{fields.map((field, i) => (
								<div
									key={i}
									className="flex items-center gap-2 p-3 bg-surface rounded-lg border border-border"
								>
									<div className="flex flex-col gap-1">
										<button
											type="button"
											onClick={() => moveField(i, -1)}
											className="text-text-secondary hover:text-text text-xs leading-none"
										>
											&#x25B2;
										</button>
										<button
											type="button"
											onClick={() => moveField(i, 1)}
											className="text-text-secondary hover:text-text text-xs leading-none"
										>
											&#x25BC;
										</button>
									</div>
									<input
										type="text"
										value={field.name}
										onChange={(e) => updateField(i, { name: e.target.value })}
										placeholder="Field name"
										className="flex-1 px-2 py-1.5 bg-input border border-border-strong rounded text-sm font-mono focus:outline-none"
									/>
									<Dropdown
										value={field.type}
										onChange={(v) => updateField(i, { type: v })}
										options={FIELD_TYPES.map((t) => ({ value: t, label: t }))}
										className="px-2 py-1.5 bg-input border border-border-strong rounded text-sm focus:outline-none"
									/>
									<label className="flex items-center gap-1 text-xs text-text-secondary">
										<input
											type="checkbox"
											checked={field.required || false}
											onChange={(e) => updateField(i, { required: e.target.checked })}
											className="rounded"
										/>
										Required
									</label>
									<label className="flex items-center gap-1 text-xs text-text-secondary">
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
										className="text-danger hover:opacity-80 text-xs px-2"
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
						className="px-6 py-2 bg-btn-primary text-btn-primary-text rounded text-sm font-medium hover:bg-btn-primary-hover disabled:opacity-50"
					>
						{saving ? 'Saving...' : isNew ? 'Create Collection' : 'Save Changes'}
					</button>
					<button
						type="button"
						onClick={() => navigate({ to: '/collections' })}
						className="px-6 py-2 bg-btn-secondary rounded text-sm hover:bg-btn-secondary-hover"
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
