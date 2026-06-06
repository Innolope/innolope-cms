import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { AiChatPanel } from '../components/ai/ai-chat-panel'
import { SelectionToolbar } from '../components/ai/selection-toolbar'
import { Dropdown } from '../components/dropdown'
import { FieldRenderer } from '../components/editor/field-renderer'
import { JsonField } from '../components/editor/json-field'
import { LocalizationBar, localeDisplayName } from '../components/editor/localization-bar'
import { LocalizedTextField } from '../components/editor/localized-text-field'
import { MarkdownEditor } from '../components/editor/markdown-editor'
import { ObjectArrayField } from '../components/editor/object-array-field'
import { PillInput } from '../components/editor/pill-input'
import { RelationField } from '../components/editor/relation-field'
import { hasFeature, UpgradePrompt, useLicense } from '../components/license-gate'
import { VersionPanel } from '../components/versions/version-panel'
import { ApiError, api } from '../lib/api-client'
import { useAuth } from '../lib/auth'
import { useCollections } from '../lib/collections'
import { useConfirm, usePrompt } from '../lib/confirm'
import { resolveDisplayTitle } from '../lib/display-title'
import { useToast } from '../lib/toast'

/** Normalize a stored value (array or comma string) to a string array. */
function toStringArray(v: unknown): string[] {
	if (Array.isArray(v)) return v.map((x) => String(x)).filter(Boolean)
	if (typeof v === 'string' && v.trim())
		return v
			.split(',')
			.map((s) => s.trim())
			.filter(Boolean)
	return []
}

/** Coerce a stored value into a `{ locale: string }` map (mirrors LocalizedTextField). */
function toLocaleValueMap(value: unknown, defaultLocale: string): Record<string, string> {
	if (value && typeof value === 'object' && !Array.isArray(value)) {
		const out: Record<string, string> = {}
		for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
			out[k] = typeof v === 'string' ? v : v == null ? '' : String(v)
		}
		return out
	}
	if (typeof value === 'string' && value !== '') return { [defaultLocale]: value }
	return {}
}

/**
 * Schema fields not rendered as their own generic input: `title`/`content`/`body`/`tags`
 * have dedicated editors above, `status` has the built-in publish-status dropdown in the
 * sidebar (a user-defined `status` field would otherwise render a confusing second
 * "status" control), and `__v` is the Mongo version key maintained by the database.
 */
const HIDDEN_FIELDS = new Set(['title', 'content', 'body', 'tags', 'status', '__v'])

/** Relation fields whose name reads like an image — surfaced as a full-width preview. */
const IMAGE_FIELD_NAME_RE = /image|photo|cover|banner|thumbnail|avatar|logo|featured|picture/i

export const Route = createFileRoute('/collections/$slug/$contentId')({
	component: CollectionContentEditor,
})

interface ContentItem {
	id: string
	slug: string
	status: string
	metadata: Record<string, unknown>
	markdown: string
	locale: string
	version: number
	collectionId: string
	externalId?: string
	live?: boolean
}

/**
 * Full editor state persisted to localStorage so an accidental page reload (or a
 * navigation away) never loses unsaved work. Captures every editable surface — not
 * just markdown/title, but the dynamic schema fields (`extraFields`), slug, status
 * and tags. Cleared on a successful Save.
 */
interface DraftSnapshot {
	markdown: string
	title: string
	contentSlug: string
	status: string
	tags: string[]
	extraFields: Record<string, unknown>
	savedAt: number
}

/** Parse YAML frontmatter from markdown, return body + metadata */
function parseFrontmatter(md: string): { body: string; meta: Record<string, unknown> } {
	const match = md.match(/^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/)
	if (!match) return { body: md, meta: {} }

	const yamlBlock = match[1]
	const body = match[2]
	const meta: Record<string, unknown> = {}

	for (const line of yamlBlock.split('\n')) {
		const m = line.match(/^(\w[\w-]*):\s*(.*)$/)
		if (!m) continue
		const [, key, rawVal] = m
		let val: unknown = rawVal.trim()
		// Unquote strings
		if (typeof val === 'string' && val.startsWith('"') && val.endsWith('"')) {
			val = val.slice(1, -1).replace(/\\"/g, '"').replace(/\\n/g, '\n')
		}
		// Parse booleans
		if (val === 'true') val = true
		else if (val === 'false') val = false
		// Parse numbers
		else if (typeof val === 'string' && val && !Number.isNaN(Number(val))) val = Number(val)
		// Parse arrays
		else if (typeof val === 'string' && val.startsWith('[') && val.endsWith(']')) {
			try {
				val = JSON.parse(val)
			} catch {
				/* keep as string */
			}
		}
		meta[key] = val
	}

	return { body, meta }
}

/**
 * Extract a human-readable label from a metadata value. Handles three shapes:
 *   - plain strings: trimmed
 *   - locale maps `{en: "...", ua: "..."}`: prefers defaultLocale, falls back to
 *     any non-empty locale value (so a record with only `ua: "..."` still surfaces)
 *   - anything else: null
 *
 * Used for the breadcrumb's "use name/title as label" lookup so external records
 * with an ObjectId-ish slug show a friendly name in the header instead.
 */
function extractLabel(value: unknown, defaultLocale: string): string | null {
	if (value == null) return null
	if (typeof value === 'string') {
		const trimmed = value.trim()
		return trimmed || null
	}
	if (typeof value === 'object' && !Array.isArray(value)) {
		const map = value as Record<string, unknown>
		const v = map[defaultLocale]
		if (typeof v === 'string' && v.trim()) return v.trim()
		for (const key of Object.keys(map)) {
			const candidate = map[key]
			if (typeof candidate === 'string' && candidate.trim()) return candidate.trim()
		}
	}
	return null
}

/**
 * Common ISO 639-1 codes used to recognize locale-shaped data even when the project
 * settings haven't been updated yet (e.g. content was imported from an external DB
 * whose authors used `ua`/`uk` for Ukrainian without anyone configuring it in Innolope).
 *
 * Includes a few non-standard but widely-used codes (`ua`, `cn`, `kr`) alongside the
 * proper ISO equivalents. Kept short — extend as real data demands.
 */
const KNOWN_LOCALE_CODES = new Set([
	'en',
	'es',
	'fr',
	'de',
	'it',
	'pt',
	'nl',
	'sv',
	'no',
	'da',
	'fi',
	'pl',
	'cs',
	'sk',
	'ro',
	'hu',
	'tr',
	'el',
	'bg',
	'hr',
	'sl',
	'sr',
	'lt',
	'lv',
	'et',
	'ru',
	'ua',
	'uk',
	'be',
	'zh',
	'cn',
	'ja',
	'ko',
	'kr',
	'vi',
	'th',
	'id',
	'ms',
	'tl',
	'hi',
	'bn',
	'ar',
	'he',
	'fa',
	'ur',
])

/** Strict locale-code shape check: 2-3 lowercase letters, optional `-XX` region. */
function looksLikeLocaleCode(key: string): boolean {
	return /^[a-z]{2,3}(-[A-Za-z]{2,4})?$/.test(key)
}

/**
 * Heuristic: value looks like a `{locale: text}` map.
 *
 * Returns true iff value is a plain non-empty object AND
 *   - every value is a string (or null/undefined), AND
 *   - every key is in the project's configured locale list, OR (if `allowKnownCodes`
 *     is true) matches a known ISO 639-1 code.
 *
 * `allowKnownCodes` is the bridge to externally-imported content: when the user
 * hasn't configured `ua`/`de`/… in project settings yet, we still want to render
 * the LocalizedTextField. After the user explicitly declines the "add detected
 * locales?" prompt, the caller passes `allowKnownCodes: false` to suppress the
 * heuristic and fall back to raw JSON editing.
 *
 * Strings-only values are required to avoid false positives on structured objects
 * like `{ platform: "linkedin", url: "..." }` — `url`/`platform` aren't locale codes,
 * and even if they were, an `ObjectArrayField` row's sub-shape isn't a locale map.
 */
function isLocaleMap(value: unknown, locales: string[], allowKnownCodes = true): boolean {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return false
	const entries = Object.entries(value as Record<string, unknown>)
	if (entries.length === 0) return false
	if (!entries.every(([, v]) => v === null || v === undefined || typeof v === 'string')) {
		return false
	}
	const locSet = new Set(locales)
	return entries.every(
		([k]) =>
			locSet.has(k) ||
			(allowKnownCodes && KNOWN_LOCALE_CODES.has(k.toLowerCase()) && looksLikeLocaleCode(k)),
	)
}

/** Collect all locale codes that appear as keys in any locale-shaped value on this record. */
function discoverLocalesFromExtras(
	extras: Record<string, unknown>,
	projectLocales: string[],
	allowKnownCodes = true,
): string[] {
	const found = new Set<string>()
	for (const v of Object.values(extras)) {
		if (isLocaleMap(v, projectLocales, allowKnownCodes)) {
			for (const k of Object.keys(v as Record<string, unknown>)) found.add(k)
		}
	}
	return Array.from(found)
}

/** True iff value is an array containing at least one non-string, non-null object element. */
function isObjectArray(value: unknown): boolean {
	if (!Array.isArray(value)) return false
	return value.some((item) => item !== null && typeof item === 'object')
}

interface LocaleUiState {
	mode: 'single' | 'compare'
	activeLocale: string
	leftLocale: string
	rightLocale: string
}

function loadLocaleUi(projectId: string | undefined, defaults: LocaleUiState): LocaleUiState {
	if (!projectId) return defaults
	try {
		const raw = localStorage.getItem(`innolope:locale-ui:${projectId}`)
		if (!raw) return defaults
		const parsed = JSON.parse(raw) as Partial<LocaleUiState>
		return {
			mode: parsed.mode === 'compare' ? 'compare' : 'single',
			activeLocale: parsed.activeLocale || defaults.activeLocale,
			leftLocale: parsed.leftLocale || defaults.leftLocale,
			rightLocale: parsed.rightLocale || defaults.rightLocale,
		}
	} catch {
		return defaults
	}
}

function CollectionContentEditor() {
	const { t } = useTranslation()
	const { slug, contentId } = Route.useParams()
	const navigate = useNavigate()
	const toast = useToast()
	const prompt = usePrompt()
	const confirm = useConfirm()
	const { getCollectionByName, refreshCollections } = useCollections()
	const { currentProject, refreshProjects } = useAuth()
	const collection = getCollectionByName(slug)
	const isNew = contentId === 'new'
	const isExternal = collection?.source === 'external'
	const [isLive, setIsLive] = useState(false)
	const isReadOnly = (isExternal && collection?.accessMode === 'read-only') || isLive
	// Admin/owner can mutate the collection schema (e.g. append a new enum option
	// inline from the dropdown). PATCH /api/v1/collections requires this anyway.
	const canEditSchema = currentProject?.role === 'owner' || currentProject?.role === 'admin'

	// Project locales — drives the LocalizationBar and the LocalizedTextField dispatch.
	const projectSettings = (currentProject?.settings as Record<string, unknown> | undefined) ?? {}
	const projectLocales = (Array.isArray(projectSettings.locales)
		? (projectSettings.locales as string[])
		: null) ?? ['en']
	const defaultLocale = (projectSettings.defaultLocale as string) || projectLocales[0] || 'en'

	const [extraFields, setExtraFields] = useState<Record<string, unknown>>({})

	// Per-collection cache of "fields that have been seen as locale-shaped". Used to
	// render LocalizedTextField on a NEW record (or on a loaded record where the
	// particular field happens to be empty) even though the schema doesn't carry the
	// `localized: true` flag. Populated as the user opens existing records — the
	// `useEffect` further down updates this set whenever `extraFields` resolves into
	// locale-shaped values.
	const localizedFieldsCacheKey = collection?.id
		? `innolope:localized-fields:${collection.id}`
		: null
	const [knownLocalizedFields, setKnownLocalizedFields] = useState<Set<string>>(() => {
		if (!localizedFieldsCacheKey) return new Set()
		try {
			const raw = localStorage.getItem(localizedFieldsCacheKey)
			return raw ? new Set(JSON.parse(raw) as string[]) : new Set()
		} catch {
			return new Set()
		}
	})

	// Per-project "stop auto-detecting extra locales" flag. Set when the user picks
	// "Not now" on the "Add detected locales to project?" modal. While dismissed, we
	// suppress the known-ISO-code heuristic so unconfigured locale-shaped objects fall
	// back to the JSON editor (no surprise switcher).
	const dismissKey = currentProject?.id
		? `innolope:locale-discover-dismissed:${currentProject.id}`
		: null
	const [autoDiscoverDismissed, setAutoDiscoverDismissed] = useState<boolean>(() => {
		if (!dismissKey) return false
		try {
			return localStorage.getItem(dismissKey) === '1'
		} catch {
			return false
		}
	})
	// Re-read when the active project changes (e.g. user switches workspaces).
	useEffect(() => {
		if (!dismissKey) return
		try {
			setAutoDiscoverDismissed(localStorage.getItem(dismissKey) === '1')
		} catch {}
	}, [dismissKey])

	const allowKnownCodes = !autoDiscoverDismissed

	// Latent detection — always runs the known-ISO-code heuristic regardless of the
	// dismissal flag. Drives the recovery icon in the top-right so the user can re-open
	// the prompt after clicking "Not now" / Esc / outside.
	const latentDiscoveredLocales = discoverLocalesFromExtras(extraFields, projectLocales, true)
	const latentMissingLocales = latentDiscoveredLocales.filter((l) => !projectLocales.includes(l))

	// Dismissal-respecting detection — drives the actual LocalizedTextField rendering and
	// the auto-prompt trigger. When the user has dismissed, this collapses to just the
	// project's configured locales.
	const discoveredLocales = allowKnownCodes ? latentDiscoveredLocales : []
	const effectiveLocales = (() => {
		const seen = new Set<string>()
		const out: string[] = []
		for (const l of [...projectLocales, ...discoveredLocales]) {
			if (!seen.has(l)) {
				seen.add(l)
				out.push(l)
			}
		}
		return out.length > 0 ? out : ['en']
	})()

	// Locales found in the data but not yet in project settings — the prompt target.
	const missingLocales = discoveredLocales.filter((l) => !projectLocales.includes(l))

	/**
	 * Opens the "Add detected languages?" confirm. Shared between the auto-prompt
	 * (fires once per record load when not yet dismissed) and the manual icon-button
	 * (the recovery affordance in the top-right corner when the user accidentally
	 * dismissed via Esc / click-outside).
	 */
	const runLocalePrompt = async (missing: string[]) => {
		if (!currentProject?.id || !dismissKey || missing.length === 0) return
		const labels = missing.map((l) => l.toUpperCase()).join(', ')
		const ok = await confirm({
			title: t('collections.detail.localePrompt.title'),
			message: t('collections.detail.localePrompt.message', {
				labels,
				count: missing.length,
			}),
			confirmLabel: t('collections.detail.localePrompt.confirm'),
			cancelLabel: t('collections.detail.localePrompt.cancel'),
			cancelAsLink: true,
		})
		if (ok) {
			try {
				await api.put(`/api/v1/projects/${currentProject.id}`, {
					name: currentProject.name,
					slug: currentProject.slug,
					settings: {
						...(currentProject.settings as Record<string, unknown>),
						locales: Array.from(new Set([...projectLocales, ...missing])),
					},
				})
				await refreshProjects()
				// Clear any prior dismissal — the user just opted in, future records should
				// auto-prompt rather than stay quiet.
				try {
					localStorage.removeItem(dismissKey)
				} catch {}
				setAutoDiscoverDismissed(false)
				toast(
					t('collections.detail.localePrompt.addedToast', {
						labels: missing.length === 1 ? missing[0].toUpperCase() : labels,
						count: missing.length,
					}),
					'success',
				)
			} catch (err) {
				toast(
					err instanceof Error ? err.message : t('collections.detail.errors.updateProject'),
					'error',
				)
				// Allow re-prompt on next load.
				promptedRef.current = false
			}
		} else {
			try {
				localStorage.setItem(dismissKey, '1')
			} catch {}
			setAutoDiscoverDismissed(true)
		}
	}

	// Auto-prompt: runs once per record load when there are new locales to offer and the
	// user hasn't dismissed yet. `promptedRef` prevents re-firing if state churns.
	const promptedRef = useRef(false)
	// biome-ignore lint/correctness/useExhaustiveDependencies: re-fires only on the joined missing-locales string; `promptedRef` guards against double-prompts when other listed-but-stale deps would otherwise force a re-run.
	useEffect(() => {
		if (promptedRef.current) return
		if (autoDiscoverDismissed) return
		if (missingLocales.length === 0) return
		if (!currentProject?.id || !dismissKey) return
		promptedRef.current = true
		runLocalePrompt(missingLocales)
	}, [missingLocales.join(','), currentProject?.id])

	const [localeUi, setLocaleUi] = useState<LocaleUiState>(() =>
		loadLocaleUi(currentProject?.id, {
			mode: 'single',
			activeLocale: defaultLocale,
			leftLocale: projectLocales[0] ?? 'en',
			rightLocale: projectLocales[1] ?? projectLocales[0] ?? 'en',
		}),
	)

	// Reconcile locale UI state once `effectiveLocales` settles (data may load *after* mount,
	// or the persisted choice may point at a locale no longer present).
	// biome-ignore lint/correctness/useExhaustiveDependencies: effectiveLocales identity changes every render; keying on its joined content is intentional.
	useEffect(() => {
		if (effectiveLocales.length === 0) return
		setLocaleUi((s) => {
			const fix = (loc: string) =>
				effectiveLocales.includes(loc) ? loc : (effectiveLocales[0] ?? loc)
			const fixedLeft = fix(s.leftLocale)
			// Enforce rightLocale ≠ leftLocale whenever there's a second locale to pick.
			// Without this, panes can both default to `en` on first load and the disable
			// rule in the dropdown would lock them there.
			let fixedRight = effectiveLocales.includes(s.rightLocale) ? s.rightLocale : fixedLeft
			if (fixedRight === fixedLeft && effectiveLocales.length >= 2) {
				fixedRight = effectiveLocales.find((l) => l !== fixedLeft) ?? fixedLeft
			}
			const next = {
				...s,
				activeLocale: fix(s.activeLocale),
				leftLocale: fixedLeft,
				rightLocale: fixedRight,
			}
			if (
				next.activeLocale === s.activeLocale &&
				next.leftLocale === s.leftLocale &&
				next.rightLocale === s.rightLocale
			)
				return s
			return next
		})
	}, [effectiveLocales.join(',')])

	// Persist locale UI per project.
	useEffect(() => {
		if (!currentProject?.id) return
		try {
			localStorage.setItem(`innolope:locale-ui:${currentProject.id}`, JSON.stringify(localeUi))
		} catch {}
	}, [localeUi, currentProject?.id])

	// Populate the per-collection "fields seen as locale-shaped" cache when the
	// current record exposes such fields. Lets us render LocalizedTextField for
	// empty/new records of the same collection. Always uses the permissive
	// `allowKnownCodes=true` detection so we cache the field even if the user
	// has dismissed the auto-discover prompt (the dismissal only affects the
	// per-record dispatch, not the long-term collection knowledge).
	// biome-ignore lint/correctness/useExhaustiveDependencies: only `extraFields` should drive recomputation; the other deps are stable refs.
	useEffect(() => {
		if (!localizedFieldsCacheKey) return
		if (Object.keys(extraFields).length === 0) return
		const detected: string[] = []
		for (const [k, v] of Object.entries(extraFields)) {
			if (isLocaleMap(v, projectLocales, true)) detected.push(k)
		}
		if (detected.length === 0) return
		setKnownLocalizedFields((prev) => {
			const next = new Set(prev)
			let changed = false
			for (const k of detected) {
				if (!next.has(k)) {
					next.add(k)
					changed = true
				}
			}
			if (!changed) return prev
			try {
				localStorage.setItem(localizedFieldsCacheKey, JSON.stringify(Array.from(next)))
			} catch {}
			return next
		})
	}, [extraFields, localizedFieldsCacheKey])

	// Seed locale-field detection for NEW records. The per-collection cache is only
	// populated by opening sibling records in the current browser — on a fresh load
	// straight to "new", it's empty, so localized fields would wrongly render as JSON
	// (no compare-mode split). Fetch a few existing records from the same collection
	// and inspect their metadata. One-shot: skipped once the cache has any entries.
	// biome-ignore lint/correctness/useExhaustiveDependencies: one-shot per (isNew, collection); other refs are stable and re-running on them is undesirable.
	useEffect(() => {
		if (!isNew || !collection?.id || !localizedFieldsCacheKey) return
		if (knownLocalizedFields.size > 0) return
		let cancelled = false
		api
			.get<{ data: Array<{ metadata: Record<string, unknown> }> }>(
				`/api/v1/content?collectionId=${collection.id}&limit=5`,
			)
			.then((res) => {
				if (cancelled) return
				const detected = new Set<string>()
				for (const item of res.data ?? []) {
					for (const [k, v] of Object.entries(item.metadata ?? {})) {
						if (isLocaleMap(v, projectLocales, true)) detected.add(k)
					}
				}
				if (detected.size === 0) return
				setKnownLocalizedFields((prev) => {
					const next = new Set([...prev, ...detected])
					try {
						localStorage.setItem(localizedFieldsCacheKey, JSON.stringify(Array.from(next)))
					} catch {}
					return next
				})
			})
			.catch(() => {
				/* sample fetch is best-effort; new record still works without it */
			})
		return () => {
			cancelled = true
		}
	}, [isNew, collection?.id, localizedFieldsCacheKey])

	const [markdown, setMarkdown] = useState('')
	const [title, setTitle] = useState('')
	const [contentSlug, setContentSlug] = useState('')
	const [status, setStatus] = useState('draft')
	const [tags, setTags] = useState<string[]>([])
	const [version, setVersion] = useState(1)
	const [dirty, setDirty] = useState(false)
	const [saving, setSaving] = useState(false)
	const [loading, setLoading] = useState(!isNew)
	const [loadError, setLoadError] = useState<string | null>(null)
	const [externalId, setExternalId] = useState<string | null>(null)
	// Field-keyed validation errors returned by the API (e.g. Zod issues). Cleared
	// on every save attempt; populated when the API returns 400 with an issues array.
	const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({})
	const [showExtraFields, setShowExtraFields] = useState(false)
	const license = useLicense()
	const aiLicensed = hasFeature(license, 'ai-assistant')
	const [showAi, setShowAi] = useState(false)
	const [aiTargetField, setAiTargetField] = useState<string | null>(null)
	const [aiSelectedText, _setAiSelectedText] = useState<string | null>(null)
	// Field names currently being AI-translated (drives per-field spinner state).
	const [translatingFields, setTranslatingFields] = useState<Set<string>>(new Set())
	const [bulkTranslating, setBulkTranslating] = useState(false)
	const editorContainerRef = useRef<HTMLDivElement>(null)

	const reviewWorkflowsLicensed = hasFeature(license, 'review-workflows')

	// Project-level review configuration. `requireReview` only matters when the
	// license is present — without it, every save publishes directly via the
	// /publish endpoint (which is not license-gated).
	const requireReview = reviewWorkflowsLicensed && projectSettings.requireReview === true

	// Per-member publish authority. Mirrors `resolveCanPublishDirectly()` on
	// the server side so the UI doesn't render a button the API will reject.
	const memberCanPublishDirectly = currentProject?.canPublishDirectly as boolean | null | undefined
	const canPublishDirectly = !requireReview
		? true
		: memberCanPublishDirectly === true
			? true
			: memberCanPublishDirectly === false
				? false
				: currentProject?.role === 'owner' || currentProject?.role === 'admin'

	const canApprove = currentProject?.role === 'owner' || currentProject?.role === 'admin'
	const [showDraftRestore, setShowDraftRestore] = useState(false)
	// Collection-scoped so a new record (`contentId === 'new'`) in collection A doesn't
	// collide with a new record in collection B.
	const draftKey = `innolope:draft:${slug}:${contentId}`

	// Load content
	// biome-ignore lint/correctness/useExhaustiveDependencies: `t` is only read in the error fallback; re-running this loader when the i18n function identity changes would re-fetch and clobber unsaved edits — it should key only on the record identity.
	useEffect(() => {
		if (!isNew && contentId && collection) {
			setLoadError(null)
			api
				.get<ContentItem>(`/api/v1/content/${contentId}?collectionId=${collection.id}&depth=0`)
				.then((item) => {
					const { body, meta } = parseFrontmatter(item.markdown)
					const mergedMeta = { ...meta, ...item.metadata }

					setMarkdown(body.trim())
					setTitle((mergedMeta.title as string) || '')
					setContentSlug(item.slug)
					setStatus(item.status)
					setTags(toStringArray(mergedMeta.tags))
					setVersion(item.version)
					setExternalId(item.externalId || null)
					setIsLive(Boolean(item.live))

					// All metadata except title goes into extraFields (schema fields rendered
					// dynamically for both internal and external). Declared outside any block
					// so the draft-diff check below can compare against it.
					const extras: Record<string, unknown> = {}
					for (const [key, val] of Object.entries(mergedMeta)) {
						if (key !== 'title') extras[key] = val
					}
					setExtraFields(extras)

					// Check for an unsaved local draft. Show the restore prompt when the draft
					// is recent (< 24h) AND differs from the just-loaded content on any
					// editable surface — markdown, title, or the dynamic schema fields.
					try {
						const raw = localStorage.getItem(draftKey)
						if (raw) {
							const draft = JSON.parse(raw) as Partial<DraftSnapshot>
							const ageMs = Date.now() - (draft.savedAt ?? 0)
							const loadedTitle = (mergedMeta.title as string) || ''
							const differs =
								draft.markdown !== body.trim() ||
								draft.title !== loadedTitle ||
								JSON.stringify(draft.extraFields ?? {}) !== JSON.stringify(extras)
							if (ageMs < 24 * 60 * 60 * 1000 && differs) {
								setShowDraftRestore(true)
							} else {
								localStorage.removeItem(draftKey)
							}
						}
					} catch {}
				})
				.catch((err) => {
					// Don't silently bounce to the list — a transient 500/network error is
					// indistinguishable from a real 404 that way. Surface it in place.
					setLoadError(
						err instanceof Error ? err.message : t('collections.detail.errors.loadFailed'),
					)
				})
				.finally(() => setLoading(false))
		}
	}, [contentId, isNew, draftKey, collection])

	// Prefill date-typed schema fields with today for new records — but ONLY
	// when the schema explicitly opts in via `defaultValue: 'today'`. Blanket
	// prefill (the old behavior) caused fields like `startDate` and the
	// system-managed `updatedAt` to be silently filled with today, hiding real
	// user intent and forcing the user to clear/edit each one.
	useEffect(() => {
		if (!isNew || !collection) return
		const dateFields =
			collection.fields?.filter((f) => f.type === 'date' && f.defaultValue === 'today') ?? []
		if (dateFields.length === 0) return
		setExtraFields((prev) => {
			const next = { ...prev }
			let changed = false
			for (const f of dateFields) {
				if (next[f.name] == null || next[f.name] === '') {
					next[f.name] = new Date().toISOString()
					changed = true
				}
			}
			return changed ? next : prev
		})
	}, [isNew, collection])

	// Surface a restore prompt for NEW records — if a draft from a prior (reloaded)
	// session exists, offer it. The draft is only ever written while `dirty`, so its
	// mere presence means the user had genuinely entered something.
	useEffect(() => {
		if (!isNew) return
		try {
			const raw = localStorage.getItem(draftKey)
			if (!raw) return
			const draft = JSON.parse(raw) as Partial<DraftSnapshot>
			const ageMs = Date.now() - (draft.savedAt ?? 0)
			if (ageMs < 24 * 60 * 60 * 1000) {
				setShowDraftRestore(true)
			} else {
				localStorage.removeItem(draftKey)
			}
		} catch {}
	}, [isNew, draftKey])

	// Auto-save the full editor state to localStorage when dirty:
	//  - debounced (1.5s) for routine "leave the tab open" safety, and
	//  - immediately on `beforeunload` so a reload never drops the last few seconds
	//    of edits the debounce hasn't flushed yet.
	// Covers new records too (collection-scoped draftKey keeps them separate).
	useEffect(() => {
		if (!dirty) return
		const snapshot: DraftSnapshot = {
			markdown,
			title,
			contentSlug,
			status,
			tags,
			extraFields,
			savedAt: Date.now(),
		}
		const persist = () => {
			try {
				localStorage.setItem(draftKey, JSON.stringify(snapshot))
			} catch {}
		}
		const timer = setTimeout(persist, 1500)
		window.addEventListener('beforeunload', persist)
		return () => {
			clearTimeout(timer)
			window.removeEventListener('beforeunload', persist)
		}
	}, [dirty, markdown, title, contentSlug, status, tags, extraFields, draftKey])

	const restoreDraft = () => {
		try {
			const raw = localStorage.getItem(draftKey)
			if (raw) {
				const draft = JSON.parse(raw) as Partial<DraftSnapshot>
				if (typeof draft.markdown === 'string') setMarkdown(draft.markdown)
				if (typeof draft.title === 'string') setTitle(draft.title)
				if (typeof draft.contentSlug === 'string') setContentSlug(draft.contentSlug)
				if (typeof draft.status === 'string') setStatus(draft.status)
				if (Array.isArray(draft.tags)) setTags(draft.tags)
				if (draft.extraFields && typeof draft.extraFields === 'object') {
					setExtraFields(draft.extraFields)
				}
				setDirty(true)
			}
		} catch {}
		setShowDraftRestore(false)
	}

	const dismissDraft = () => {
		localStorage.removeItem(draftKey)
		setShowDraftRestore(false)
	}

	const generateSlug = (text: string) =>
		text
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, '-')
			.replace(/^-|-$/g, '')

	/**
	 * Resolve the value the form should save as `metadata.title` (and use to
	 * derive `slug` when blank). Falls back through the collection's pinned
	 * title field, schema heuristics, then the explicit `title` state.
	 */
	const resolveAutoTitle = (): string => {
		if (title?.trim()) return title.trim()
		if (!collection) return ''
		const derived = resolveDisplayTitle(
			{
				id: contentId === 'new' ? 'new' : (contentId ?? 'new'),
				slug: contentSlug || null,
				metadata: extraFields,
			},
			collection,
			{ defaultLocale },
		)
		// resolveDisplayTitle returns the id as a last resort; that's not useful
		// for save-time autoderive, so reject anything that looks like a UUID/the
		// placeholder.
		if (derived === 'new' || /^[0-9a-f]{8}-[0-9a-f]{4}/i.test(derived)) return ''
		return derived
	}

	const collectMetadata = (autoTitle: string) => {
		// Strip read-only schema fields (createdAt/updatedAt/__v and friends) from the
		// save payload. They're server-managed; sending the user-loaded value back is
		// harmless but noisy, and a tampered devtools edit could overwrite the source
		// of truth. Also strip `slug` — it's already serialized at the top level
		// of the request (`{ slug, metadata }`); keeping it in metadata produced a
		// duplicate and let the two drift.
		const readOnlyNames = new Set(
			(collection?.fields ?? []).filter((f) => f.ui?.readOnly).map((f) => f.name),
		)
		const cleanExtras: Record<string, unknown> = {}
		for (const [k, v] of Object.entries(extraFields)) {
			if (readOnlyNames.has(k) || k === 'slug') continue
			cleanExtras[k] = v
		}
		return {
			...cleanExtras,
			title: title || autoTitle,
			tags: tags.map((t) => t.trim()).filter(Boolean),
		}
	}

	const save = async () => {
		if (!collection) return
		if (isReadOnly) {
			toast(t('collections.detail.errors.readOnlyCollection'), 'error')
			return
		}
		setSaving(true)
		setFieldErrors({})
		try {
			const autoTitle = resolveAutoTitle()
			const metadata = collectMetadata(autoTitle)
			// Auto-derive slug from the resolved title when the user hasn't typed
			// one. If neither title nor source slug exists, send null — content.slug
			// is nullable and the API treats null-slug as "no permalink"; we never
			// invent a slug from a URL or random fallback.
			const derived = generateSlug(autoTitle || title)
			const effectiveSlug = (contentSlug || derived || null) as string | null
			if (isNew) {
				const created = await api.post<{ id: string }>('/api/v1/content', {
					slug: effectiveSlug,
					collectionId: collection.id,
					markdown,
					metadata,
					status,
				})
				refreshCollections()
				navigate({ to: `/collections/${slug}/${created.id}` })
			} else {
				await api.put(`/api/v1/content/${contentId}`, {
					slug: effectiveSlug,
					markdown,
					metadata,
					status,
				})
			}
			setDirty(false)
			try {
				localStorage.removeItem(draftKey)
			} catch {}
		} catch (err) {
			if (err instanceof ApiError && err.issues.length) {
				// Map issues into a field→message dict. Strip the `metadata.` prefix
				// the API uses for schema-field paths so the renderer can match
				// directly against schema field names.
				const next: Record<string, string> = {}
				for (const issue of err.issues) {
					const path = issue.path.replace(/^metadata\./, '')
					if (path && !next[path]) next[path] = issue.message
				}
				setFieldErrors(next)
			}
			toast(err instanceof Error ? err.message : t('collections.detail.errors.saveFailed'), 'error')
		} finally {
			setSaving(false)
		}
	}

	const submitForReview = async () => {
		setSaving(true)
		try {
			await api.post(`/api/v1/content/${contentId}/submit-for-review`, {})
			setStatus('pending_review')
		} catch (err) {
			toast(
				err instanceof Error ? err.message : t('collections.detail.errors.submitFailed'),
				'error',
			)
		} finally {
			setSaving(false)
		}
	}

	/**
	 * One-step publish — saves the current editor state, then flips status
	 * to `published` via the dedicated /publish endpoint. Used in place of
	 * Submit when the project doesn't require review or the member is
	 * permitted to bypass it.
	 */
	const publishDirectly = async () => {
		if (!collection) return
		if (isReadOnly) {
			toast(t('collections.detail.errors.readOnlyCollection'), 'error')
			return
		}
		setSaving(true)
		try {
			// Persist editor state first so the publish reflects the latest copy.
			const autoTitle = resolveAutoTitle()
			const metadata = collectMetadata(autoTitle)
			const effectiveSlug = (contentSlug || generateSlug(autoTitle || title) || null) as
				| string
				| null
			if (isNew) {
				const created = await api.post<{ id: string }>('/api/v1/content', {
					slug: effectiveSlug,
					collectionId: collection.id,
					markdown,
					metadata,
					status: 'draft',
				})
				await api.post(`/api/v1/content/${created.id}/publish`, {})
				refreshCollections()
				navigate({ to: `/collections/${slug}/${created.id}` })
				return
			}
			await api.put(`/api/v1/content/${contentId}`, {
				slug: effectiveSlug,
				markdown,
				metadata,
			})
			await api.post(`/api/v1/content/${contentId}/publish`, {})
			setStatus('published')
			setDirty(false)
			try {
				localStorage.removeItem(draftKey)
			} catch {}
		} catch (err) {
			toast(
				err instanceof Error ? err.message : t('collections.detail.errors.publishFailed'),
				'error',
			)
		} finally {
			setSaving(false)
		}
	}

	const approveContent = async () => {
		setSaving(true)
		try {
			await api.post(`/api/v1/content/${contentId}/approve`, {})
			setStatus('published')
		} catch (err) {
			toast(
				err instanceof Error ? err.message : t('collections.detail.errors.approveFailed'),
				'error',
			)
		} finally {
			setSaving(false)
		}
	}

	const rejectContent = async () => {
		const reason = await prompt({
			title: t('collections.detail.reject.title'),
			message: t('collections.detail.reject.message'),
			label: t('collections.detail.reject.reasonLabel'),
			placeholder: t('collections.detail.reject.reasonPlaceholder'),
			multiline: true,
			confirmLabel: t('collections.detail.reject.confirm'),
		})
		if (reason === null) return
		setSaving(true)
		try {
			await api.post(`/api/v1/content/${contentId}/reject`, { reason: reason || undefined })
			setStatus('draft')
		} catch (err) {
			toast(
				err instanceof Error ? err.message : t('collections.detail.errors.rejectFailed'),
				'error',
			)
		} finally {
			setSaving(false)
		}
	}

	if (loading) return <div className="p-8 pt-5" />

	if (loadError) {
		return (
			<div className="p-8 flex flex-col items-center pt-[15vh] text-center">
				<div className="w-14 h-14 rounded-2xl bg-surface-alt flex items-center justify-center mb-4">
					<svg
						width="28"
						height="28"
						viewBox="0 0 24 24"
						fill="none"
						stroke="currentColor"
						strokeWidth="1.5"
						strokeLinecap="round"
						strokeLinejoin="round"
						className="text-text-muted"
					>
						<circle cx="12" cy="12" r="10" />
						<path d="M12 8v4M12 16h.01" />
					</svg>
				</div>
				<h3 className="font-semibold text-text mb-1">{t('collections.detail.couldntLoad')}</h3>
				<p className="text-sm text-text-secondary max-w-sm mb-5">{loadError}</p>
				<button
					type="button"
					onClick={() => navigate({ to: `/collections/${slug}` })}
					className="px-4 py-2 bg-btn-secondary text-text-secondary rounded-lg text-sm font-medium hover:bg-btn-secondary-hover hover:text-text transition-colors"
				>
					{t('collections.detail.backTo', { name: collection?.label || slug })}
				</button>
			</div>
		)
	}

	// Whether to show the locale switcher: project has 2+ configured locales,
	// OR any field on this record stores a locale-shaped object (auto-detect),
	// OR the per-collection cache remembers this field as locale-shaped.
	// Drop fields marked `ui.hidden` from the form entirely — this is how
	// system-managed columns (e.g. `updatedAt`, `viewsCount`) get kept out of
	// the editor without removing them from the schema.
	// Also drop `slug` regardless: it lives at the top level of `content` and
	// has its own dedicated sidebar input. Including it as a schema field
	// rendered a duplicate input and serialized to both `slug` and
	// `metadata.slug` on save. This filter handles collections imported before
	// the sync-side `slug` exclusion landed.
	const visibleSchemaFields =
		collection?.fields?.filter(
			(f) => !HIDDEN_FIELDS.has(f.name) && !f.ui?.hidden && f.name !== 'slug',
		) ?? []

	// The collection's primary image — a relation to a media-backed collection, or a
	// relation whose name reads like an image. It's rendered as a full-width preview near
	// the top of the sidebar instead of inline among the other fields, and excluded from
	// the generic schema-field block below so it isn't shown twice.
	const imageField =
		visibleSchemaFields.find(
			(f) =>
				f.type === 'relation' &&
				(getCollectionByName(f.relationTo ?? '')?.source === 'media' ||
					IMAGE_FIELD_NAME_RE.test(f.name)),
		) ?? null

	/**
	 * Treat a field as localized for the purposes of dispatch. Combines three sources:
	 * 1. Schema flag `f.localized` (definitive).
	 * 2. Current value shape (caught only for non-empty values).
	 * 3. Per-collection cache `knownLocalizedFields` (catches new records / empty cells).
	 */
	const isFieldLocalized = (f: { name: string; localized?: boolean }) =>
		f.localized ||
		isLocaleMap(extraFields[f.name], projectLocales, allowKnownCodes) ||
		knownLocalizedFields.has(f.name)

	// AI translation — only wired into the UI when the AI assistant is licensed,
	// the record is editable, AND the project actually has ≥2 locales to translate
	// between. With one locale, "Translate EN → EN" is meaningless noise.
	// Reuses the licensed `/api/v1/ai/complete` endpoint.
	const canTranslate = aiLicensed && !isReadOnly && effectiveLocales.length >= 2

	const translateText = async (
		text: string,
		sourceLocale: string,
		targetLocale: string,
		field: string,
	): Promise<string> => {
		const res = await api.post<{ text: string }>('/api/v1/ai/complete', {
			action: 'translate',
			field,
			selectedText: text,
			sourceLanguage: localeDisplayName(sourceLocale),
			targetLanguage: localeDisplayName(targetLocale),
		})
		return res.text
	}

	// Per-field translate: source-locale value → target-locale value, staged in
	// `extraFields` (the user reviews and Saves). Confirms before overwriting.
	const handleFieldTranslate = async (fieldName: string, source: string, target: string) => {
		if (source === target) return
		const map = toLocaleValueMap(extraFields[fieldName], defaultLocale)
		if (!(map[source] ?? '').trim()) {
			toast(
				t('collections.detail.translate.nothingToTranslate', { lang: localeDisplayName(source) }),
				'error',
			)
			return
		}
		if ((map[target] ?? '').trim()) {
			const ok = await confirm({
				title: t('collections.detail.translate.replaceTitle'),
				message: t('collections.detail.translate.replaceMessage', {
					lang: localeDisplayName(target),
					field: fieldName,
				}),
				confirmLabel: t('collections.detail.translate.replace'),
			})
			if (!ok) return
		}
		setTranslatingFields((s) => new Set(s).add(fieldName))
		try {
			const translated = await translateText(map[source] ?? '', source, target, fieldName)
			setExtraFields((prev) => {
				const cur = toLocaleValueMap(prev[fieldName], defaultLocale)
				return { ...prev, [fieldName]: { ...cur, [target]: translated } }
			})
			setDirty(true)
		} catch (err) {
			toast(err instanceof Error ? err.message : t('collections.detail.translate.failed'), 'error')
		} finally {
			setTranslatingFields((s) => {
				const next = new Set(s)
				next.delete(fieldName)
				return next
			})
		}
	}

	/**
	 * Append a new option to an enum field's `options` array via PATCH to the
	 * parent collection. Used by the dropdown's "+ Add option…" row so editors
	 * can mint a new enum value without leaving the form. Refreshes the
	 * collections cache so the new option shows up immediately.
	 *
	 * Permission-gated: only owners/admins should ever be passed as the
	 * dropdown's `onAddOption` (see canEditSchema).
	 */
	const addEnumOption = async (fieldName: string, newValue: string) => {
		if (!collection) throw new Error(t('collections.detail.errors.noCollection'))
		const next = (collection.fields ?? []).map((field) => {
			if (field.name !== fieldName) return field
			const existing = field.options ?? []
			if (existing.includes(newValue)) return field
			return { ...field, options: [...existing, newValue] }
		})
		await api.put(`/api/v1/collections/${collection.id}`, { fields: next })
		await refreshCollections()
	}

	// Bulk translate: every localized field (staged in `extraFields`) plus the document
	// body, from the left (source) locale to the right (target) locale. The body lives
	// in a separate per-locale `content` row, so it is created/updated directly.
	const handleBulkTranslate = async () => {
		if (!collection) return
		const source = localeUi.leftLocale
		const target = localeUi.rightLocale
		if (source === target) return

		const fieldNames: string[] = []
		for (const f of visibleSchemaFields) {
			if (isFieldLocalized(f)) fieldNames.push(f.name)
		}
		for (const [k, v] of Object.entries(extraFields)) {
			if (!fieldNames.includes(k) && isLocaleMap(v, projectLocales, allowKnownCodes)) {
				fieldNames.push(k)
			}
		}

		const translateBody = !isNew && markdown.trim().length > 0
		if (fieldNames.length === 0 && !translateBody) {
			toast(t('collections.detail.translate.nothingOnRecord'), 'error')
			return
		}

		const fieldsLabel =
			fieldNames.length > 0
				? t('collections.detail.translate.localizedFieldsLabel', { count: fieldNames.length })
				: ''
		const parts = [
			fieldsLabel,
			translateBody ? t('collections.detail.translate.documentBody') : '',
		].filter(Boolean)
		const ok = await confirm({
			title: t('collections.detail.translate.translateTitle'),
			message: t('collections.detail.translate.translateMessage', {
				what: parts.join(t('collections.detail.translate.joinAnd')),
				source: localeDisplayName(source),
				target: localeDisplayName(target),
				saveFirstNote: isNew ? t('collections.detail.translate.saveFirstNote') : '',
			}),
			confirmLabel: t('collections.detail.translate.translate'),
		})
		if (!ok) return

		setBulkTranslating(true)
		try {
			const fieldUpdates: Record<string, Record<string, string>> = {}
			for (const name of fieldNames) {
				const map = toLocaleValueMap(extraFields[name], defaultLocale)
				if (!(map[source] ?? '').trim()) continue
				const translated = await translateText(map[source] ?? '', source, target, name)
				fieldUpdates[name] = { ...map, [target]: translated }
			}
			if (Object.keys(fieldUpdates).length > 0) {
				setExtraFields((prev) => {
					const next = { ...prev }
					for (const [k, v] of Object.entries(fieldUpdates)) next[k] = v
					return next
				})
				setDirty(true)
			}

			if (translateBody) {
				const translatedBody = await translateText(markdown, source, target, 'body')
				const siblingMetadata: Record<string, unknown> = {
					...collectMetadata(resolveAutoTitle()),
				}
				for (const [k, v] of Object.entries(fieldUpdates)) siblingMetadata[k] = v

				const translations = await api.get<Record<string, { id: string }>>(
					`/api/v1/locales/translations/${encodeURIComponent(contentSlug)}`,
				)
				const siblingId = translations[target]?.id
				if (siblingId) {
					await api.put(`/api/v1/content/${siblingId}`, {
						slug: contentSlug,
						markdown: translatedBody,
						metadata: siblingMetadata,
					})
				} else {
					await api.post('/api/v1/content', {
						slug: contentSlug,
						collectionId: collection.id,
						locale: target,
						markdown: translatedBody,
						metadata: siblingMetadata,
						status: 'draft',
					})
				}
				toast(
					t('collections.detail.translate.translatedDocument', { lang: localeDisplayName(target) }),
					'success',
				)
			} else {
				toast(
					t('collections.detail.translate.translatedFields', { lang: localeDisplayName(target) }),
					'success',
				)
			}
		} catch (err) {
			toast(err instanceof Error ? err.message : t('collections.detail.translate.failed'), 'error')
		} finally {
			setBulkTranslating(false)
		}
	}

	const hasLocalizedField =
		visibleSchemaFields.some(isFieldLocalized) ||
		Object.entries(extraFields).some(([, v]) => isLocaleMap(v, projectLocales, allowKnownCodes))
	const showLocalizationBar = effectiveLocales.length >= 2 || hasLocalizedField

	/**
	 * "Article-shaped" records have a long-form body — they get the big title input
	 * and the markdown editor as the central element, with schema fields in the sidebar.
	 *
	 * "Form-shaped" records (the article-authors case: name/slug/jobTitle/bio/…, no
	 * `title` or `content` field in the schema) don't have a body to feature, so we
	 * promote the schema fields themselves to the central column and drop the empty
	 * title/markdown placeholders that would otherwise dominate the page.
	 *
	 * Detection is schema-driven: a collection is article-shaped iff it declares a
	 * `title`, `content`, or `body` field. Predictable, no per-record heuristics.
	 */
	const isArticleLayout =
		collection?.fields?.some(
			(f) => f.name === 'title' || f.name === 'content' || f.name === 'body',
		) ?? true

	// Schema field renderer — used by either the central column (form layout) or the
	// sidebar (article layout). Delegates the widget dispatch to FieldRenderer so
	// every widget honours the same `ui` blob (placeholder, readOnly, separator,
	// helpText, …) instead of just the text branch.
	const renderSchemaField = (f: (typeof visibleSchemaFields)[number]) => (
		<Field
			key={f.name}
			label={f.label?.trim() || f.name}
			error={fieldErrors[f.name]}
			helpText={f.ui?.helpText}
		>
			<FieldRenderer
				field={f}
				value={extraFields[f.name]}
				onChange={(v) => {
					setExtraFields((prev) => ({ ...prev, [f.name]: v }))
					setDirty(true)
				}}
				disabled={isReadOnly || !!f.ui?.readOnly}
				localized={isFieldLocalized(f)}
				locale={{
					mode: localeUi.mode,
					activeLocale: localeUi.activeLocale,
					leftLocale: localeUi.leftLocale,
					rightLocale: localeUi.rightLocale,
					defaultLocale,
				}}
				onTranslate={
					canTranslate ? (src, tgt) => handleFieldTranslate(f.name, src, tgt) : undefined
				}
				translating={translatingFields.has(f.name) || bulkTranslating}
				onAddEnumOption={
					canEditSchema && f.type === 'enum'
						? (newValue) => addEnumOption(f.name, newValue)
						: undefined
				}
			/>
		</Field>
	)

	// Group adjacent date fields into a 2-up row. Handles the very common
	// `createdAt` + `updatedAt` case at the end of a record, where two narrow date
	// inputs at full-width feel wasteful. Pairing happens only for back-to-back
	// dates in the schema order so the visual flow isn't reordered.
	const schemaFieldsBlock: React.ReactNode[] = []
	// The image field is rendered separately at the top of the sidebar.
	const blockFields = imageField
		? visibleSchemaFields.filter((f) => f !== imageField)
		: visibleSchemaFields
	for (let i = 0; i < blockFields.length; i++) {
		const f = blockFields[i]
		const next = blockFields[i + 1]
		if (f.type === 'date' && next?.type === 'date') {
			schemaFieldsBlock.push(
				<div key={`date-pair-${f.name}-${next.name}`} className="grid grid-cols-2 gap-4">
					{renderSchemaField(f)}
					{renderSchemaField(next)}
				</div>,
			)
			i++ // skip the partner — it was just rendered
			continue
		}
		schemaFieldsBlock.push(renderSchemaField(f))
	}

	return (
		<div className="flex h-full">
			{/* `pt-6` matches the sidebar's `p-6` top padding so the breadcrumb + locale-bar
			    row aligns vertically with the Save button. `px-8 pb-8` keeps the editor's
			    generous horizontal/bottom rhythm. */}
			<div className="flex-1 overflow-auto px-8 pt-6 pb-8" ref={editorContainerRef}>
				{/* Centered reading column. Everything inside the central area — breadcrumb +
				    locale bar, banners, title/markdown (article layout), form fields (form
				    layout) — shares this same max-width so the layout reads as one cohesive
				    centered column rather than left-aligned content. */}
				<div className="max-w-3xl mx-auto">
					{/* Top row: breadcrumb (left) + locale switcher (right) */}
					{/* `items-start` keeps the breadcrumb's first row aligned with the locale bar
					    (and, downstream, with the Save button in the sidebar). When the id row
					    appears below, it doesn't shove the bar down with it.
					    `relative z-20` raises the row above the form fields below so the open
					    locale dropdown menu paints on top of them (without this, the bar's
					    scale transform creates its own stacking context whose internal z-50 is
					    still painted under later siblings). */}
					<div className="relative z-20 flex items-start justify-between gap-4 mb-4">
						{(() => {
							// Prefer the record's own name/title fields as the breadcrumb label.
							// Falls back to the top-level title input (set on article-layout
							// records), then to the contentSlug. When a friendly label IS found,
							// the slug/id renders on its own row below the breadcrumb, left-aligned
							// with the collection-name button.
							const friendlyLabel =
								extractLabel(extraFields.name, defaultLocale) ||
								extractLabel(extraFields.title, defaultLocale) ||
								title.trim() ||
								null
							const primary = isNew
								? t('collections.detail.newRecord')
								: friendlyLabel || contentSlug
							const secondary = !isNew && friendlyLabel ? contentSlug : null
							return (
								<div className="min-w-0 flex-1">
									{/* Breadcrumb row — h-9 matches the locale bar's height so both anchor
									    at the same baseline regardless of whether the id row is present. */}
									<div className="flex items-center gap-2 text-sm text-text-muted min-w-0 h-9">
										<button
											type="button"
											onClick={() => navigate({ to: `/collections/${slug}` })}
											className="hover:text-text transition-colors shrink-0"
										>
											{collection?.label || slug}
										</button>
										<span className="shrink-0">/</span>
										<span className="text-text truncate">{primary}</span>
										{isReadOnly && (
											<span className="ml-2 px-1.5 py-0.5 text-[10px] font-medium uppercase rounded bg-surface-alt text-text-muted shrink-0">
												{t('collections.detail.readOnly')}
											</span>
										)}
									</div>
									{/* ID row — sits on its own line, flush left with the collection-name
									    button above. Mono+muted so it reads as metadata, not as content. */}
									{secondary && (
										<div className="text-[11px] text-text-muted/70 font-mono truncate -mt-1">
											{secondary}
										</div>
									)}
								</div>
							)
						})()}
						{/* Locale region — keeps the bar AND the recovery globe icon mounted at
					    the same time so CSS can cross-interpolate between them. Both anchor to
					    the right; when the bar shows up, it scales open from the icon's slot
					    (origin-right + max-width transition + scale + fade); the icon collapses
					    in parallel. When the user dismisses and the bar hides, the icon expands
					    back into the same slot. `max-w-0` is needed because `width: auto` isn't
					    transitionable. */}
						{(showLocalizationBar || latentMissingLocales.length > 0) && (
							<div className="shrink-0 relative inline-flex items-center justify-end h-9">
								{/* Bar — animated reveal */}
								{/* No `overflow-hidden` — the dropdown menu inside opens below via
								    absolute positioning and would be clipped to the bar's height by
								    any clipping ancestor. `opacity-0` + `pointer-events-none` already
								    make the collapsed state invisible/inert. */}
								<div
									aria-hidden={!showLocalizationBar}
									className={`flex items-center origin-right transition-all duration-500 ease-[cubic-bezier(0.16,1,0.3,1)] ${
										showLocalizationBar
											? 'max-w-[40rem] opacity-100 scale-100'
											: 'max-w-0 opacity-0 scale-50 pointer-events-none'
									}`}
								>
									<LocalizationBar
										mode={localeUi.mode}
										onModeChange={(mode) =>
											// Sync leftLocale ↔ activeLocale on toggle so the primary dropdown's
											// displayed value doesn't flip mid-animation. Going to compare: the
											// locale the user was viewing becomes the left pane; if rightLocale
											// would collide, bump it to the next effective locale so both panes
											// don't render the same language. Going back to single: the left pane
											// becomes the active locale.
											setLocaleUi((s) => {
												if (mode === 'compare') {
													const left = s.activeLocale
													const right =
														s.rightLocale !== left
															? s.rightLocale
															: (effectiveLocales.find((l) => l !== left) ?? s.rightLocale)
													return { ...s, mode, leftLocale: left, rightLocale: right }
												}
												return { ...s, mode, activeLocale: s.leftLocale }
											})
										}
										activeLocale={localeUi.activeLocale}
										onActiveLocaleChange={(activeLocale) =>
											setLocaleUi((s) => ({ ...s, activeLocale }))
										}
										leftLocale={localeUi.leftLocale}
										onLeftLocaleChange={(leftLocale) =>
											// If the new left collides with the current right, swap the panes —
											// otherwise the user would have to leave compare mode to swap (and
											// with only 2 effective locales it'd lock entirely).
											setLocaleUi((s) =>
												s.mode === 'compare' && s.rightLocale === leftLocale
													? { ...s, leftLocale, rightLocale: s.leftLocale }
													: { ...s, leftLocale },
											)
										}
										rightLocale={localeUi.rightLocale}
										onRightLocaleChange={(rightLocale) =>
											setLocaleUi((s) =>
												s.mode === 'compare' && s.leftLocale === rightLocale
													? { ...s, rightLocale, leftLocale: s.rightLocale }
													: { ...s, rightLocale },
											)
										}
										locales={effectiveLocales}
										onTranslate={canTranslate ? handleBulkTranslate : undefined}
										translating={bulkTranslating}
									/>
								</div>

								{/* Globe icon — animated counterpart. Absolutely positioned so it sits
							    in the same slot as the bar's right edge; fades+shrinks out when
							    the bar arrives, then fades+grows back when the bar leaves. */}
								{latentMissingLocales.length > 0 && (
									<button
										type="button"
										onClick={() => runLocalePrompt(latentMissingLocales)}
										aria-hidden={showLocalizationBar}
										aria-label={t('collections.detail.locale.detectedAriaLabel', {
											count: latentMissingLocales.length,
										})}
										title={t('collections.detail.locale.detectedTitle', {
											langs: latentMissingLocales.map((l) => l.toUpperCase()).join(', '),
										})}
										className={`absolute right-0 inline-flex items-center justify-center w-9 h-9 rounded-lg bg-surface-alt/40 border border-border text-text-muted hover:text-text hover:bg-surface-alt origin-right transition-all duration-300 ease-[cubic-bezier(0.16,1,0.3,1)] ${
											showLocalizationBar
												? 'opacity-0 scale-50 pointer-events-none delay-0'
												: 'opacity-100 scale-100 delay-200'
										}`}
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
											<circle cx="12" cy="12" r="10" />
											<path d="M2 12h20" />
											<path d="M12 2a15.3 15.3 0 014 10 15.3 15.3 0 01-4 10 15.3 15.3 0 01-4-10 15.3 15.3 0 014-10z" />
										</svg>
										<span className="absolute top-1.5 right-1.5 w-1.5 h-1.5 rounded-full bg-btn-primary" />
									</button>
								)}
							</div>
						)}
					</div>

					{/* Draft restore banner */}
					{showDraftRestore && (
						<div className="flex items-center justify-between px-4 py-2.5 mb-4 rounded-lg bg-surface-alt border border-border">
							<span className="text-sm text-text-secondary">
								{t('collections.detail.draftRestore.message')}
							</span>
							<div className="flex gap-2">
								<button
									type="button"
									onClick={restoreDraft}
									className="px-3 py-1 bg-btn-primary text-btn-primary-text rounded text-xs font-medium hover:bg-btn-primary-hover"
								>
									{t('collections.detail.draftRestore.restore')}
								</button>
								<button
									type="button"
									onClick={dismissDraft}
									className="px-3 py-1 text-text-muted hover:text-text text-xs"
								>
									{t('collections.detail.draftRestore.dismiss')}
								</button>
							</div>
						</div>
					)}

					{isReadOnly && (
						<div className="flex items-center gap-2 mb-4 px-3 py-2 rounded-lg bg-surface-alt text-xs text-text-muted">
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
								<rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
								<path d="M7 11V7a5 5 0 0110 0v4" />
							</svg>
							{isLive
								? t('collections.detail.readOnlyLive')
								: t('collections.detail.readOnlyContent')}
						</div>
					)}

					{isArticleLayout ? (
						<>
							{/* Title — above editor */}
							<input
								type="text"
								value={title}
								onChange={(e) => {
									setTitle(e.target.value)
									setDirty(true)
									if (isNew) setContentSlug(generateSlug(e.target.value))
								}}
								placeholder={t('collections.detail.titlePlaceholder')}
								disabled={isReadOnly}
								className="w-full text-3xl font-bold bg-transparent border-none outline-none mb-6 placeholder:text-text-muted disabled:opacity-60"
							/>

							<MarkdownEditor
								content={markdown}
								onChange={(v) => {
									if (!isReadOnly) {
										setMarkdown(v)
										setDirty(true)
									}
								}}
							/>

							{editorContainerRef.current && aiSelectedText && (
								<SelectionToolbar
									containerRef={editorContainerRef as React.RefObject<HTMLElement>}
									onAction={(_action: string, _selectedText: string, _fieldName: string) => {
										setAiTargetField('markdown')
										setShowAi(true)
									}}
									fieldName="markdown"
								/>
							)}
						</>
					) : (
						// Form layout: schema fields take the central column. The outer
						// `max-w-3xl mx-auto` wrapper already constrains and centers; this just
						// stacks the fields with consistent spacing.
						<div className="space-y-4">{schemaFieldsBlock}</div>
					)}
				</div>
			</div>

			{/* Sidebar — widens for compare mode only when localized fields actually render
			    here (article layout). Form-shaped records put their localized fields in the
			    central column, where there's already room for side-by-side. Gate on
			    `hasLocalizedField` so an empty/non-localized record keeps the narrow sidebar
			    even when compare mode is the persisted preference. */}
			<div
				className={`${
					isArticleLayout && localeUi.mode === 'compare' && hasLocalizedField ? 'w-[36rem]' : 'w-72'
				} border-l border-border flex flex-col overflow-hidden shrink-0 relative transition-[width] duration-150`}
			>
				<div className="flex-1 overflow-auto p-6 space-y-4">
					<div className="flex gap-2">
						{!isReadOnly && (
							<button
								type="button"
								onClick={save}
								disabled={saving}
								className="flex-1 px-4 py-2 bg-btn-primary text-btn-primary-text rounded text-sm font-medium hover:bg-btn-primary-hover disabled:opacity-50"
							>
								{saving ? t('collections.detail.saving') : t('collections.detail.save')}
							</button>
						)}
						{/*
						 * Primary publish action — adapts to project + member config:
						 *   - canPublishDirectly → "Publish" (or "Save & publish" for a new record)
						 *   - else, requireReview → "Submit for review"
						 * Approve/Reject still appear for admins on a pending_review item
						 * regardless. The legacy "Publish" button for un-licensed projects
						 * goes away — direct publish is now the default for solo projects.
						 */}
						{!isReadOnly && status !== 'published' && canPublishDirectly && (
							<button
								type="button"
								onClick={publishDirectly}
								disabled={saving}
								className="px-4 py-2 bg-btn-secondary text-text rounded text-sm font-medium hover:bg-btn-secondary-hover disabled:opacity-50"
							>
								{t('collections.detail.publish')}
							</button>
						)}
						{!isNew &&
							!isReadOnly &&
							status === 'draft' &&
							!canPublishDirectly &&
							requireReview && (
								<button
									type="button"
									onClick={submitForReview}
									disabled={saving}
									className="px-4 py-2 bg-btn-secondary text-text rounded text-sm font-medium hover:bg-btn-secondary-hover disabled:opacity-50"
								>
									{t('collections.detail.submit')}
								</button>
							)}
						{!isNew &&
							!isReadOnly &&
							status === 'pending_review' &&
							reviewWorkflowsLicensed &&
							canApprove && (
								<>
									<button
										type="button"
										onClick={approveContent}
										disabled={saving}
										className="px-4 py-2 bg-btn-primary text-btn-primary-text rounded text-sm font-medium hover:bg-btn-primary-hover disabled:opacity-50"
									>
										{t('collections.detail.approve')}
									</button>
									<button
										type="button"
										onClick={rejectContent}
										disabled={saving}
										className="px-4 py-2 bg-btn-secondary text-text rounded text-sm font-medium hover:bg-btn-secondary-hover disabled:opacity-50"
									>
										{t('collections.detail.reject.button')}
									</button>
								</>
							)}
					</div>

					{/* Sidebar field order: status → image preview → slug → tags → the rest.
				    status + slug are always rendered — external (MongoDB-backed) collections
				    also have `content.status` and `content.slug` at the row level. */}
					<Field label={t('collections.detail.fields.status')}>
						<Dropdown
							value={status}
							onChange={(v) => {
								setStatus(v)
								setDirty(true)
							}}
							options={[
								{ value: 'draft', label: t('collections.detail.statusOptions.draft') },
								{
									value: 'pending_review',
									label: t('collections.detail.statusOptions.pendingReview'),
								},
								{ value: 'published', label: t('collections.detail.statusOptions.published') },
								{ value: 'archived', label: t('collections.detail.statusOptions.archived') },
							]}
							className="w-full"
						/>
					</Field>

					{/* Full-width preview of the collection's image (e.g. featuredImage). The
				    RelationField in `imagePreview` mode shows the actual image at sidebar
				    width plus the picker/upload control to change it. */}
					{imageField && (
						<Field label={imageField.label?.trim() || imageField.name}>
							<RelationField
								value={String(extraFields[imageField.name] ?? '')}
								relationTo={imageField.relationTo}
								disabled={isReadOnly || !!imageField.ui?.readOnly}
								onChange={(v) => {
									setExtraFields((prev) => ({ ...prev, [imageField.name]: v }))
									setDirty(true)
								}}
								imagePreview
							/>
						</Field>
					)}

					<Field label={t('collections.detail.fields.slug')}>
						<input
							type="text"
							value={contentSlug}
							onChange={(e) => {
								setContentSlug(e.target.value)
								setDirty(true)
							}}
							className="w-full px-3 py-2 bg-input border border-border rounded text-sm focus:outline-none focus:border-border-strong font-mono"
						/>
					</Field>

					{/* Tags get a dedicated editor only when the collection actually models them
				    (schema has a `tags` field) OR the loaded record already has tags. Otherwise
				    rendering an empty pill input on every collection — including ones whose
				    external schema has no `tags` column — is just noise. */}
					{(collection?.fields?.some((f) => f.name === 'tags') || tags.length > 0) && (
						<Field label={t('collections.detail.fields.tags')}>
							<PillInput
								value={tags}
								onChange={(v) => {
									setTags(v)
									setDirty(true)
								}}
								placeholder={t('collections.detail.tagsPlaceholder')}
								disabled={isReadOnly}
							/>
						</Field>
					)}

					{/* Schema fields render here only when this is an article-shaped record
				    (title+markdown in the center). For form-shaped records they're rendered
				    in the central column above; the sidebar keeps only save/meta. */}
					{isArticleLayout && schemaFieldsBlock}

					{/* Additional fields — fields in metadata not in the schema */}
					{(() => {
						const schemaNames = new Set(collection?.fields.map((f) => f.name) ?? [])
						schemaNames.add('title')
						// `slug` and `status` are top-level content fields with dedicated sidebar
						// controls — never surface them as an "additional" metadata field even if a
						// legacy record stored them inside metadata (the `status` case is the
						// duplicate-"Status" bug).
						schemaNames.add('slug')
						schemaNames.add('status')
						if (!isExternal) {
							schemaNames.add('tags')
						}
						const additionalEntries = Object.entries(extraFields).filter(
							([key]) => !schemaNames.has(key),
						)
						if (additionalEntries.length === 0) return null
						return (
							<div>
								<button
									type="button"
									onClick={() => setShowExtraFields(!showExtraFields)}
									className="flex items-center gap-1.5 text-xs text-text-secondary hover:text-text transition-colors w-full"
								>
									<svg
										width="10"
										height="10"
										viewBox="0 0 24 24"
										fill="none"
										stroke="currentColor"
										strokeWidth="2"
										strokeLinecap="round"
										strokeLinejoin="round"
										className={`transition-transform ${showExtraFields ? 'rotate-90' : ''}`}
									>
										<polyline points="9 18 15 12 9 6" />
									</svg>
									{t('collections.detail.additionalFields', { count: additionalEntries.length })}
								</button>
								{showExtraFields && (
									<div className="mt-2 space-y-2">
										{additionalEntries.map(([key, val]) => (
											<div key={key}>
												<label
													htmlFor={`meta-field-${key}`}
													className="block text-[10px] text-text-muted mb-0.5 font-mono"
												>
													{key}
												</label>
												{isLocaleMap(val, projectLocales, allowKnownCodes) ? (
													<LocalizedTextField
														value={val}
														mode={localeUi.mode}
														activeLocale={localeUi.activeLocale}
														leftLocale={localeUi.leftLocale}
														rightLocale={localeUi.rightLocale}
														defaultLocale={defaultLocale}
														onTranslate={
															canTranslate
																? (src, tgt) => handleFieldTranslate(key, src, tgt)
																: undefined
														}
														translating={translatingFields.has(key) || bulkTranslating}
														onChange={(v) => {
															setExtraFields((prev) => ({ ...prev, [key]: v }))
															setDirty(true)
														}}
														disabled={isReadOnly}
													/>
												) : isObjectArray(val) ? (
													<ObjectArrayField
														value={val}
														onChange={(v) => {
															setExtraFields((prev) => ({ ...prev, [key]: v }))
															setDirty(true)
														}}
														disabled={isReadOnly}
													/>
												) : val !== null && typeof val === 'object' ? (
													<JsonField
														value={val}
														onChange={(v) => {
															setExtraFields((prev) => ({ ...prev, [key]: v }))
															setDirty(true)
														}}
														disabled={isReadOnly}
													/>
												) : (
													<input
														id={`meta-field-${key}`}
														type="text"
														value={String(val ?? '')}
														onChange={(e) => {
															setExtraFields((prev) => ({ ...prev, [key]: e.target.value }))
															setDirty(true)
														}}
														disabled={isReadOnly}
														className="w-full px-2 py-1.5 bg-input border border-border rounded text-xs font-mono focus:outline-none focus:border-border-strong disabled:opacity-60"
													/>
												)}
											</div>
										))}
										{!isReadOnly && (
											<button
												type="button"
												onClick={async () => {
													const key = await prompt({
														title: t('collections.detail.addField.title'),
														label: t('collections.detail.addField.label'),
														required: true,
														confirmLabel: t('collections.detail.addField.confirm'),
													})
													if (key?.trim()) {
														setExtraFields((prev) => ({ ...prev, [key.trim()]: '' }))
														setDirty(true)
														setShowExtraFields(true)
													}
												}}
												className="text-[10px] text-text-muted hover:text-text-secondary transition-colors"
											>
												{t('collections.detail.addField.button')}
											</button>
										)}
									</div>
								)}
							</div>
						)
					})()}

					{/* Add field button when no extra fields exist yet */}
					{Object.keys(extraFields).length === 0 && !isReadOnly && !isNew && (
						<button
							type="button"
							onClick={async () => {
								const key = await prompt({
									title: t('collections.detail.addField.title'),
									label: t('collections.detail.addField.label'),
									required: true,
									confirmLabel: t('collections.detail.addField.confirm'),
								})
								if (key?.trim()) {
									setExtraFields((prev) => ({ ...prev, [key.trim()]: '' }))
									setDirty(true)
									setShowExtraFields(true)
								}
							}}
							className="text-xs text-text-muted hover:text-text-secondary transition-colors"
						>
							{t('collections.detail.addField.customButton')}
						</button>
					)}

					{/* Collection name is redundant here — the breadcrumb in the central column
				    already shows `Collection Name / Record`. */}

					{!isNew && (
						<Field label={t('collections.detail.fields.version')}>
							<p className="text-sm text-text-secondary">v{version}</p>
						</Field>
					)}

					{externalId && (
						<Field label={t('collections.detail.fields.externalId')}>
							<p className="text-xs text-text-muted font-mono break-all">{externalId}</p>
						</Field>
					)}

					{!isNew && !isExternal && (
						<VersionPanel
							contentId={contentId}
							currentVersion={version}
							onRevert={() => {
								api
									.get<{ markdown: string; metadata: Record<string, unknown>; version: number }>(
										`/api/v1/content/${contentId}`,
									)
									.then((item) => {
										const { body, meta } = parseFrontmatter(item.markdown)
										setMarkdown(body.trim())
										setTitle((meta.title as string) || (item.metadata?.title as string) || '')
										setVersion(item.version)
										setDirty(false)
									})
							}}
						/>
					)}
				</div>

				{/* AI assistant — pinned to the bottom of the sidebar so it stays visible
				    no matter how far the fields above are scrolled. Violet gradient matches
				    the Pro badge (it's a Pro feature); `px-6` aligns its width with the
				    inputs above. Unlicensed users get the upgrade prompt in the panel. */}
				<div className="border-t border-border px-6 py-4 shrink-0">
					<button
						type="button"
						onClick={() => setShowAi(!showAi)}
						className="w-full px-3 py-2 bg-gradient-to-r from-violet-500 to-purple-500 text-white rounded text-sm font-medium hover:opacity-90 transition-opacity"
					>
						{showAi ? t('collections.detail.hideAi') : t('collections.detail.aiAssistant')}
					</button>
				</div>

				{/* The AI assistant overlays THIS sidebar rather than opening a second
				    column to the right. It covers the fields + button; close from within. */}
				{showAi && (
					<div className="absolute inset-0 z-20 flex flex-col bg-bg">
						{aiLicensed ? (
							<AiChatPanel
								targetField={aiTargetField}
								selectedText={aiSelectedText}
								onApply={(_field: string, text: string) => {
									setMarkdown((prev) => `${prev}\n\n${text}`)
									setDirty(true)
								}}
								onClose={() => setShowAi(false)}
							/>
						) : (
							<>
								<div className="flex justify-end border-b border-border p-2">
									<button
										type="button"
										onClick={() => setShowAi(false)}
										aria-label={t('collections.detail.hideAi')}
										className="p-1.5 text-text-muted hover:text-text rounded hover:bg-surface-alt transition-colors"
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
											aria-hidden="true"
										>
											<path d="M18 6 6 18" />
											<path d="m6 6 12 12" />
										</svg>
									</button>
								</div>
								<div className="flex-1 overflow-auto">
									<UpgradePrompt feature="AI Assistant" plan="Pro" />
								</div>
							</>
						)}
					</div>
				)}
			</div>
		</div>
	)
}

function Field({
	label,
	children,
	error,
	helpText,
}: {
	label: string
	children: React.ReactNode
	error?: string | null
	helpText?: string | null
}) {
	return (
		// biome-ignore lint/a11y/noLabelWithoutControl: generic field wrapper — the control is passed in as children and rendered inside this label.
		<label className="block">
			<span className="block text-xs text-text-secondary mb-1.5">{label}</span>
			{children}
			{helpText && !error && <span className="block text-xs text-text-muted mt-1">{helpText}</span>}
			{error && (
				<span className="block text-xs text-red-500 mt-1" role="alert">
					{error}
				</span>
			)}
		</label>
	)
}
