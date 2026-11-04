import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { api } from '../../lib/api-client'
import { useAuth } from '../../lib/auth'
import { useToast } from '../../lib/toast'
import { Dropdown } from '../dropdown'

type TargetSetting = 'auto' | 'library' | 'collection'

/** Media-record columns an agent upload fills; unset keys are auto-detected server-side. */
const FIELD_KEYS = ['alt', 'filename', 'path', 'mimeType', 'size', 'width', 'height'] as const
type FieldKey = (typeof FIELD_KEYS)[number]

const TYPE_LABELS: Record<string, string> = {
	'image/jpeg': 'JPEG',
	'image/png': 'PNG',
	'image/webp': 'WebP',
	'image/gif': 'GIF',
}

/** Shape of GET /api/v1/media/upload-target. */
interface UploadTarget {
	setting: {
		target: TargetSetting
		collectionId: string | null
		fields: Record<string, string>
		deliveryVariant: string | null
	}
	resolved: {
		kind: 'library' | 'collection' | null
		collectionId: string | null
		collectionName: string | null
		collectionLabel: string | null
		fields: Record<FieldKey, string | null> | null
		deliveryVariant: string | null
	}
	candidates: Array<{ id: string; name: string; label: string }>
	allowedTypes: string[]
	maxBytes: number
	canUpload: boolean
	problem: string | null
}

interface CollectionRow {
	id: string
	fields: Array<{ name: string; type: string }>
}

/**
 * Where images uploaded by AI agents over MCP (upload_media and friends) are
 * written. A site that reads media from its own database (an imported media
 * collection) needs uploads to land there, with the right columns filled —
 * otherwise an agent's image exists in the CMS but never on the site.
 */
export function AgentUploadSettings() {
	const { t } = useTranslation()
	const { currentProject, refreshProjects } = useAuth()
	const toast = useToast()
	const [info, setInfo] = useState<UploadTarget | null>(null)
	const [collections, setCollections] = useState<CollectionRow[]>([])
	const [loading, setLoading] = useState(true)
	const [saving, setSaving] = useState(false)
	const [target, setTarget] = useState<TargetSetting>('auto')
	const [collectionId, setCollectionId] = useState('')
	const [fields, setFields] = useState<Record<string, string>>({})
	const [deliveryVariant, setDeliveryVariant] = useState('')

	const projectId = currentProject?.id

	const apply = useCallback((next: UploadTarget) => {
		setInfo(next)
		setTarget(next.setting.target)
		setCollectionId(next.setting.collectionId ?? '')
		setFields(next.setting.fields ?? {})
		setDeliveryVariant(next.setting.deliveryVariant ?? '')
	}, [])

	const load = useCallback(async () => {
		if (!projectId) return
		try {
			const [next, cols] = await Promise.all([
				api.get<UploadTarget>('/api/v1/media/upload-target'),
				api.get<CollectionRow[]>('/api/v1/collections'),
			])
			apply(next)
			setCollections(cols)
		} catch (err) {
			toast(err instanceof Error ? err.message : t('settings.agentUploads.loadFailed'), 'error')
		} finally {
			setLoading(false)
		}
	}, [projectId, apply, toast, t])

	useEffect(() => {
		load()
	}, [load])

	if (loading || !info) {
		return <p className="text-text-secondary text-sm">{t('common.loading')}</p>
	}

	const stored = info.setting
	const cleanFields = Object.fromEntries(Object.entries(fields).filter(([, v]) => v))
	const dirty =
		target !== stored.target ||
		(target === 'collection' && collectionId !== (stored.collectionId ?? '')) ||
		JSON.stringify(cleanFields) !== JSON.stringify(stored.fields ?? {}) ||
		deliveryVariant.trim() !== (stored.deliveryVariant ?? '')

	// The collection whose columns the mapping refers to: the explicit pick, or
	// whatever `auto` resolved to on the server.
	const mappedCollectionId =
		target === 'collection'
			? collectionId
			: target === 'auto' && info.resolved.kind === 'collection'
				? info.resolved.collectionId
				: null
	const mappedCollection = collections.find((c) => c.id === mappedCollectionId)
	// Detected columns are only known for the collection the server resolved.
	const detected = mappedCollectionId === info.resolved.collectionId ? info.resolved.fields : null

	const save = async () => {
		if (!currentProject) return
		if (target === 'collection' && !collectionId) {
			toast(t('settings.agentUploads.pickCollection'), 'error')
			return
		}
		setSaving(true)
		try {
			await api.put(`/api/v1/projects/${currentProject.id}`, {
				settings: {
					...(currentProject.settings as Record<string, unknown>),
					mediaUploads: {
						target,
						...(target === 'collection' && { collectionId }),
						...(Object.keys(cleanFields).length > 0 && { fields: cleanFields }),
						...(deliveryVariant.trim() && { deliveryVariant: deliveryVariant.trim() }),
					},
				},
			})
			toast(t('settings.agentUploads.saved'), 'success')
			await refreshProjects()
			apply(await api.get<UploadTarget>('/api/v1/media/upload-target'))
		} catch (err) {
			toast(err instanceof Error ? err.message : t('settings.agentUploads.saveFailed'), 'error')
		} finally {
			setSaving(false)
		}
	}

	const resolvedSummary =
		info.resolved.kind === 'collection'
			? t('settings.agentUploads.resolvedCollection', {
					name: info.resolved.collectionLabel || info.resolved.collectionName,
				})
			: info.resolved.kind === 'library'
				? t('settings.agentUploads.resolvedLibrary')
				: null

	return (
		<div className="space-y-6 max-w-xl">
			<p className="text-sm text-text-secondary">{t('settings.agentUploads.intro')}</p>

			<div className="rounded-lg border border-border bg-surface p-4 space-y-1">
				{resolvedSummary && <p className="text-sm text-text">{resolvedSummary}</p>}
				{info.resolved.deliveryVariant && (
					<p className="text-xs text-text-muted">
						{t('settings.agentUploads.resolvedVariant')}{' '}
						<code className="font-mono">{info.resolved.deliveryVariant}</code>
					</p>
				)}
				<p className="text-xs text-text-muted">
					{t('settings.agentUploads.limits', {
						types: info.allowedTypes.map((m) => TYPE_LABELS[m] ?? m).join(', '),
						size: Math.round(info.maxBytes / (1024 * 1024)),
					})}
				</p>
				{info.problem && <p className="text-xs text-warning">{info.problem}</p>}
			</div>

			<div>
				<div className="block text-xs text-text-secondary mb-1.5">
					{t('settings.agentUploads.target')}
				</div>
				<Dropdown
					value={target}
					onChange={(v) => {
						setTarget(v as TargetSetting)
						// A single candidate is the only possible pick — preselect it.
						if (v === 'collection' && !collectionId && info.candidates.length === 1) {
							setCollectionId(info.candidates[0].id)
						}
					}}
					options={[
						{ value: 'auto', label: t('settings.agentUploads.targets.auto') },
						{ value: 'library', label: t('settings.agentUploads.targets.library') },
						{
							value: 'collection',
							label: t('settings.agentUploads.targets.collection'),
							disabled: info.candidates.length === 0,
						},
					]}
					className="w-full max-w-xs"
				/>
				<p className="text-[11px] text-text-muted mt-1">
					{t(`settings.agentUploads.targetHelp.${target}`)}
				</p>
			</div>

			{target === 'collection' && (
				<div>
					<div className="block text-xs text-text-secondary mb-1.5">
						{t('settings.agentUploads.collection')}
					</div>
					<Dropdown
						value={collectionId}
						onChange={(v) => {
							setCollectionId(v)
							setFields({})
						}}
						options={info.candidates.map((c) => ({ value: c.id, label: c.label || c.name }))}
						placeholder={t('settings.agentUploads.pickCollection')}
						className="w-full max-w-xs"
					/>
				</div>
			)}

			{mappedCollection && (
				<div className="space-y-3">
					<div>
						<p className="text-sm font-medium text-text">
							{t('settings.agentUploads.fieldsTitle')}
						</p>
						<p className="text-xs text-text-muted mt-1">{t('settings.agentUploads.fieldsHelp')}</p>
					</div>
					<div className="grid grid-cols-[8rem_1fr] items-center gap-x-3 gap-y-2">
						{FIELD_KEYS.map((key) => {
							const auto = detected?.[key]
							return (
								<FieldRow
									key={key}
									label={t(`settings.agentUploads.fields.${key}`)}
									value={fields[key] ?? ''}
									onChange={(v) => setFields((prev) => ({ ...prev, [key]: v }))}
									autoLabel={
										auto
											? t('settings.agentUploads.autoDetected', { field: auto })
											: t('settings.agentUploads.autoDetect')
									}
									columns={mappedCollection.fields.map((f) => f.name)}
								/>
							)
						})}
					</div>
				</div>
			)}

			<div>
				<label htmlFor="agent-upload-variant" className="block text-xs text-text-secondary mb-1.5">
					{t('settings.agentUploads.deliveryVariant')}
				</label>
				<input
					id="agent-upload-variant"
					type="text"
					value={deliveryVariant}
					onChange={(e) => setDeliveryVariant(e.target.value)}
					placeholder={info.resolved.deliveryVariant || 'public'}
					className="w-full max-w-sm px-3 py-2 bg-input border border-border-strong rounded text-sm text-text font-mono focus:outline-none focus:border-border-strong"
				/>
				<p className="text-[11px] text-text-muted mt-1">
					{t('settings.agentUploads.deliveryVariantHelp')}
				</p>
			</div>

			{dirty && (
				<button
					type="button"
					onClick={save}
					disabled={saving}
					className="px-4 py-2 bg-btn-primary text-btn-primary-text rounded text-sm font-medium hover:bg-btn-primary-hover disabled:opacity-50"
				>
					{saving ? t('settings.agentUploads.saving') : t('settings.agentUploads.save')}
				</button>
			)}
		</div>
	)
}

function FieldRow({
	label,
	value,
	onChange,
	autoLabel,
	columns,
}: {
	label: string
	value: string
	onChange: (v: string) => void
	autoLabel: string
	columns: string[]
}) {
	return (
		<>
			<span className="text-xs text-text-secondary">{label}</span>
			<Dropdown
				value={value}
				onChange={onChange}
				options={[
					{ value: '', label: autoLabel },
					...columns.map((name) => ({ value: name, label: name })),
				]}
				className="w-full max-w-xs"
			/>
		</>
	)
}
