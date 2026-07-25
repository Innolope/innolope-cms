import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ApiError, api } from '../../lib/api-client'
import { CheckIcon, SparklesIcon } from '../icons'

interface CoverFormat {
	name: string
	width: number
	height: number
}

interface CoverStatus {
	enabled: boolean
	reason?: string
	formats?: CoverFormat[]
	templateConfigured?: boolean
}

interface Props {
	contentId: string
	/** Metadata field the generated URL is written to. */
	field: string
	disabled?: boolean
	/** Called with the new image URL so the editor can refresh the preview. */
	onGenerated: (url: string) => void
}

/**
 * "Generate cover" — renders a cover for this record through the project's
 * cover template and drops the resulting URL into the image field.
 *
 * Renders nothing at all when the feature is unusable (no license, no
 * Cloudflare credentials, no template configured). A button that always 503s
 * is worse than no button: the sidebar is already dense, and this is an
 * optional integration most projects will not have set up.
 */
export function GenerateCoverButton({ contentId, field, disabled, onGenerated }: Props) {
	const { t } = useTranslation()
	const [status, setStatus] = useState<CoverStatus | null>(null)
	const [format, setFormat] = useState<string>('')
	const [pending, setPending] = useState(false)
	const [justDone, setJustDone] = useState(false)
	const [error, setError] = useState<string | null>(null)

	useEffect(() => {
		let cancelled = false
		api
			.get<CoverStatus>('/api/v1/covers/status')
			// A 403 here is the license gate — treat it as "not available" rather
			// than an error, so community builds simply don't see the control.
			.catch(() => ({ enabled: false }) as CoverStatus)
			.then((s) => {
				if (cancelled) return
				setStatus(s)
				setFormat(s.formats?.[0]?.name ?? '')
			})
		return () => {
			cancelled = true
		}
	}, [])

	// Auto-revert the success state: a button stuck on "Generated" is lying the
	// moment the user changes anything.
	useEffect(() => {
		if (!justDone) return
		const timer = setTimeout(() => setJustDone(false), 1800)
		return () => clearTimeout(timer)
	}, [justDone])

	if (!status?.enabled || !status.templateConfigured) return null

	const formats = status.formats ?? []

	async function generate() {
		setPending(true)
		setError(null)
		try {
			const res = await api.post<{ url: string }>('/api/v1/covers/generate', {
				contentId,
				field,
				format,
			})
			onGenerated(res.url)
			setJustDone(true)
		} catch (err) {
			// Cover failures are expected and actionable (missing token, template
			// down, no slug) — the API writes those messages for users, so show
			// them. Anything else gets a calm generic line.
			setError(
				err instanceof ApiError && err.message
					? err.message
					: t('collections.detail.cover.failed', 'Could not generate a cover — try again.'),
			)
		} finally {
			setPending(false)
		}
	}

	return (
		<div className="mt-2">
			<div className="flex gap-2">
				<button
					type="button"
					onClick={generate}
					disabled={pending || disabled}
					aria-busy={pending}
					className="inline-flex items-center gap-2 px-3 py-1.5 bg-input border border-border rounded text-xs font-medium hover:border-border-strong disabled:opacity-50"
				>
					{/* Fixed-size slot so swapping the icon never shifts the layout. */}
					<span className="w-3.5 h-3.5 inline-flex items-center justify-center">
						{pending ? (
							<span className="w-3.5 h-3.5 rounded-full border-2 border-current border-t-transparent animate-spin" />
						) : justDone ? (
							<CheckIcon className="w-3.5 h-3.5 text-green-600" />
						) : (
							<SparklesIcon className="w-3.5 h-3.5" />
						)}
					</span>
					{pending
						? t('collections.detail.cover.generating', 'Generating…')
						: justDone
							? t('collections.detail.cover.generated', 'Generated')
							: t('collections.detail.cover.generate', 'Generate cover')}
				</button>

				{formats.length > 1 && (
					<select
						value={format}
						onChange={(e) => setFormat(e.target.value)}
						disabled={pending || disabled}
						aria-label={t('collections.detail.cover.format', 'Cover format')}
						className="px-2 py-1.5 bg-input border border-border rounded text-xs focus:outline-none focus:border-border-strong disabled:opacity-50"
					>
						{formats.map((f) => (
							<option key={f.name} value={f.name}>
								{f.name} · {f.width}×{f.height}
							</option>
						))}
					</select>
				)}
			</div>

			{/* Live regions stay mounted so assistive tech actually announces the
			    change; conditionally-mounted status nodes are often missed. */}
			<p role="status" className="sr-only">
				{pending
					? t('collections.detail.cover.generating', 'Generating…')
					: justDone
						? t('collections.detail.cover.generated', 'Generated')
						: ''}
			</p>
			<p role="alert" className={error ? 'mt-1.5 text-xs text-red-600' : 'sr-only'}>
				{error ?? ''}
			</p>
		</div>
	)
}
