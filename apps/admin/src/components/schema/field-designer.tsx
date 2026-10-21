/**
 * The field designer: where an admin decides once how a nested field looks to
 * editors.
 *
 * Detection proposes a shape; a human confirms it here, next to real values from
 * the collection. Left: the sampled values as they are. Right: the shape (a
 * preset from the catalogue, a project preset, or plain sub-fields), how its
 * roles map onto the document's keys, and per sub-key labels, help text,
 * visibility, read-only and required flags, order, and the key that titles a
 * collapsed row. Applying writes ordinary `ui` configuration on the field, so
 * nothing in the editor depends on this dialog — or on the optional AI
 * proposal — afterwards.
 *
 * Confirming a shape locks it by default (`allowExtraKeys: false`): editors get
 * the declared keys and nothing else, which is what keeps a simplified form
 * from producing documents the site cannot read.
 */

import {
	type CollectionField,
	FIELD_PRESETS,
	type FieldPreset,
	getPreset,
	resolvePresetKeys,
} from '@innolope/config'
import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { api } from '../../lib/api-client'
import { usePrompt } from '../../lib/confirm'
import { humanizeKey } from '../../lib/field-summary'
import { useToast } from '../../lib/toast'
import { Dropdown } from '../dropdown'

export interface ProjectFieldPreset {
	label: string
	appliesTo: 'object' | 'array'
	subFields: CollectionField[]
	summaryKey?: string
	allowExtraKeys?: boolean
}

interface FieldDesignerProps {
	collectionId: string
	field: CollectionField
	projectPresets: Record<string, ProjectFieldPreset>
	onApply: (field: CollectionField) => void
	onSaveProjectPreset: (id: string, preset: ProjectFieldPreset) => Promise<void>
	onClose: () => void
}

type SubFieldDraft = CollectionField

const SUB_FIELD_TYPES: CollectionField['type'][] = ['text', 'number', 'boolean', 'date', 'enum']

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === 'object' && !Array.isArray(value)
}

/** The objects a sample holds: itself, or the rows of an array. */
function sampleObjects(samples: unknown[]): Record<string, unknown>[] {
	return samples.flatMap((sample) =>
		Array.isArray(sample) ? sample.filter(isPlainObject) : isPlainObject(sample) ? [sample] : [],
	)
}

function inferType(values: unknown[]): CollectionField['type'] {
	const filled = values.filter((value) => value !== null && value !== undefined && value !== '')
	if (filled.length > 0 && filled.every((value) => typeof value === 'number')) return 'number'
	if (filled.length > 0 && filled.every((value) => typeof value === 'boolean')) return 'boolean'
	return 'text'
}

/** Sub-fields for the keys the samples hold, keeping any already configured. */
function draftSubFields(
	field: CollectionField,
	objects: Record<string, unknown>[],
): SubFieldDraft[] {
	const configured = field.ui?.subFields ?? []
	const keys = [...configured.map((sub) => sub.name)]
	for (const object of objects)
		for (const key of Object.keys(object)) if (!keys.includes(key)) keys.push(key)
	return keys.map(
		(key) =>
			configured.find((sub) => sub.name === key) ?? {
				name: key,
				type: inferType(objects.map((object) => object[key])),
			},
	)
}

/** Catalogue presets a field of this type can take. */
function presetsFor(type: CollectionField['type']): FieldPreset[] {
	return FIELD_PRESETS.filter((preset) => {
		if (preset.id === 'rich-text') return false
		if (type === 'object') return preset.targets.includes('object')
		if (type === 'array') return preset.targets.includes('rows') || preset.targets.includes('array')
		if (type === 'text') return preset.targets.includes('text')
		return false
	})
}

function slugify(text: string): string {
	return text
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '')
		.slice(0, 40)
}

const inputCls =
	'w-full px-2 py-1.5 bg-input border border-border rounded text-sm focus:outline-none focus:border-border-strong'

export function FieldDesigner({
	collectionId,
	field,
	projectPresets,
	onApply,
	onSaveProjectPreset,
	onClose,
}: FieldDesignerProps) {
	const { t } = useTranslation()
	const toast = useToast()
	const prompt = usePrompt()
	const [samples, setSamples] = useState<unknown[] | null>(null)
	const [label, setLabel] = useState(field.label ?? '')
	const [helpText, setHelpText] = useState(field.ui?.helpText ?? '')
	const [preset, setPreset] = useState(field.ui?.preset ?? '')
	const [presetKeys, setPresetKeys] = useState<Record<string, string>>(field.ui?.presetKeys ?? {})
	const [subFields, setSubFields] = useState<SubFieldDraft[]>(field.ui?.subFields ?? [])
	const [summaryKey, setSummaryKey] = useState(field.ui?.summaryKey ?? '')
	// A shape confirmed here is locked unless the admin opens it up.
	const [allowExtraKeys, setAllowExtraKeys] = useState(field.ui?.allowExtraKeys === true)
	const [proposing, setProposing] = useState(false)
	const detected =
		field.ui?.preset && !field.ui?.presetConfirmed ? getPreset(field.ui.preset) : undefined

	useEffect(() => {
		const onKeyDown = (e: KeyboardEvent) => {
			if (e.key === 'Escape') onClose()
		}
		document.addEventListener('keydown', onKeyDown)
		return () => document.removeEventListener('keydown', onKeyDown)
	}, [onClose])

	// biome-ignore lint/correctness/useExhaustiveDependencies: load once per field.
	useEffect(() => {
		api
			.get<{ values: unknown[] }>(
				`/api/v1/collections/${collectionId}/field-samples?field=${encodeURIComponent(field.name)}&limit=5`,
			)
			.then((res) => {
				setSamples(res.values)
				const objects = sampleObjects(res.values)
				setSubFields((current) => (current.length > 0 ? current : draftSubFields(field, objects)))
				// Map the preset's roles onto the keys the samples use.
				const active = getPreset(field.ui?.preset)
				if (active && !field.ui?.presetKeys && objects[0]) {
					setPresetKeys(resolvePresetKeys(active, objects[0]) ?? {})
				}
			})
			.catch(() => setSamples([]))
	}, [collectionId, field.name])

	const objects = useMemo(() => sampleObjects(samples ?? []), [samples])
	const keys = useMemo(() => {
		const list = subFields.map((sub) => sub.name)
		for (const object of objects)
			for (const key of Object.keys(object)) if (!list.includes(key)) list.push(key)
		return list
	}, [objects, subFields])
	const catalogue = presetsFor(field.type)
	const catalogPreset = getPreset(preset)
	const customId = preset.startsWith('custom:') ? preset.slice('custom:'.length) : null
	const customPresets = Object.entries(projectPresets).filter(
		([, entry]) => entry.appliesTo === (field.type === 'array' ? 'array' : 'object'),
	)

	const choosePreset = (next: string) => {
		setPreset(next)
		const chosen = getPreset(next)
		if (chosen && objects[0]) setPresetKeys(resolvePresetKeys(chosen, objects[0]) ?? {})
		if (next.startsWith('custom:')) {
			const entry = projectPresets[next.slice('custom:'.length)]
			if (entry) {
				setSubFields(entry.subFields)
				setSummaryKey(entry.summaryKey ?? '')
				setAllowExtraKeys(entry.allowExtraKeys === true)
			}
		}
	}

	const updateSub = (index: number, patch: Partial<SubFieldDraft>) =>
		setSubFields((current) => current.map((sub, i) => (i === index ? { ...sub, ...patch } : sub)))
	const updateSubUi = (index: number, patch: Partial<NonNullable<SubFieldDraft['ui']>>) =>
		setSubFields((current) =>
			current.map((sub, i) => {
				if (i !== index) return sub
				const ui = { ...sub.ui, ...patch }
				for (const key of Object.keys(ui) as (keyof typeof ui)[]) {
					if (ui[key] === undefined || ui[key] === false || ui[key] === '') delete ui[key]
				}
				return { ...sub, ui: Object.keys(ui).length ? ui : undefined }
			}),
		)
	const moveSub = (index: number, delta: -1 | 1) =>
		setSubFields((current) => {
			const target = index + delta
			if (target < 0 || target >= current.length) return current
			const next = [...current]
			;[next[index], next[target]] = [next[target], next[index]]
			return next
		})

	const propose = async () => {
		if (!samples?.length) return
		setProposing(true)
		try {
			const { proposal } = await api.post<{
				proposal: {
					label?: string
					helpText?: string
					preset?: string | null
					presetKeys?: Record<string, string>
					summaryKey?: string | null
					subFields?: Array<{ name: string; label?: string; helpText?: string }>
				}
			}>('/api/v1/ai/design-field', { fieldName: field.name, type: field.type, samples })
			if (proposal.label && !label) setLabel(proposal.label)
			if (proposal.helpText && !helpText) setHelpText(proposal.helpText)
			if (proposal.preset && catalogue.some((entry) => entry.id === proposal.preset)) {
				setPreset(proposal.preset)
				setPresetKeys(proposal.presetKeys ?? {})
			}
			if (proposal.summaryKey) setSummaryKey(proposal.summaryKey)
			if (proposal.subFields?.length) {
				setSubFields((current) => {
					const byName = new Map(current.map((sub) => [sub.name, sub]))
					const ordered =
						proposal.subFields?.map((entry) => {
							const existing = byName.get(entry.name) ?? { name: entry.name, type: 'text' as const }
							return {
								...existing,
								...(entry.label && !existing.label && { label: entry.label }),
								...(entry.helpText &&
									!existing.ui?.helpText && { ui: { ...existing.ui, helpText: entry.helpText } }),
							}
						}) ?? []
					const rest = current.filter((sub) => !ordered.some((entry) => entry.name === sub.name))
					return [...ordered, ...rest]
				})
			}
			toast(t('schema.designer.proposed'), 'success')
		} catch (err) {
			toast(err instanceof Error ? err.message : t('schema.designer.proposeFailed'), 'error')
		} finally {
			setProposing(false)
		}
	}

	const apply = () => {
		const ui: NonNullable<CollectionField['ui']> = { ...field.ui }
		const set = <K extends keyof typeof ui>(key: K, value: (typeof ui)[K] | undefined) => {
			if (value === undefined || value === '' || value === null) delete ui[key]
			else ui[key] = value
		}
		set('helpText', helpText.trim() || undefined)
		set('preset', preset || undefined)
		set('presetConfirmed', preset ? true : undefined)
		set('presetKeys', catalogPreset && Object.keys(presetKeys).length ? presetKeys : undefined)
		set('subFields', subFields.length ? subFields : undefined)
		set('summaryKey', summaryKey || undefined)
		// Confirming any shape locks it unless the admin opened it up.
		set('allowExtraKeys', allowExtraKeys ? true : false)
		onApply({
			...field,
			...(label.trim() ? { label: label.trim() } : { label: undefined }),
			ui,
		})
	}

	const saveAsProjectPreset = async () => {
		const name = await prompt({
			title: t('schema.designer.saveAsPreset'),
			label: t('schema.designer.presetNamePrompt'),
			defaultValue: label || humanizeKey(field.name),
			required: true,
			confirmLabel: t('schema.designer.savePreset'),
		})
		if (!name?.trim()) return
		const id = slugify(name)
		if (!id) return
		await onSaveProjectPreset(id, {
			label: name.trim(),
			appliesTo: field.type === 'array' ? 'array' : 'object',
			subFields,
			...(summaryKey && { summaryKey }),
			...(allowExtraKeys && { allowExtraKeys: true }),
		})
		setPreset(`custom:${id}`)
		toast(t('schema.designer.presetSaved', { name: name.trim() }), 'success')
	}

	const usesSubFields = !catalogPreset

	return (
		<div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
			<button
				type="button"
				aria-label={t('common.closeDialog')}
				className="absolute inset-0 -z-10 cursor-default"
				onClick={onClose}
			/>
			<div
				role="dialog"
				aria-modal="true"
				aria-label={t('schema.designer.title', { name: field.name })}
				className="flex max-h-[90vh] w-full max-w-5xl flex-col rounded-xl border border-border bg-surface shadow-2xl"
			>
				<div className="flex items-center justify-between border-b border-border px-6 py-4">
					<div>
						<h3 className="font-semibold text-text">
							{t('schema.designer.title', { name: field.label || field.name })}
						</h3>
						<p className="text-xs text-text-muted">{t('schema.designer.subtitle')}</p>
					</div>
					<button
						type="button"
						onClick={propose}
						disabled={proposing || !samples?.length}
						className="rounded bg-btn-secondary px-3 py-1.5 text-xs hover:bg-btn-secondary-hover disabled:opacity-50"
					>
						{proposing ? t('schema.designer.proposing') : t('schema.designer.propose')}
					</button>
				</div>

				<div className="grid min-h-0 flex-1 grid-cols-1 gap-0 overflow-hidden md:grid-cols-[2fr_3fr]">
					{/* Left: what the field actually holds. */}
					<div className="min-h-0 overflow-auto border-b border-border p-4 md:border-r md:border-b-0">
						<p className="mb-2 text-xs font-medium text-text-secondary">
							{t('schema.designer.samples')}
						</p>
						{samples === null ? (
							<p className="text-xs text-text-muted">{t('schema.designer.loadingSamples')}</p>
						) : samples.length === 0 ? (
							<p className="text-xs text-text-muted">{t('schema.designer.noSamples')}</p>
						) : (
							<div className="space-y-2">
								{samples.map((sample, index) => (
									<pre
										// biome-ignore lint/suspicious/noArrayIndexKey: samples are a static read-only list.
										key={index}
										className="max-h-56 overflow-auto rounded bg-input p-2 font-mono text-[11px] text-text-secondary"
									>
										{JSON.stringify(sample, null, 2)}
									</pre>
								))}
							</div>
						)}
					</div>

					{/* Right: how editors will see it. */}
					<div className="min-h-0 space-y-4 overflow-auto p-4">
						<div className="grid grid-cols-2 gap-3">
							<label className="block text-xs text-text-secondary">
								{t('schema.designer.label')}
								<input
									type="text"
									value={label}
									onChange={(e) => setLabel(e.target.value)}
									placeholder={humanizeKey(field.name)}
									className={`mt-1 ${inputCls}`}
								/>
							</label>
							<label className="block text-xs text-text-secondary">
								{t('schema.designer.helpText')}
								<input
									type="text"
									value={helpText}
									onChange={(e) => setHelpText(e.target.value)}
									className={`mt-1 ${inputCls}`}
								/>
							</label>
						</div>

						<div>
							<span className="mb-1 block text-xs text-text-secondary">
								{t('schema.designer.shape')}
							</span>
							<Dropdown
								value={preset || '__generic__'}
								onChange={(value) => choosePreset(value === '__generic__' ? '' : value)}
								options={[
									{ value: '__generic__', label: t('schema.designer.genericShape') },
									...catalogue.map((entry) => ({
										value: entry.id,
										label: t(`editor.presets.names.${entry.id}`),
									})),
									...customPresets.map(([id, entry]) => ({
										value: `custom:${id}`,
										label: t('schema.designer.projectPreset', { name: entry.label }),
									})),
								]}
								className="w-full"
							/>
							{detected && (
								<p className="mt-1 text-[11px] text-text-muted">
									{t('schema.designer.detected', {
										name: t(`editor.presets.names.${detected.id}`),
									})}
								</p>
							)}
						</div>

						{catalogPreset && catalogPreset.roles.length > 0 && (
							<div>
								<span className="mb-1 block text-xs text-text-secondary">
									{t('schema.designer.mapping')}
								</span>
								<div className="space-y-1.5">
									{catalogPreset.roles.map((role) => (
										<div key={role.role} className="grid grid-cols-[1fr_1.5fr] items-center gap-2">
											<span className="text-xs text-text-secondary">
												{role.role}
												{role.required && <span className="text-danger"> *</span>}
											</span>
											<Dropdown
												value={presetKeys[role.role] ?? ''}
												onChange={(value) =>
													setPresetKeys((current) => {
														const next = { ...current }
														if (value) next[role.role] = value
														else delete next[role.role]
														return next
													})
												}
												options={[
													{ value: '', label: t('schema.designer.unmapped') },
													...[...new Set([...keys, ...role.aliases])].map((key) => ({
														value: key,
														label: key,
													})),
												]}
												className="w-full"
											/>
										</div>
									))}
								</div>
							</div>
						)}

						{usesSubFields && subFields.length > 0 && (
							<div>
								<span className="mb-1 block text-xs text-text-secondary">
									{t('schema.designer.subFields')}
								</span>
								<div className="space-y-1.5">
									{subFields.map((sub, index) => (
										<div
											key={sub.name}
											className="grid grid-cols-[auto_minmax(5rem,1fr)_minmax(6rem,1.4fr)_6.5rem] items-center gap-2 rounded border border-border bg-surface-alt p-2"
										>
											<div className="flex flex-col leading-none">
												<button
													type="button"
													onClick={() => moveSub(index, -1)}
													disabled={index === 0}
													className="text-[10px] text-text-muted hover:text-text disabled:opacity-30"
													aria-label={t('schema.designer.moveUp', { name: sub.name })}
												>
													▲
												</button>
												<button
													type="button"
													onClick={() => moveSub(index, 1)}
													disabled={index === subFields.length - 1}
													className="text-[10px] text-text-muted hover:text-text disabled:opacity-30"
													aria-label={t('schema.designer.moveDown', { name: sub.name })}
												>
													▼
												</button>
											</div>
											<span className="truncate font-mono text-xs" title={sub.name}>
												{sub.name}
											</span>
											<input
												type="text"
												value={sub.label ?? ''}
												onChange={(e) => updateSub(index, { label: e.target.value || undefined })}
												placeholder={humanizeKey(sub.name)}
												className="w-full rounded border border-border bg-input px-2 py-1 text-xs focus:outline-none"
											/>
											<Dropdown
												value={sub.type}
												onChange={(value) =>
													updateSub(index, { type: value as CollectionField['type'] })
												}
												options={SUB_FIELD_TYPES.map((type) => ({ value: type, label: type }))}
												className="w-full"
											/>
											<input
												type="text"
												value={sub.ui?.helpText ?? ''}
												onChange={(e) =>
													updateSubUi(index, { helpText: e.target.value || undefined })
												}
												placeholder={t('schema.designer.subHelp')}
												className="col-span-3 col-start-2 w-full rounded border border-border bg-input px-2 py-1 text-xs focus:outline-none"
											/>
											<div className="col-span-4 col-start-2 flex flex-wrap gap-3 text-xs text-text-secondary">
												<label className="flex items-center gap-1">
													<input
														type="checkbox"
														checked={sub.required === true}
														onChange={(e) =>
															updateSub(index, { required: e.target.checked || undefined })
														}
													/>
													{t('schema.designer.required')}
												</label>
												<label className="flex items-center gap-1">
													<input
														type="checkbox"
														checked={sub.ui?.readOnly === true}
														onChange={(e) => updateSubUi(index, { readOnly: e.target.checked })}
													/>
													{t('schema.designer.readOnly')}
												</label>
												<label className="flex items-center gap-1">
													<input
														type="checkbox"
														checked={sub.ui?.hidden === true}
														onChange={(e) => updateSubUi(index, { hidden: e.target.checked })}
													/>
													{t('schema.designer.hidden')}
												</label>
												{sub.type === 'enum' && (
													<input
														type="text"
														value={(sub.options ?? []).join(', ')}
														onChange={(e) =>
															updateSub(index, {
																options: e.target.value
																	.split(',')
																	.map((option) => option.trim())
																	.filter(Boolean),
															})
														}
														placeholder={t('schema.designer.options')}
														className="min-w-[10rem] flex-1 rounded border border-border bg-input px-2 py-0.5 text-xs focus:outline-none"
													/>
												)}
											</div>
										</div>
									))}
								</div>
							</div>
						)}

						{(field.type === 'array' || field.type === 'object') && keys.length > 0 && (
							<div className="grid grid-cols-2 gap-3">
								<div>
									<span className="mb-1 block text-xs text-text-secondary">
										{t('schema.designer.summaryKey')}
									</span>
									<Dropdown
										value={summaryKey}
										onChange={setSummaryKey}
										options={[
											{ value: '', label: t('schema.designer.summaryAuto') },
											...keys.map((key) => ({ value: key, label: key })),
										]}
										className="w-full"
									/>
								</div>
								<label className="flex items-end gap-2 pb-1 text-xs text-text-secondary">
									<input
										type="checkbox"
										checked={allowExtraKeys}
										onChange={(e) => setAllowExtraKeys(e.target.checked)}
									/>
									{t('schema.designer.allowExtraKeys')}
								</label>
							</div>
						)}
						<p className="text-[11px] text-text-muted">{t('schema.designer.lockNote')}</p>
					</div>
				</div>

				<div className="flex items-center justify-between gap-2 border-t border-border px-6 py-3">
					{usesSubFields && subFields.length > 0 && !customId ? (
						<button
							type="button"
							onClick={saveAsProjectPreset}
							className="text-xs text-text-muted hover:text-text"
						>
							{t('schema.designer.saveAsPreset')}
						</button>
					) : (
						<span />
					)}
					<div className="flex gap-2">
						<button
							type="button"
							onClick={onClose}
							className="rounded px-4 py-2 text-sm text-text-secondary hover:text-text"
						>
							{t('common.cancel')}
						</button>
						<button
							type="button"
							onClick={apply}
							className="rounded bg-btn-primary px-4 py-2 text-sm font-medium text-btn-primary-text hover:bg-btn-primary-hover"
						>
							{t('schema.designer.apply')}
						</button>
					</div>
				</div>
			</div>
		</div>
	)
}
