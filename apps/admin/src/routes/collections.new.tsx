import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useState } from 'react'
import { api } from '../lib/api-client'
import { useAuth } from '../lib/auth'
import { useToast } from '../lib/toast'
import { useCollections } from '../lib/collections'
import { Dropdown } from '../components/dropdown'

export const Route = createFileRoute('/collections/new')({
	component: NewCollectionPage,
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
		name: 'SEO Article',
		slug: 'seo-article',
		description: 'Content optimized for search engines with full SEO and Open Graph metadata',
		fields: [
			{ name: 'title', type: 'text', required: true, localized: true },
			{ name: 'slug', type: 'text', required: true },
			{ name: 'excerpt', type: 'text', localized: true },
			{ name: 'author', type: 'text' },
			{ name: 'publishDate', type: 'date' },
			{ name: 'metaTitle', type: 'text', localized: true },
			{ name: 'metaDescription', type: 'text', localized: true },
			{ name: 'canonicalUrl', type: 'text' },
			{ name: 'ogImage', type: 'relation' },
			{ name: 'ogTitle', type: 'text' },
			{ name: 'ogDescription', type: 'text' },
			{ name: 'keywords', type: 'array' },
			{ name: 'noIndex', type: 'boolean' },
		],
	},
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
	{
		name: 'Events',
		slug: 'events',
		description: 'Webinars, meetups, and conferences with scheduling and registration data',
		fields: [
			{ name: 'title', type: 'text', required: true, localized: true },
			{ name: 'type', type: 'enum', required: true, options: ['webinar', 'meetup', 'conference', 'workshop', 'launch'] },
			{ name: 'startDate', type: 'date', required: true },
			{ name: 'endDate', type: 'date' },
			{ name: 'timezone', type: 'text' },
			{ name: 'location', type: 'text' },
			{ name: 'online', type: 'boolean' },
			{ name: 'registrationUrl', type: 'text' },
			{ name: 'speakers', type: 'array' },
			{ name: 'capacity', type: 'number' },
		],
	},
]

const FIELD_TYPES = ['text', 'number', 'boolean', 'date', 'enum', 'relation', 'object', 'array']

function NewCollectionPage() {
	const navigate = useNavigate()
	const toast = useToast()
	const { currentProject } = useAuth()
	const { refreshCollections } = useCollections()
	const isNew = true

	const [name, setName] = useState('')
	const [slug, setSlug] = useState('')
	const [description, setDescription] = useState('')
	const [fields, setFields] = useState<CollectionField[]>([])
	const [saving, setSaving] = useState(false)
	const [loading, setLoading] = useState(!isNew)
	const [showTemplatePicker, setShowTemplatePickerLocal] = useState(() => {
		const params = new URLSearchParams(window.location.search)
		return params.get('step') !== 'configure'
	})

	const setShowTemplatePicker = (show: boolean) => {
		setShowTemplatePickerLocal(show)
		const url = new URL(window.location.href)
		if (!show) url.searchParams.set('step', 'configure')
		else url.searchParams.delete('step')
		window.history.replaceState({}, '', url.toString())
	}


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
			const finalSlug = slug || generateSlug(name)
			await api.post('/api/v1/collections', {
				name,
				slug: finalSlug,
				description: description || undefined,
				fields: validFields,
			})
			await refreshCollections()
			navigate({ to: `/collections/${finalSlug}` })
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


	if (showTemplatePicker) {
		return (
			<div className="p-8 pt-6">
				<button
					type="button"
					onClick={() => navigate({ to: '/dashboard' })}
					className="flex items-center gap-1.5 text-sm text-text-secondary hover:text-text transition-colors mb-6"
				>
					<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="15 18 9 12 15 6" /></svg>
					Back to dashboard
				</button>
				<div className="flex justify-center min-h-[70vh]">
				<div className="max-w-4xl w-full">
				<div className="text-center mb-10">
					<h2 className="text-2xl font-bold mb-2">New Collection</h2>
					<p className="text-text-secondary text-sm">
						Choose a template or start with a blank schema.
					</p>
				</div>

				<div className="grid grid-cols-1 md:grid-cols-3 gap-4">
					{COLLECTION_TEMPLATES.map((template) => (
						<TemplateCard key={template.slug} template={template} onSelect={applyTemplate} />
					))}

					{/* Blank collection card */}
					<button
						type='button'
						onClick={() => setShowTemplatePicker(false)}
						className="rounded-xl border-2 border-dashed border-border p-6 text-left hover:border-border-strong active:translate-x-px active:translate-y-px transition-all flex flex-col items-center justify-center min-h-[160px]"
					>
						<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="text-text-muted mb-2">
							<line x1="12" y1="5" x2="12" y2="19" />
							<line x1="5" y1="12" x2="19" y2="12" />
						</svg>
						<h3 className="font-semibold text-text-secondary mb-1">Blank Collection</h3>
						<p className="text-xs text-text-muted">Define your own schema from scratch</p>
					</button>
				</div>

				{!((currentProject?.settings as Record<string, unknown>)?.externalDb) && (
					<div className="flex items-center justify-center gap-2 mt-8 px-4 py-3 rounded-lg bg-surface-alt border border-border text-sm text-text-muted">
						<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="shrink-0">
							<ellipse cx="12" cy="5" rx="9" ry="3" />
							<path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3" />
							<path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5" />
						</svg>
						Content will be stored in the built-in Innolope CMS database.
					</div>
				)}
				</div>
				</div>
			</div>
		)
	}

	return (
		<div className="p-8 max-w-3xl">
			{isNew && (
				<button
					type="button"
					onClick={() => setShowTemplatePicker(true)}
					className="flex items-center gap-1.5 text-sm text-text-secondary hover:text-text transition-colors mb-4"
				>
					<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="15 18 9 12 15 6" /></svg>
					Choose a different template
				</button>
			)}
			<h2 className="text-2xl font-bold mb-6">
				{isNew ? 'New Collection' : `Edit: ${name}`}
			</h2>

			<div className="space-y-5">
				<Field label="Name">
					<input
						type='text'
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
						type='text'
						value={slug}
						onChange={(e) => setSlug(e.target.value)}
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
						<button
							type='button'
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
											type='button'
											onClick={() => moveField(i, -1)}
											className="text-text-secondary hover:text-text text-xs leading-none"
										>
											&#x25B2
										</button>
										<button
											type='button'
											onClick={() => moveField(i, 1)}
											className="text-text-secondary hover:text-text text-xs leading-none"
										>
											&#x25BC
										</button>
									</div>
									<input
										type='text'
										value={field.name}
										onChange={(e) => updateField(i, { name: e.target.value })}
										placeholder='Field name'
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
											type='checkbox'
											checked={field.required || false}
											onChange={(e) => updateField(i, { required: e.target.checked })}
											className='rounded'
										/>
										Required
									</label>
									<label className="flex items-center gap-1 text-xs text-text-secondary">
										<input
											type='checkbox'
											checked={field.localized || false}
											onChange={(e) => updateField(i, { localized: e.target.checked })}
											className='rounded'
										/>
										i18n
									</label>
									<button
										type='button'
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

				<div className="flex justify-end pt-4">
					<button
						type='button'
						onClick={save}
						disabled={saving}
						className="px-6 py-2 bg-btn-primary text-btn-primary-text rounded text-sm font-medium hover:bg-btn-primary-hover disabled:opacity-50"
					>
						{saving ? 'Saving...' : isNew ? 'Create Collection' : 'Save Changes'}
					</button>
				</div>
			</div>
		</div>
	)
}

const MAX_VISIBLE_FIELDS = 5

function TemplateCard({ template, onSelect }: { template: CollectionTemplate; onSelect: (t: CollectionTemplate) => void }) {
	const [expanded, setExpanded] = useState(false)
	const hasMore = template.fields.length > MAX_VISIBLE_FIELDS
	const visibleFields = expanded ? template.fields : template.fields.slice(0, MAX_VISIBLE_FIELDS)
	const hiddenCount = template.fields.length - MAX_VISIBLE_FIELDS

	return (
		<button
			key={template.slug}
			type='button'
			onClick={() => onSelect(template)}
			className="rounded-xl bg-zinc-800 dark:bg-zinc-700 p-6 text-left hover:bg-zinc-700 dark:hover:bg-zinc-600 active:translate-x-px active:translate-y-px transition-all flex flex-col"
		>
			<h3 className="font-semibold text-white mb-1">{template.name}</h3>
			<p className="text-xs text-white/70">{template.description}</p>
			<div className="bg-white/10 rounded-lg p-3 space-y-1 w-full mt-3">
				{visibleFields.map((f) => (
					<div key={f.name} className="flex items-center justify-between text-[10px] font-mono">
						<span className="text-white">{f.name}{f.required ? <sup className="text-white/40 ml-0.5">*</sup> : ''}</span>
						<span className="text-white/50">{f.type}</span>
					</div>
				))}
				{hasMore && (
					<div
						role="button"
						onClick={(e) => { e.stopPropagation(); setExpanded(!expanded) }}
						onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.stopPropagation(); setExpanded(!expanded) } }}
						tabIndex={0}
						className="text-[10px] text-white/40 hover:text-white/60 pt-1 cursor-pointer transition-colors"
					>
						{expanded ? 'Show less' : `+${hiddenCount} more fields`}
					</div>
				)}
			</div>
		</button>
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
