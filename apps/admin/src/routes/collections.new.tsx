import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Dropdown } from '../components/dropdown'
import { hasFeature, ProBadge, useLicense } from '../components/license-gate'
import { api } from '../lib/api-client'
import { useAuth } from '../lib/auth'
import { useCollections } from '../lib/collections'
import { useToast } from '../lib/toast'

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
	/** Translation key suffix under `collections.new.templates.*` for label/description. */
	id: string
	label: string
	name: string
	description: string
	fields: CollectionField[]
}

// ─── Type inference engine ───────────────────────────────────────────────────

const VALID_TYPES = new Set([
	'text',
	'number',
	'boolean',
	'date',
	'enum',
	'relation',
	'object',
	'array',
])

function inferFieldType(values: unknown[]): { type: string; options?: string[] } {
	const filtered = values.filter((v) => v !== null && v !== undefined && v !== '')
	if (filtered.length === 0) return { type: 'text' }
	if (filtered.every((v) => typeof v === 'boolean')) return { type: 'boolean' }
	if (filtered.every((v) => typeof v === 'number' && Number.isFinite(v))) return { type: 'number' }
	if (filtered.every((v) => Array.isArray(v))) return { type: 'array' }
	if (filtered.every((v) => typeof v === 'object' && v !== null && !Array.isArray(v)))
		return { type: 'object' }
	if (filtered.every((v) => typeof v === 'string')) {
		const strings = filtered as string[]
		if (strings.every((s) => /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2})/.test(s))) return { type: 'date' }
		const unique = [...new Set(strings)]
		if (unique.length >= 2 && unique.length <= 10 && strings.length >= 3)
			return { type: 'enum', options: unique }
		return { type: 'text' }
	}
	return { type: 'text' }
}

function sanitizeFieldName(header: string): string {
	return (
		header
			.trim()
			.replace(/[^a-zA-Z0-9\s_-]/g, '')
			.replace(/[-_\s]+(.)/g, (_, c) => c.toUpperCase())
			.replace(/^[A-Z]/, (c) => c.toLowerCase()) || 'field'
	)
}

function inferFieldsFromJSON(input: string): { fields: CollectionField[]; errorKey?: string } {
	let parsed: unknown
	try {
		parsed = JSON.parse(input)
	} catch {
		return { fields: [], errorKey: 'collections.new.errors.invalidJson' }
	}

	let objects: Record<string, unknown>[]
	if (Array.isArray(parsed)) {
		objects = parsed.filter(
			(item) => typeof item === 'object' && item !== null && !Array.isArray(item),
		) as Record<string, unknown>[]
		if (objects.length === 0)
			return { fields: [], errorKey: 'collections.new.errors.expectedArrayOfObjects' }
	} else if (typeof parsed === 'object' && parsed !== null) {
		objects = [parsed as Record<string, unknown>]
	} else {
		return { fields: [], errorKey: 'collections.new.errors.expectedObjectOrArray' }
	}

	const allKeys = new Set<string>()
	for (const obj of objects) for (const k of Object.keys(obj)) allKeys.add(k)
	if (allKeys.size === 0) return { fields: [], errorKey: 'collections.new.errors.noFieldsFound' }

	const fields: CollectionField[] = []
	for (const key of allKeys) {
		const values = objects.map((obj) => obj[key])
		const { type, options } = inferFieldType(values)
		const nonNull = values.filter((v) => v !== null && v !== undefined)
		fields.push({
			name: sanitizeFieldName(key),
			type,
			required: nonNull.length === objects.length,
			localized: false,
			...(options ? { options } : {}),
		})
	}
	return { fields }
}

function parseCSVLine(line: string): string[] {
	const fields: string[] = []
	let current = ''
	let inQuotes = false
	for (let i = 0; i < line.length; i++) {
		const char = line[i]
		if (inQuotes) {
			if (char === '"') {
				if (line[i + 1] === '"') {
					current += '"'
					i++
				} else inQuotes = false
			} else current += char
		} else {
			if (char === '"') inQuotes = true
			else if (char === ',') {
				fields.push(current.trim())
				current = ''
			} else current += char
		}
	}
	fields.push(current.trim())
	return fields
}

function coerceCSVValue(val: string): unknown {
	if (val === '') return undefined
	if (val.toLowerCase() === 'true') return true
	if (val.toLowerCase() === 'false') return false
	const num = Number(val)
	if (val !== '' && !Number.isNaN(num) && Number.isFinite(num)) return num
	return val
}

function inferFieldsFromCSV(input: string): { fields: CollectionField[]; errorKey?: string } {
	const raw = input.replace(/^\uFEFF/, '')
	const lines = raw.split(/\r?\n/).filter((l) => l.trim())
	if (lines.length === 0) return { fields: [], errorKey: 'collections.new.errors.pasteCsv' }
	const headers = parseCSVLine(lines[0])
	if (headers.length === 0 || headers.every((h) => !h.trim()))
		return { fields: [], errorKey: 'collections.new.errors.noHeaders' }
	const dataRows = lines.slice(1).map((l) => parseCSVLine(l))
	const fields: CollectionField[] = []
	const seen = new Set<string>()
	for (let col = 0; col < headers.length; col++) {
		const rawName = headers[col]
		if (!rawName.trim()) continue
		let name = sanitizeFieldName(rawName)
		if (seen.has(name)) {
			let n = 2
			while (seen.has(`${name}${n}`)) n++
			name = `${name}${n}`
		}
		seen.add(name)
		const values = dataRows.map((row) => coerceCSVValue(row[col] ?? ''))
		const { type, options } = inferFieldType(values)
		const nonEmpty = values.filter((v) => v !== undefined)
		fields.push({
			name,
			type,
			required: dataRows.length > 0 && nonEmpty.length === dataRows.length,
			localized: false,
			...(options ? { options } : {}),
		})
	}
	return { fields }
}

function inferFieldsFromYAML(input: string): { fields: CollectionField[]; errorKey?: string } {
	const fmMatch = input.match(/^---\s*\n([\s\S]*?)\n---/)
	const yaml = fmMatch ? fmMatch[1] : input
	const fields: CollectionField[] = []
	for (const line of yaml.split('\n')) {
		const match = line.match(/^(\w[\w-]*):\s*(.*)$/)
		if (!match) continue
		const [, key, val] = match
		const name = sanitizeFieldName(key)
		const trimmed = val.trim()
		let type = 'text'
		if (trimmed === 'true' || trimmed === 'false') type = 'boolean'
		else if (trimmed && !Number.isNaN(Number(trimmed))) type = 'number'
		else if (/^\d{4}-\d{2}-\d{2}/.test(trimmed)) type = 'date'
		else if (trimmed.startsWith('[')) type = 'array'
		fields.push({ name, type, required: false, localized: false })
	}
	if (fields.length === 0) return { fields: [], errorKey: 'collections.new.errors.noFieldsYaml' }
	return { fields }
}

// ─── Templates ───────────────────────────────────────────────────────────────

const COLLECTION_TEMPLATES: CollectionTemplate[] = [
	{
		id: 'seoArticle',
		label: 'SEO Article',
		name: 'seo-article',
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
		id: 'knowledgeBase',
		label: 'Knowledge Base',
		name: 'knowledge-base',
		description: 'Structured articles for AI agent retrieval and customer self-service',
		fields: [
			{ name: 'title', type: 'text', required: true, localized: true },
			{
				name: 'category',
				type: 'enum',
				options: ['general', 'technical', 'onboarding', 'troubleshooting'],
			},
			{ name: 'tags', type: 'array' },
			{ name: 'summary', type: 'text', localized: true },
			{ name: 'difficulty', type: 'enum', options: ['beginner', 'intermediate', 'advanced'] },
			{ name: 'relatedArticles', type: 'relation' },
		],
	},
	{
		id: 'faq',
		label: 'FAQ',
		name: 'faq',
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
		id: 'productCatalog',
		label: 'Product Catalog',
		name: 'product-catalog',
		description: 'Structured product data for AI-driven recommendations and search',
		fields: [
			{ name: 'title', type: 'text', required: true, localized: true },
			{ name: 'price', type: 'number', required: true },
			{ name: 'currency', type: 'enum', options: ['USD', 'EUR', 'GBP'] },
			{ name: 'sku', type: 'text', required: true },
			{
				name: 'category',
				type: 'enum',
				options: ['software', 'hardware', 'service', 'subscription'],
			},
			{ name: 'inStock', type: 'boolean' },
			{ name: 'specs', type: 'object' },
			{ name: 'images', type: 'relation' },
		],
	},
	{
		id: 'documentation',
		label: 'Documentation',
		name: 'documentation',
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
		id: 'crm',
		label: 'CRM',
		name: 'crm',
		description: 'Customer contacts and deals for AI-assisted sales workflows',
		fields: [
			{ name: 'name', type: 'text', required: true },
			{ name: 'email', type: 'text', required: true },
			{ name: 'company', type: 'text' },
			{
				name: 'stage',
				type: 'enum',
				required: true,
				options: ['lead', 'qualified', 'proposal', 'negotiation', 'closed-won', 'closed-lost'],
			},
			{ name: 'dealValue', type: 'number' },
			{ name: 'lastContact', type: 'date' },
			{ name: 'notes', type: 'array' },
		],
	},
	{
		id: 'apiReference',
		label: 'API Reference',
		name: 'api-reference',
		description: 'Endpoint documentation for API-aware AI agents and developer tools',
		fields: [
			{ name: 'title', type: 'text', required: true },
			{
				name: 'method',
				type: 'enum',
				required: true,
				options: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'],
			},
			{ name: 'endpoint', type: 'text', required: true },
			{ name: 'parameters', type: 'object' },
			{ name: 'responseSchema', type: 'object' },
			{ name: 'authenticated', type: 'boolean' },
			{ name: 'rateLimit', type: 'number' },
			{ name: 'deprecated', type: 'boolean' },
		],
	},
	{
		id: 'changelog',
		label: 'Changelog',
		name: 'changelog',
		description: 'Version history and release notes for product updates',
		fields: [
			{ name: 'title', type: 'text', required: true },
			{ name: 'version', type: 'text', required: true },
			{ name: 'date', type: 'date', required: true },
			{
				name: 'type',
				type: 'enum',
				required: true,
				options: ['feature', 'fix', 'improvement', 'breaking'],
			},
			{ name: 'breaking', type: 'boolean' },
		],
	},
	{
		id: 'blog',
		label: 'Blog',
		name: 'blog',
		description: 'Articles and posts with SEO metadata for content marketing',
		fields: [
			{ name: 'title', type: 'text', required: true, localized: true },
			{ name: 'excerpt', type: 'text', localized: true },
			{ name: 'author', type: 'text', required: true },
			{ name: 'publishDate', type: 'date' },
			{
				name: 'category',
				type: 'enum',
				options: ['engineering', 'product', 'company', 'tutorial'],
			},
			{ name: 'tags', type: 'array' },
			{ name: 'featuredImage', type: 'relation' },
			{ name: 'seoDescription', type: 'text', localized: true },
		],
	},
	{
		id: 'jobBoard',
		label: 'Job Board',
		name: 'job-board',
		description: 'Open positions with structured requirements for recruiting agents',
		fields: [
			{ name: 'title', type: 'text', required: true },
			{
				name: 'department',
				type: 'enum',
				required: true,
				options: ['engineering', 'design', 'product', 'marketing', 'sales', 'operations'],
			},
			{ name: 'location', type: 'text', required: true },
			{ name: 'remote', type: 'boolean' },
			{ name: 'salaryMin', type: 'number' },
			{ name: 'salaryMax', type: 'number' },
			{ name: 'requirements', type: 'array' },
		],
	},
	{
		id: 'events',
		label: 'Events',
		name: 'events',
		description: 'Webinars, meetups, and conferences with scheduling and registration data',
		fields: [
			{ name: 'title', type: 'text', required: true, localized: true },
			{
				name: 'type',
				type: 'enum',
				required: true,
				options: ['webinar', 'meetup', 'conference', 'workshop', 'launch'],
			},
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

type Screen =
	| 'method'
	| 'template'
	| 'import-file'
	| 'import-paste'
	| 'manual'
	| 'ai-generate'
	| 'copy-existing'
	| 'configure'

const SCREEN_MAP: Record<string, Screen> = {
	template: 'template',
	'import-file': 'import-file',
	'import-paste': 'import-paste',
	manual: 'manual',
	'ai-generate': 'ai-generate',
	'copy-existing': 'copy-existing',
	configure: 'configure',
}

// ─── Shared layout wrapper ───────────────────────────────────────────────────

function ScreenLayout({
	backLabel,
	onBack,
	title,
	subtitle,
	maxWidth,
	children,
}: {
	backLabel: string
	onBack: () => void
	title: string
	subtitle?: string
	maxWidth?: string
	children: React.ReactNode
}) {
	return (
		<div className="p-8 pt-6">
			<button
				type="button"
				onClick={onBack}
				className="flex items-center gap-1.5 text-sm text-text-secondary hover:text-text transition-colors mb-6"
			>
				<svg
					width="16"
					height="16"
					viewBox="0 0 24 24"
					fill="none"
					stroke="currentColor"
					strokeWidth="2"
					strokeLinecap="round"
					strokeLinejoin="round"
				>
					<polyline points="15 18 9 12 15 6" />
				</svg>
				{backLabel}
			</button>
			<div className="flex justify-center min-h-[70vh]">
				<div className={`${maxWidth || 'max-w-4xl'} w-full`}>
					<div className="text-center mb-10">
						<h2 className="text-2xl font-bold mb-2">{title}</h2>
						{subtitle && <p className="text-text-secondary text-sm">{subtitle}</p>}
					</div>
					{children}
				</div>
			</div>
		</div>
	)
}

// ─── Component ───────────────────────────────────────────────────────────────

function NewCollectionPage() {
	const { t } = useTranslation()
	const navigate = useNavigate()
	const toast = useToast()
	const license = useLicense()
	const { currentProject } = useAuth()
	const { collections, refreshCollections } = useCollections()

	const [screen, setScreenLocal] = useState<Screen>(() => {
		const step = new URLSearchParams(window.location.search).get('step')
		return (step && SCREEN_MAP[step]) || 'method'
	})

	const [label, setLabel] = useState('')
	const [name, setName] = useState('')
	const [description, setDescription] = useState('')
	const [fields, setFields] = useState<CollectionField[]>([])
	const [saving, setSaving] = useState(false)
	const [aiPrompt, setAiPrompt] = useState('')
	const [aiLoading, setAiLoading] = useState(false)
	const [aiError, setAiError] = useState('')
	const [jsonText, setJsonText] = useState('')
	const [csvText, setCsvText] = useState('')
	const [mdText, setMdText] = useState('')
	const [importTab, setImportTab] = useState<'json' | 'csv' | 'markdown'>('json')
	const [importError, setImportError] = useState('')
	const fileInputRef = useRef<HTMLInputElement>(null)
	const _csvInputRef = useRef<HTMLInputElement>(null)

	const setScreen = (s: Screen) => {
		setScreenLocal(s)
		const url = new URL(window.location.href)
		if (s === 'method') url.searchParams.delete('step')
		else url.searchParams.set('step', s)
		window.history.replaceState({}, '', url.toString())
	}

	const generateName = (text: string) =>
		text
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, '-')
			.replace(/^-|-$/g, '')

	const addField = () =>
		setFields([...fields, { name: '', type: 'text', required: false, localized: false }])
	const updateField = (i: number, u: Partial<CollectionField>) =>
		setFields(fields.map((f, idx) => (idx === i ? { ...f, ...u } : f)))
	const removeField = (i: number) => setFields(fields.filter((_, idx) => idx !== i))
	const moveField = (i: number, d: -1 | 1) => {
		const j = i + d
		if (j < 0 || j >= fields.length) return
		const nf = [...fields]
		;[nf[i], nf[j]] = [nf[j], nf[i]]
		setFields(nf)
	}

	const save = async () => {
		if (!label.trim()) {
			toast(t('collections.new.errors.labelRequired'), 'error')
			return
		}
		const validFields = fields.filter((f) => f.name.trim())
		setSaving(true)
		try {
			const finalName = name || generateName(label)
			await api.post('/api/v1/collections', {
				label,
				name: finalName,
				description: description || undefined,
				fields: validFields,
			})
			await refreshCollections()
			navigate({ to: `/collections/${finalName}` })
		} catch (err) {
			toast(err instanceof Error ? err.message : t('collections.new.errors.saveFailed'), 'error')
		} finally {
			setSaving(false)
		}
	}

	const applyTemplate = (t: CollectionTemplate) => {
		setLabel(t.label)
		setName(t.name)
		setDescription(t.description)
		setFields(t.fields)
		setScreen('configure')
	}

	const goToConfigureWithFields = (f: CollectionField[]) => {
		setFields(f)
		setScreen('configure')
	}

	const generateWithAi = async () => {
		if (!aiPrompt.trim()) return
		setAiLoading(true)
		setAiError('')
		try {
			const result = await api.post<{ fields: CollectionField[] }>('/api/v1/ai/generate-schema', {
				description: aiPrompt,
			})
			if (result.fields?.length)
				goToConfigureWithFields(
					result.fields.map((f) => ({ ...f, type: VALID_TYPES.has(f.type) ? f.type : 'text' })),
				)
			else setAiError(t('collections.new.errors.aiNoFields'))
		} catch (err) {
			setAiError(err instanceof Error ? err.message : t('collections.new.errors.aiGenerateFailed'))
		} finally {
			setAiLoading(false)
		}
	}

	const _parseJSON = () => {
		setImportError('')
		const result = inferFieldsFromJSON(jsonText.trim())
		if (result.errorKey) {
			setImportError(t(result.errorKey))
			return
		}
		goToConfigureWithFields(result.fields)
	}

	const _parseCSV = () => {
		setImportError('')
		const result = inferFieldsFromCSV(csvText.trim())
		if (result.errorKey) {
			setImportError(t(result.errorKey))
			return
		}
		goToConfigureWithFields(result.fields)
	}

	const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
		const file = e.target.files?.[0]
		if (!file) return
		const reader = new FileReader()
		reader.onload = () => {
			const text = reader.result as string
			let result: { fields: CollectionField[]; errorKey?: string }
			if (file.name.endsWith('.csv') || file.name.endsWith('.tsv')) {
				setCsvText(text)
				result = inferFieldsFromCSV(text)
			} else if (
				file.name.endsWith('.md') ||
				file.name.endsWith('.mdx') ||
				file.name.endsWith('.yaml') ||
				file.name.endsWith('.yml')
			) {
				setMdText(text)
				result = inferFieldsFromYAML(text)
			} else {
				setJsonText(text)
				result = inferFieldsFromJSON(text)
			}
			if (result.errorKey) {
				setImportError(t(result.errorKey))
				return
			}
			goToConfigureWithFields(result.fields)
		}
		reader.readAsText(file)
	}

	// ─── Screen: Method Selection (6 cards) ──────────────────────────────────
	if (screen === 'method') {
		const aiLicensed = hasFeature(license, 'ai-assistant')
		const methods: {
			id: Screen
			title: string
			desc: string
			icon: React.ReactNode
			pro?: boolean
		}[] = [
			{
				id: 'template',
				title: t('collections.new.methods.template.title'),
				desc: t('collections.new.methods.template.desc'),
				icon: (
					<>
						<rect x="3" y="3" width="7" height="7" />
						<rect x="14" y="3" width="7" height="7" />
						<rect x="3" y="14" width="7" height="7" />
						<rect x="14" y="14" width="7" height="7" />
					</>
				),
			},
			{
				id: 'import-file',
				title: t('collections.new.methods.importFile.title'),
				desc: t('collections.new.methods.importFile.desc'),
				icon: (
					<>
						<path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" />
						<polyline points="14 2 14 8 20 8" />
					</>
				),
			},
			{
				id: 'import-paste',
				title: t('collections.new.methods.importPaste.title'),
				desc: t('collections.new.methods.importPaste.desc'),
				icon: (
					<>
						<path d="M16 4h2a2 2 0 012 2v14a2 2 0 01-2 2H6a2 2 0 01-2-2V6a2 2 0 012-2h2" />
						<rect x="8" y="2" width="8" height="4" rx="1" ry="1" />
					</>
				),
			},
			{
				id: 'ai-generate',
				title: t('collections.new.methods.aiGenerate.title'),
				desc: t('collections.new.methods.aiGenerate.desc'),
				icon: (
					<>
						<polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
					</>
				),
				pro: !aiLicensed,
			},
			{
				id: 'manual',
				title: t('collections.new.methods.manual.title'),
				desc: t('collections.new.methods.manual.desc'),
				icon: (
					<>
						<line x1="12" y1="5" x2="12" y2="19" />
						<line x1="5" y1="12" x2="19" y2="12" />
					</>
				),
			},
		]
		if (collections.length > 0) {
			methods.push({
				id: 'copy-existing' as Screen,
				title: t('collections.new.methods.copyExisting.title'),
				desc: t('collections.new.methods.copyExisting.desc'),
				icon: (
					<>
						<rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
						<path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" />
					</>
				),
			})
		}

		return (
			<ScreenLayout
				backLabel={t('collections.new.backToDashboard')}
				onBack={() => navigate({ to: '/dashboard' })}
				title={t('collections.new.title')}
				subtitle={t('collections.new.subtitle')}
			>
				<div className="grid grid-cols-1 md:grid-cols-3 gap-4">
					{methods.map((m) => (
						<button
							key={m.id}
							type="button"
							onClick={() => setScreen(m.id)}
							className="rounded-xl bg-zinc-800 dark:bg-zinc-700 p-8 text-left hover:bg-zinc-700 dark:hover:bg-zinc-600 active:translate-x-px active:translate-y-px transition-all group flex flex-col"
						>
							<div className="w-12 h-12 rounded-lg bg-white/10 flex items-center justify-center">
								<svg
									width="24"
									height="24"
									viewBox="0 0 24 24"
									fill="none"
									stroke="currentColor"
									strokeWidth="1.5"
									strokeLinecap="round"
									strokeLinejoin="round"
									className="text-white"
								>
									{m.icon}
								</svg>
							</div>
							<div className="mt-6">
								<h3 className="font-semibold text-white mb-1.5">
									{m.title}
									{m.pro && <ProBadge />}
								</h3>
								<p className="text-sm text-white/70">{m.desc}</p>
							</div>
						</button>
					))}
				</div>

				{!(currentProject?.settings as Record<string, unknown>)?.externalDb && (
					<div className="flex items-center justify-center gap-2 mt-8 px-4 py-3 rounded-lg bg-surface-alt border border-border text-sm text-text-muted">
						<svg
							width="16"
							height="16"
							viewBox="0 0 24 24"
							fill="none"
							stroke="currentColor"
							strokeWidth="1.5"
							className="shrink-0"
						>
							<ellipse cx="12" cy="5" rx="9" ry="3" />
							<path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3" />
							<path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5" />
						</svg>
						{t('collections.new.builtinDbNote')}
					</div>
				)}
			</ScreenLayout>
		)
	}

	// ─── Screen: Choose Template ─────────────────────────────────────────────
	if (screen === 'template') {
		return (
			<ScreenLayout
				backLabel={t('collections.new.backToMethods')}
				onBack={() => setScreen('method')}
				title={t('collections.new.template.title')}
				subtitle={t('collections.new.template.subtitle')}
			>
				<div className="grid grid-cols-1 md:grid-cols-3 gap-4">
					{COLLECTION_TEMPLATES.map((tpl) => (
						<TemplateCard key={tpl.name} template={tpl} onSelect={applyTemplate} />
					))}
					<button
						type="button"
						onClick={() => setScreen('manual')}
						className="rounded-xl border-2 border-dashed border-border p-6 text-left hover:border-border-strong active:translate-x-px active:translate-y-px transition-all flex flex-col items-center justify-center min-h-[160px]"
					>
						<svg
							width="24"
							height="24"
							viewBox="0 0 24 24"
							fill="none"
							stroke="currentColor"
							strokeWidth="1.5"
							strokeLinecap="round"
							strokeLinejoin="round"
							className="text-text-muted mb-2"
						>
							<line x1="12" y1="5" x2="12" y2="19" />
							<line x1="5" y1="12" x2="19" y2="12" />
						</svg>
						<h3 className="font-semibold text-text-secondary mb-1">
							{t('collections.new.template.blankTitle')}
						</h3>
						<p className="text-xs text-text-muted">{t('collections.new.template.blankDesc')}</p>
					</button>
				</div>
			</ScreenLayout>
		)
	}

	// ─── Screen: Import from File ────────────────────────────────────────────
	if (screen === 'import-file') {
		return (
			<ScreenLayout
				backLabel={t('collections.new.backToMethods')}
				onBack={() => setScreen('method')}
				title={t('collections.new.importFile.title')}
				subtitle={t('collections.new.importFile.subtitle')}
				maxWidth="max-w-2xl"
			>
				<div className="space-y-6">
					<button
						type="button"
						className="border-2 border-dashed border-border rounded-lg py-16 px-6 w-full text-text-secondary text-sm hover:border-text-muted transition-colors flex flex-col items-center justify-center cursor-pointer"
						onClick={() => fileInputRef.current?.click()}
						onDragOver={(e) => {
							e.preventDefault()
							e.currentTarget.classList.add('border-text-secondary')
						}}
						onDragLeave={(e) => e.currentTarget.classList.remove('border-text-secondary')}
						onDrop={(e) => {
							e.preventDefault()
							e.currentTarget.classList.remove('border-text-secondary')
							if (e.dataTransfer.files.length)
								handleFileUpload({
									target: { files: e.dataTransfer.files },
								} as React.ChangeEvent<HTMLInputElement>)
						}}
					>
						<svg
							width="24"
							height="24"
							viewBox="0 0 24 24"
							fill="none"
							stroke="currentColor"
							strokeWidth="1.5"
							className="text-text-muted mb-3"
						>
							<path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4" />
							<polyline points="17 8 12 3 7 8" />
							<line x1="12" y1="3" x2="12" y2="15" />
						</svg>
						{t('collections.new.importFile.dropHint')}
					</button>
					<input
						ref={fileInputRef}
						type="file"
						accept=".csv,.json,.jsonl,.tsv,.md,.mdx,.yaml,.yml"
						onChange={handleFileUpload}
						className="hidden"
					/>
					{importError && <p className="text-sm text-danger text-center">{importError}</p>}
				</div>
			</ScreenLayout>
		)
	}

	// ─── Screen: Import with Paste ───────────────────────────────────────────
	if (screen === 'import-paste') {
		const parsePastedData = () => {
			setImportError('')
			if (importTab === 'json') {
				if (!jsonText.trim()) {
					setImportError(t('collections.new.errors.pasteJsonFirst'))
					return
				}
				const result = inferFieldsFromJSON(jsonText.trim())
				if (result.errorKey) {
					setImportError(t(result.errorKey))
					return
				}
				goToConfigureWithFields(result.fields)
			} else if (importTab === 'csv') {
				if (!csvText.trim()) {
					setImportError(t('collections.new.errors.pasteCsvFirst'))
					return
				}
				const result = inferFieldsFromCSV(csvText.trim())
				if (result.errorKey) {
					setImportError(t(result.errorKey))
					return
				}
				goToConfigureWithFields(result.fields)
			} else {
				if (!mdText.trim()) {
					setImportError(t('collections.new.errors.pasteYamlFirst'))
					return
				}
				const result = inferFieldsFromYAML(mdText.trim())
				if (result.errorKey) {
					setImportError(t(result.errorKey))
					return
				}
				goToConfigureWithFields(result.fields)
			}
		}
		const tabs = [
			{ id: 'json' as const, label: 'JSON' },
			{ id: 'csv' as const, label: 'CSV' },
			{ id: 'markdown' as const, label: 'YAML' },
		]
		return (
			<ScreenLayout
				backLabel={t('collections.new.backToMethods')}
				onBack={() => setScreen('method')}
				title={t('collections.new.importPaste.title')}
				subtitle={t('collections.new.importPaste.subtitle')}
				maxWidth="max-w-2xl"
			>
				<div className="space-y-5">
					<div className="flex border-b border-border">
						{tabs.map((tab) => (
							<button
								key={tab.id}
								type="button"
								onClick={() => {
									setImportTab(tab.id)
									setImportError('')
								}}
								className={`flex-1 px-5 py-2.5 text-sm font-medium -mb-px transition-colors ${importTab === tab.id ? 'border-b-2 border-text text-text' : 'text-text-secondary hover:text-text'}`}
							>
								{tab.label}
							</button>
						))}
					</div>

					{importTab === 'json' && (
						<div>
							<textarea
								value={jsonText}
								onChange={(e) => {
									setJsonText(e.target.value)
									setImportError('')
								}}
								placeholder={
									'{\n  "title": "My Article",\n  "price": 9.99,\n  "active": true,\n  "publishDate": "2024-01-15"\n}'
								}
								rows={10}
								className="w-full px-3 py-2 bg-input border border-border rounded text-sm font-mono focus:outline-none focus:border-border-strong resize-y"
							/>
							<p className="text-xs text-text-muted mt-1.5">
								{t('collections.new.importPaste.jsonHint')}
							</p>
						</div>
					)}

					{importTab === 'csv' && (
						<div>
							<textarea
								value={csvText}
								onChange={(e) => {
									setCsvText(e.target.value)
									setImportError('')
								}}
								placeholder="name,price,category\nWidget,9.99,Tools\nGadget,19.99,Electronics"
								rows={10}
								className="w-full px-3 py-2 bg-input border border-border rounded text-sm font-mono focus:outline-none focus:border-border-strong resize-y"
							/>
							<p className="text-xs text-text-muted mt-1.5">
								{t('collections.new.importPaste.csvHint')}
							</p>
						</div>
					)}

					{importTab === 'markdown' && (
						<div>
							<textarea
								value={mdText}
								onChange={(e) => {
									setMdText(e.target.value)
									setImportError('')
								}}
								placeholder={
									'title: My Article\nauthor: John\ndate: 2024-01-15\ntags: [seo, content]\ndraft: true\nprice: 9.99'
								}
								rows={10}
								className="w-full px-3 py-2 bg-input border border-border rounded text-sm font-mono focus:outline-none focus:border-border-strong resize-y"
							/>
							<p className="text-xs text-text-muted mt-1.5">
								{t('collections.new.importPaste.yamlHint')}
							</p>
						</div>
					)}

					{importError && <p className="text-sm text-danger">{importError}</p>}
					<div className="flex justify-end">
						<button
							type="button"
							onClick={parsePastedData}
							className="px-5 py-2.5 bg-btn-primary text-btn-primary-text rounded-lg text-sm font-medium hover:bg-btn-primary-hover disabled:opacity-40 transition-colors"
						>
							{t('collections.new.importPaste.detectFields')}
						</button>
					</div>
				</div>
			</ScreenLayout>
		)
	}

	// ─── Screen: AI Generate ─────────────────────────────────────────────────
	if (screen === 'ai-generate') {
		return (
			<ScreenLayout
				backLabel={t('collections.new.backToMethods')}
				onBack={() => setScreen('method')}
				title={t('collections.new.aiGenerate.title')}
				subtitle={t('collections.new.aiGenerate.subtitle')}
				maxWidth="max-w-2xl"
			>
				{hasFeature(license, 'ai-assistant') ? (
					<div className="space-y-4">
						<div>
							<label
								htmlFor="ai-collection-prompt"
								className="block text-xs text-text-secondary mb-1.5"
							>
								{t('collections.new.aiGenerate.promptLabel')}
							</label>
							<textarea
								id="ai-collection-prompt"
								value={aiPrompt}
								onChange={(e) => setAiPrompt(e.target.value)}
								placeholder={t('collections.new.aiGenerate.promptPlaceholder')}
								rows={5}
								className="w-full px-3 py-2 bg-input border border-border rounded text-sm focus:outline-none focus:border-border-strong resize-y"
							/>
						</div>
						{aiError && <p className="text-sm text-danger">{aiError}</p>}
						<div className="flex justify-end">
							<button
								type="button"
								onClick={generateWithAi}
								disabled={aiLoading || !aiPrompt.trim()}
								className="px-5 py-2.5 bg-btn-primary text-btn-primary-text rounded-lg text-sm font-medium hover:bg-btn-primary-hover disabled:opacity-40 transition-colors inline-flex items-center gap-2"
							>
								{aiLoading && (
									<div className="w-3.5 h-3.5 border-2 border-btn-primary-text border-t-transparent rounded-full animate-spin" />
								)}
								{aiLoading
									? t('collections.new.aiGenerate.generating')
									: t('collections.new.aiGenerate.generate')}
							</button>
						</div>
					</div>
				) : (
					<div className="text-center py-8">
						<p className="text-sm text-text-secondary mb-2">
							{t('collections.new.aiGenerate.requiresFeature')}
						</p>
						<p className="text-xs text-text-muted">
							{t('collections.new.aiGenerate.upgradePrompt')}
						</p>
					</div>
				)}
			</ScreenLayout>
		)
	}

	// ─── Screen: Copy from Existing ──────────────────────────────────────────
	if (screen === 'copy-existing') {
		return (
			<ScreenLayout
				backLabel={t('collections.new.backToMethods')}
				onBack={() => setScreen('method')}
				title={t('collections.new.copyExisting.title')}
				subtitle={t('collections.new.copyExisting.subtitle')}
			>
				<div className="grid grid-cols-1 md:grid-cols-3 gap-4">
					{collections.map((col) => (
						<button
							key={col.id}
							type="button"
							onClick={() => {
								setFields(col.fields)
								setScreen('configure')
							}}
							className="rounded-xl bg-zinc-800 dark:bg-zinc-700 p-6 text-left hover:bg-zinc-700 dark:hover:bg-zinc-600 active:translate-x-px active:translate-y-px transition-all flex flex-col"
						>
							<h3 className="font-semibold text-white mb-1">{col.label}</h3>
							<p className="text-xs text-white/50 font-mono mb-3">{col.name}</p>
							<div className="bg-white/10 rounded-lg p-3 space-y-1 w-full">
								{col.fields.slice(0, 5).map((f) => (
									<div
										key={f.name}
										className="flex items-center justify-between text-[10px] font-mono"
									>
										<span className="text-white">{f.name}</span>
										<span className="text-white/50">{f.type}</span>
									</div>
								))}
								{col.fields.length > 5 && (
									<p className="text-[10px] text-white/40">
										{t('collections.new.copyExisting.moreFields', {
											count: col.fields.length - 5,
										})}
									</p>
								)}
							</div>
						</button>
					))}
				</div>
			</ScreenLayout>
		)
	}

	// ─── Screen: Manual Input ────────────────────────────────────────────────
	if (screen === 'manual') {
		return (
			<ScreenLayout
				backLabel={t('collections.new.backToMethods')}
				onBack={() => setScreen('method')}
				title={t('collections.new.manual.title')}
				subtitle={t('collections.new.manual.subtitle')}
				maxWidth="max-w-3xl"
			>
				<div className="space-y-5">
					<Field label={t('collections.new.fields.label')}>
						<input
							type="text"
							value={label}
							onChange={(e) => {
								setLabel(e.target.value)
								setName(generateName(e.target.value))
							}}
							placeholder={t('collections.new.fields.labelPlaceholder')}
							className="w-full px-3 py-2 bg-input border border-border rounded text-sm focus:outline-none focus:border-border-strong"
						/>
					</Field>
					<Field label={t('collections.new.fields.name')}>
						<input
							type="text"
							value={name}
							onChange={(e) => setName(e.target.value)}
							className="w-full px-3 py-2 bg-input border border-border rounded text-sm font-mono focus:outline-none focus:border-border-strong"
						/>
					</Field>
					<Field label={t('collections.new.fields.description')}>
						<input
							type="text"
							value={description}
							onChange={(e) => setDescription(e.target.value)}
							placeholder={t('collections.new.fields.descriptionPlaceholder')}
							className="w-full px-3 py-2 bg-input border border-border rounded text-sm focus:outline-none focus:border-border-strong"
						/>
					</Field>
					<FieldEditor
						fields={fields}
						addField={addField}
						updateField={updateField}
						removeField={removeField}
						moveField={moveField}
					/>
					<div className="flex justify-end pt-4">
						<button
							type="button"
							onClick={save}
							disabled={saving}
							className="px-6 py-2 bg-btn-primary text-btn-primary-text rounded text-sm font-medium hover:bg-btn-primary-hover disabled:opacity-50"
						>
							{saving ? t('collections.new.saving') : t('collections.new.createCollection')}
						</button>
					</div>
				</div>
			</ScreenLayout>
		)
	}

	// ─── Screen: Configure (review & save) ───────────────────────────────────
	return (
		<ScreenLayout
			backLabel={t('collections.new.backToMethods')}
			onBack={() => setScreen('method')}
			title={t('collections.new.configure.title')}
			subtitle={t('collections.new.configure.subtitle', { count: fields.length })}
			maxWidth="max-w-3xl"
		>
			<div className="space-y-5">
				<Field label={t('collections.new.fields.label')}>
					<input
						type="text"
						value={label}
						onChange={(e) => {
							setLabel(e.target.value)
							if (!name) setName(generateName(e.target.value))
						}}
						placeholder={t('collections.new.fields.labelPlaceholder')}
						className="w-full px-3 py-2 bg-input border border-border rounded text-sm focus:outline-none focus:border-border-strong"
					/>
				</Field>
				<Field label={t('collections.new.fields.name')}>
					<input
						type="text"
						value={name}
						onChange={(e) => setName(e.target.value)}
						className="w-full px-3 py-2 bg-input border border-border rounded text-sm font-mono focus:outline-none focus:border-border-strong"
					/>
				</Field>
				<Field label={t('collections.new.fields.description')}>
					<input
						type="text"
						value={description}
						onChange={(e) => setDescription(e.target.value)}
						placeholder={t('collections.new.fields.descriptionPlaceholder')}
						className="w-full px-3 py-2 bg-input border border-border rounded text-sm focus:outline-none focus:border-border-strong"
					/>
				</Field>
				<FieldEditor
					fields={fields}
					addField={addField}
					updateField={updateField}
					removeField={removeField}
					moveField={moveField}
				/>
				<div className="flex justify-end pt-4">
					<button
						type="button"
						onClick={save}
						disabled={saving}
						className="px-6 py-2 bg-btn-primary text-btn-primary-text rounded text-sm font-medium hover:bg-btn-primary-hover disabled:opacity-50"
					>
						{saving ? t('collections.new.saving') : t('collections.new.createCollection')}
					</button>
				</div>
			</div>
		</ScreenLayout>
	)
}

// ─── Sub-components ──────────────────────────────────────────────────────────

function FieldEditor({
	fields,
	addField,
	updateField,
	removeField,
	moveField,
}: {
	fields: CollectionField[]
	addField: () => void
	updateField: (i: number, u: Partial<CollectionField>) => void
	removeField: (i: number) => void
	moveField: (i: number, d: -1 | 1) => void
}) {
	const { t } = useTranslation()
	return (
		<div>
			<div className="flex items-center justify-between mb-3">
				<div className="text-sm font-medium">{t('collections.new.fieldEditor.title')}</div>
				<button
					type="button"
					onClick={addField}
					className="px-3 py-1 bg-btn-secondary rounded text-xs hover:bg-btn-secondary-hover"
				>
					{t('collections.new.fieldEditor.addField')}
				</button>
			</div>
			{fields.length === 0 ? (
				<p className="text-text-secondary text-sm">{t('collections.new.fieldEditor.emptyHint')}</p>
			) : (
				<div className="divide-y divide-border">
					{fields.map((field, i) => (
						// biome-ignore lint/suspicious/noArrayIndexKey: field rows have no stable id and the name is mutable, so an index key avoids remounting the row (and losing input focus) on edit.
						<div key={i} className="flex items-center gap-3 px-3 py-2.5">
							<div className="flex flex-col gap-1 mr-2">
								<button
									type="button"
									onClick={() => moveField(i, -1)}
									className="text-text-secondary hover:text-text text-xs leading-none"
								>
									{'\u25B2'}
								</button>
								<button
									type="button"
									onClick={() => moveField(i, 1)}
									className="text-text-secondary hover:text-text text-xs leading-none"
								>
									{'\u25BC'}
								</button>
							</div>
							<input
								type="text"
								value={field.name}
								onChange={(e) => updateField(i, { name: e.target.value })}
								placeholder={t('collections.new.fieldEditor.fieldNamePlaceholder')}
								className="w-60 shrink-0 px-2 py-1.5 bg-input border border-border-strong rounded text-sm font-mono focus:outline-none"
							/>
							<Dropdown
								value={field.type}
								onChange={(v) => updateField(i, { type: v })}
								options={FIELD_TYPES.map((t) => ({ value: t, label: t }))}
								className="w-28 shrink-0"
							/>
							<label className="flex items-center gap-1.5 text-xs text-text-secondary shrink-0 ml-8">
								<input
									type="checkbox"
									checked={field.required || false}
									onChange={(e) => updateField(i, { required: e.target.checked })}
									className="rounded"
								/>{' '}
								{t('collections.new.fieldEditor.required')}
							</label>
							<label className="flex items-center gap-1.5 text-xs text-text-secondary shrink-0 ml-8">
								<input
									type="checkbox"
									checked={field.localized || false}
									onChange={(e) => updateField(i, { localized: e.target.checked })}
									className="rounded"
								/>{' '}
								{t('collections.new.fieldEditor.i18n')}
							</label>
							<button
								type="button"
								onClick={() => removeField(i)}
								className="text-text-muted hover:text-danger transition-colors px-1 shrink-0 ml-8"
							>
								<svg
									width="14"
									height="14"
									viewBox="0 0 24 24"
									fill="none"
									stroke="currentColor"
									strokeWidth="2"
									strokeLinecap="round"
									strokeLinejoin="round"
								>
									<polyline points="3 6 5 6 21 6" />
									<path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2" />
								</svg>
							</button>
						</div>
					))}
				</div>
			)}
		</div>
	)
}

const MAX_VISIBLE_FIELDS = 5

function TemplateCard({
	template,
	onSelect,
}: {
	template: CollectionTemplate
	onSelect: (t: CollectionTemplate) => void
}) {
	const { t } = useTranslation()
	const [expanded, setExpanded] = useState(false)
	const hasMore = template.fields.length > MAX_VISIBLE_FIELDS
	const visibleFields = expanded ? template.fields : template.fields.slice(0, MAX_VISIBLE_FIELDS)
	const hiddenCount = template.fields.length - MAX_VISIBLE_FIELDS
	// Fall back to inline label/description when no translation key exists for this template id.
	const labelKey = `collections.new.templates.${template.id}.label`
	const descKey = `collections.new.templates.${template.id}.description`
	const label = t(labelKey, { defaultValue: template.label })
	const description = t(descKey, { defaultValue: template.description })

	return (
		<button
			key={template.name}
			type="button"
			onClick={() => onSelect(template)}
			className="rounded-xl bg-zinc-800 dark:bg-zinc-700 p-6 text-left hover:bg-zinc-700 dark:hover:bg-zinc-600 active:translate-x-px active:translate-y-px transition-all flex flex-col"
		>
			<h3 className="font-semibold text-white mb-1">{label}</h3>
			<p className="text-xs text-white/70">{description}</p>
			<div className="bg-white/10 rounded-lg p-3 space-y-1 w-full mt-3">
				{visibleFields.map((f) => (
					<div key={f.name} className="flex items-center justify-between text-[10px] font-mono">
						<span className="text-white">
							{f.name}
							{f.required ? <sup className="text-white/40 ml-0.5">*</sup> : ''}
						</span>
						<span className="text-white/50">{f.type}</span>
					</div>
				))}
				{hasMore && (
					// biome-ignore lint/a11y/useSemanticElements: cannot use <button> here — this control is nested inside a parent <button>.
					<div
						role="button"
						onClick={(e) => {
							e.stopPropagation()
							setExpanded(!expanded)
						}}
						onKeyDown={(e) => {
							if (e.key === 'Enter' || e.key === ' ') {
								e.stopPropagation()
								setExpanded(!expanded)
							}
						}}
						tabIndex={0}
						className="text-[10px] text-white/40 hover:text-white/60 pt-1 cursor-pointer transition-colors"
					>
						{expanded
							? t('collections.new.templates.showLess')
							: t('collections.new.templates.showMore', { count: hiddenCount })}
					</div>
				)}
			</div>
		</button>
	)
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
	return (
		// biome-ignore lint/a11y/noLabelWithoutControl: generic field wrapper — the control is passed in as children and rendered inside this label.
		<label className="block">
			<span className="block text-sm font-medium mb-1.5">{label}</span>
			{children}
		</label>
	)
}
