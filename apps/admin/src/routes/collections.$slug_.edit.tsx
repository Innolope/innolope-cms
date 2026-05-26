import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { Dropdown } from '../components/dropdown'
import { api } from '../lib/api-client'
import { useAuth } from '../lib/auth'
import { useCollections } from '../lib/collections'
import { useConfirm } from '../lib/confirm'
import { useToast } from '../lib/toast'

export const Route = createFileRoute('/collections/$slug_/edit')({
	component: CollectionSchemaEditor,
})

interface CollectionFieldUi {
	widget?: string
	placeholder?: string
	helpText?: string
	rows?: number
	separator?: 'enter' | 'comma' | 'both'
	readOnly?: boolean
	hidden?: boolean
}

interface CollectionField {
	name: string
	type: string
	required?: boolean
	localized?: boolean
	options?: string[]
	ui?: CollectionFieldUi
}

const FIELD_TYPES = ['text', 'number', 'boolean', 'date', 'enum', 'relation', 'object', 'array']

/**
 * Widget catalog — what UI representations are valid for each field type. The
 * first entry per row is the default. Keep this in sync with `defaultWidgetFor`
 * + the renderer dispatch in `collections.$slug.$contentId.tsx`.
 */
const WIDGETS_BY_TYPE: Record<string, string[]> = {
	text: ['input', 'textarea', 'dropdown', 'radio', 'richtext', 'slug', 'url', 'markdown'],
	number: ['input', 'currency', 'range'],
	boolean: ['checkbox', 'switch'],
	date: ['date', 'datetime'],
	enum: ['dropdown', 'radio', 'chips'],
	array: ['chips', 'list', 'table', 'repeater'],
	object: ['json', 'subform'],
	relation: ['picker', 'multiselect'],
}

function CollectionSchemaEditor() {
	const { slug } = Route.useParams()
	const navigate = useNavigate()
	const toast = useToast()
	const confirm = useConfirm()
	const { currentProject } = useAuth()
	const { getCollectionByName, refreshCollections } = useCollections()
	const collection = getCollectionByName(slug)

	const [label, setLabel] = useState('')
	const [collectionName, setCollectionName] = useState('')
	const [description, setDescription] = useState('')
	const [fields, setFields] = useState<CollectionField[]>([])
	// Which schema field this collection uses as the row label in lists + pickers.
	// `null` = use the smart heuristic (display-title.ts).
	const [titleField, setTitleField] = useState<string | null>(null)
	const [sidebarMode, setSidebarMode] = useState<'auto' | 'show' | 'hide'>('auto')
	// Which field rows have their "Advanced" expander open. Keyed by index.
	const [expandedRows, setExpandedRows] = useState<Set<number>>(new Set())
	const [saving, setSaving] = useState(false)
	const [loading, setLoading] = useState(true)
	const [scanning, setScanning] = useState(false)

	useEffect(() => {
		if (collection) {
			api
				.get<{
					name: string
					label: string
					description: string | null
					fields: CollectionField[]
					titleField?: string | null
					sidebarMode?: 'auto' | 'show' | 'hide'
				}>(`/api/v1/collections/${collection.id}`)
				.then((col) => {
					setLabel(col.label)
					setCollectionName(col.name)
					setDescription(col.description || '')
					setFields(col.fields)
					setTitleField(col.titleField ?? null)
					setSidebarMode(col.sidebarMode ?? 'auto')
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

	/** Patch the nested `ui` blob on a field. Pass `null` for a key to clear it. */
	const updateFieldUi = (index: number, uiUpdates: Partial<CollectionFieldUi>) => {
		setFields(
			fields.map((f, i) => {
				if (i !== index) return f
				const merged: CollectionFieldUi = { ...(f.ui ?? {}), ...uiUpdates }
				// Drop keys whose value is null/undefined/'' so we don't bloat the JSONB.
				for (const k of Object.keys(merged) as (keyof CollectionFieldUi)[]) {
					const v = merged[k]
					if (v === null || v === undefined || v === '') delete merged[k]
				}
				return { ...f, ui: Object.keys(merged).length ? merged : undefined }
			}),
		)
	}

	const toggleExpanded = (index: number) => {
		setExpandedRows((prev) => {
			const next = new Set(prev)
			if (next.has(index)) next.delete(index)
			else next.add(index)
			return next
		})
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
		if (!collection || !label.trim()) {
			toast('Label is required', 'error')
			return
		}
		const validFields = fields.filter((f) => f.name.trim())
		setSaving(true)
		try {
			await api.put(`/api/v1/collections/${collection.id}`, {
				label,
				name: collectionName,
				description: description || undefined,
				fields: validFields,
				titleField: titleField || null,
				sidebarMode,
			})
			await refreshCollections()
			navigate({ to: `/collections/${collectionName}` })
		} catch (err) {
			toast(err instanceof Error ? err.message : 'Save failed', 'error')
		} finally {
			setSaving(false)
		}
	}

	const deleteCollection = async () => {
		if (!collection) return
		const ok = await confirm({
			title: 'Delete collection',
			message: `Delete "${name}" and all its content? This cannot be undone.`,
			confirmLabel: 'Delete',
			danger: true,
		})
		if (!ok) return
		try {
			await api.delete(`/api/v1/collections/${collection.id}`)
			await refreshCollections()
			navigate({ to: '/dashboard' })
		} catch (err) {
			toast(err instanceof Error ? err.message : 'Delete failed', 'error')
		}
	}

	if (loading) return <div className="p-8 pt-5" />
	if (!collection)
		return <div className="p-8 pt-5 text-text-secondary text-sm">Collection not found.</div>

	return (
		<div className="p-8 pt-5 max-w-3xl">
			<div className="flex items-center gap-2 text-sm text-text-muted mb-6">
				<button
					type="button"
					onClick={() => navigate({ to: `/collections/${slug}` })}
					className="hover:text-text transition-colors"
				>
					{collection.label}
				</button>
				<span>/</span>
				<span className="text-text">Edit Schema</span>
			</div>

			<h2 className="text-2xl font-bold mb-6">Edit: {label}</h2>

			<div className="space-y-5">
				<Field label="Label">
					<input
						type="text"
						value={label}
						onChange={(e) => setLabel(e.target.value)}
						className="w-full px-3 py-2 bg-input border border-border rounded text-sm focus:outline-none focus:border-border-strong"
					/>
				</Field>

				<Field label="Name">
					<input
						type="text"
						value={collectionName}
						onChange={(e) => setCollectionName(e.target.value)}
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

				<Field label="Display title field">
					<Dropdown
						value={titleField ?? '__auto__'}
						onChange={(v) => setTitleField(v === '__auto__' ? null : v)}
						options={[
							{ value: '__auto__', label: 'Auto (smart heuristic)' },
							...fields.filter((f) => f.name.trim()).map((f) => ({ value: f.name, label: f.name })),
						]}
					/>
					<p className="mt-1 text-xs text-text-muted">
						Used as the row label in list views and reference pickers. Auto picks <code>title</code>{' '}
						→ <code>name</code> → a name-like field → the first text field.
					</p>
				</Field>

				<Field label="Sidebar visibility">
					<Dropdown
						value={sidebarMode}
						onChange={(v) => setSidebarMode(v as 'auto' | 'show' | 'hide')}
						options={[
							{ value: 'auto', label: 'Auto (hide when used only as a relation target)' },
							{ value: 'show', label: 'Always show' },
							{ value: 'hide', label: 'Always hide (accessible via relations only)' },
						]}
					/>
					<p className="mt-1 text-xs text-text-muted">
						Auto hides collections that another collection references via a relation field, so
						lookup-only collections (tags, authors, categories) don't clutter the sidebar.
					</p>
				</Field>

				<div>
					<div className="flex items-center justify-between mb-3">
						<div className="text-sm font-medium">Fields</div>
						<div className="flex gap-2">
							{collection?.source === 'external' && currentProject && (
								<button
									type="button"
									disabled={scanning}
									onClick={async () => {
										if (!currentProject || !collection) return
										setScanning(true)
										try {
											const settings = currentProject.settings as unknown as Record<string, unknown>
											const extDb = settings?.externalDb as Record<string, unknown> | undefined
											if (!extDb?.type) throw new Error('No external DB config')
											const result = await api.post<{
												tables: Array<{ name: string; columns: { name: string; type: string }[] }>
											}>(`/api/v1/projects/${currentProject.id}/database/scan`, {
												type: extDb.type,
												database: extDb.database || undefined,
											})
											const match = result.tables.find((t) => t.name === collection.name)
											if (match) {
												const existingNames = new Set(fields.map((f) => f.name))
												const newFields = match.columns
													.filter(
														(c) =>
															c.name !== '_id' && c.name !== 'id' && !existingNames.has(c.name),
													)
													.map((c) => ({
														name: c.name,
														type:
															c.type === 'string'
																? 'text'
																: c.type === 'number'
																	? 'number'
																	: c.type === 'boolean'
																		? 'boolean'
																		: 'text',
														required: false,
														localized: false,
													}))
												if (newFields.length > 0) {
													setFields([...fields, ...newFields])
													toast(
														`Found ${newFields.length} new field${newFields.length !== 1 ? 's' : ''}`,
														'success',
													)
												} else {
													toast('No new fields found', 'success')
												}
											}
										} catch (err) {
											toast(err instanceof Error ? err.message : 'Scan failed', 'error')
										} finally {
											setScanning(false)
										}
									}}
									className="px-3 py-1 bg-btn-secondary rounded text-xs hover:bg-btn-secondary-hover disabled:opacity-40 inline-flex items-center gap-1.5"
								>
									{scanning && (
										<div className="w-3 h-3 border-2 border-text-muted border-t-transparent rounded-full animate-spin" />
									)}
									{scanning ? 'Scanning...' : 'Re-scan from DB'}
								</button>
							)}
							<button
								type="button"
								onClick={addField}
								className="px-3 py-1 bg-btn-secondary rounded text-xs hover:bg-btn-secondary-hover"
							>
								+ Add Field
							</button>
						</div>
					</div>

					{fields.length === 0 ? (
						<p className="text-text-secondary text-sm">
							No fields yet. Every collection gets markdown content by default.
						</p>
					) : (
						<div className="space-y-2">
							{fields.map((field, i) => (
								<div
									// biome-ignore lint/suspicious/noArrayIndexKey: field rows have no stable id and the name is mutable, so an index key avoids remounting the row (and losing input focus) on edit.
									key={i}
									className="flex flex-wrap items-center gap-2 p-3 bg-surface rounded-lg border border-border"
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
										onChange={(v) =>
											updateField(i, {
												type: v,
												// Clear options when leaving enum
												...(v !== 'enum' && { options: undefined }),
												// Clear an incompatible widget when the type changes
												...(field.ui?.widget &&
													!(WIDGETS_BY_TYPE[v] ?? []).includes(field.ui.widget) && {
														ui: { ...field.ui, widget: undefined },
													}),
											})
										}
										options={FIELD_TYPES.map((t) => ({ value: t, label: t }))}
										className="w-32 shrink-0"
									/>
									{(WIDGETS_BY_TYPE[field.type] ?? []).length > 1 && (
										<Dropdown
											value={field.ui?.widget ?? WIDGETS_BY_TYPE[field.type]?.[0] ?? ''}
											onChange={(v) =>
												updateFieldUi(i, {
													// store undefined when picking the default so we don't bloat JSON
													widget: v === WIDGETS_BY_TYPE[field.type]?.[0] ? undefined : v,
												})
											}
											options={(WIDGETS_BY_TYPE[field.type] ?? []).map((w, idx) => ({
												value: w,
												label: idx === 0 ? `${w} (default)` : w,
											}))}
											className="w-32 shrink-0"
										/>
									)}
									<label className="flex items-center gap-1 text-xs text-text-secondary">
										<input
											type="checkbox"
											checked={field.required || false}
											onChange={(e) => updateField(i, { required: e.target.checked })}
										/>{' '}
										Required
									</label>
									<label className="flex items-center gap-1 text-xs text-text-secondary">
										<input
											type="checkbox"
											checked={field.localized || false}
											onChange={(e) => updateField(i, { localized: e.target.checked })}
										/>{' '}
										i18n
									</label>
									<button
										type="button"
										onClick={() => toggleExpanded(i)}
										className="text-text-secondary hover:text-text text-xs px-2"
										aria-expanded={expandedRows.has(i)}
										title={expandedRows.has(i) ? 'Hide advanced' : 'Show advanced'}
									>
										…
									</button>
									<button
										type="button"
										onClick={() => removeField(i)}
										className="text-danger hover:opacity-80 text-xs px-2"
									>
										Remove
									</button>
									{field.type === 'enum' && (
										<input
											type="text"
											value={(field.options ?? []).join(', ')}
											onChange={(e) =>
												updateField(i, {
													options: e.target.value
														.split(',')
														.map((s) => s.trim())
														.filter(Boolean),
												})
											}
											placeholder="Dropdown options (comma-separated)"
											className="w-full px-2 py-1.5 bg-input border border-border rounded text-sm focus:outline-none"
										/>
									)}
									{expandedRows.has(i) && (
										<div className="w-full mt-2 pt-2 border-t border-border space-y-2">
											<label className="block text-xs text-text-secondary">
												Placeholder
												<input
													type="text"
													value={field.ui?.placeholder ?? ''}
													onChange={(e) =>
														updateFieldUi(i, { placeholder: e.target.value || undefined })
													}
													placeholder="Shown inside the empty input"
													className="mt-1 w-full px-2 py-1.5 bg-input border border-border rounded text-sm focus:outline-none"
												/>
											</label>
											<label className="block text-xs text-text-secondary">
												Help text
												<input
													type="text"
													value={field.ui?.helpText ?? ''}
													onChange={(e) =>
														updateFieldUi(i, { helpText: e.target.value || undefined })
													}
													placeholder="Short hint shown below the input"
													className="mt-1 w-full px-2 py-1.5 bg-input border border-border rounded text-sm focus:outline-none"
												/>
											</label>
											{field.type === 'text' && field.ui?.widget === 'textarea' && (
												<label className="block text-xs text-text-secondary">
													Rows
													<input
														type="number"
														min={1}
														max={40}
														value={field.ui?.rows ?? ''}
														onChange={(e) =>
															updateFieldUi(i, {
																rows: e.target.value ? Number(e.target.value) : undefined,
															})
														}
														className="mt-1 w-24 px-2 py-1.5 bg-input border border-border rounded text-sm focus:outline-none"
													/>
												</label>
											)}
											{field.type === 'array' && (
												<div className="block text-xs text-text-secondary">
													<span>Chip separator</span>
													<Dropdown
														value={field.ui?.separator ?? 'enter'}
														onChange={(v) =>
															updateFieldUi(i, {
																separator:
																	v === 'enter' ? undefined : (v as 'enter' | 'comma' | 'both'),
															})
														}
														options={[
															{ value: 'enter', label: 'Enter only (default)' },
															{ value: 'comma', label: 'Enter or comma' },
														]}
														className="mt-1 w-48"
													/>
												</div>
											)}
											<div className="flex flex-wrap gap-3">
												<label className="flex items-center gap-1 text-xs text-text-secondary">
													<input
														type="checkbox"
														checked={field.ui?.readOnly || false}
														onChange={(e) =>
															updateFieldUi(i, { readOnly: e.target.checked || undefined })
														}
													/>{' '}
													Read-only (system-managed)
												</label>
												<label className="flex items-center gap-1 text-xs text-text-secondary">
													<input
														type="checkbox"
														checked={field.ui?.hidden || false}
														onChange={(e) =>
															updateFieldUi(i, { hidden: e.target.checked || undefined })
														}
													/>{' '}
													Hidden from form
												</label>
											</div>
										</div>
									)}
								</div>
							))}
						</div>
					)}
				</div>

				<div className="flex items-center justify-between pt-4">
					<button
						type="button"
						onClick={save}
						disabled={saving}
						className="px-6 py-2 bg-btn-primary text-btn-primary-text rounded text-sm font-medium hover:bg-btn-primary-hover disabled:opacity-50"
					>
						{saving ? 'Saving...' : 'Save Changes'}
					</button>
					<button
						type="button"
						onClick={deleteCollection}
						className="text-xs text-danger hover:opacity-80"
					>
						Delete Collection
					</button>
				</div>
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
