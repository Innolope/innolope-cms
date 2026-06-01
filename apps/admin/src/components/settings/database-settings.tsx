import { useNavigate } from '@tanstack/react-router'
import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { api } from '../../lib/api-client'
import { useAuth } from '../../lib/auth'
import { useCollections } from '../../lib/collections'
import { useToast } from '../../lib/toast'
import { Dropdown } from '../dropdown'
import { useLicense } from '../license-gate'
import { SaveBar } from '../save-bar'

interface DetectedTable {
	name: string
	columns: { name: string; type: string; relationTo?: string; relationIsArray?: boolean }[]
	count?: number
	sizeBytes?: number
}

function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`
	if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
	return `${Math.round(bytes / 1024 / 1024)} MB`
}

/** Unique collection names this table references that also exist in the scanned set. */
function relationTargets(table: DetectedTable, allTables: DetectedTable[]): string[] {
	const known = new Set(allTables.map((t) => t.name))
	const targets = new Set<string>()
	for (const col of table.columns) {
		if (col.relationTo && known.has(col.relationTo) && col.relationTo !== table.name) {
			targets.add(col.relationTo)
		}
	}
	return [...targets]
}

// ─── Media-library detection ──────────────────────────────────────────────
const MEDIA_NAME_RE = /^(media|images?|files?|assets?|uploads?|photos?|gallery|attachments?)s?$/i
const FILE_REF_RE = /(^|_)(url|src|path|image|photo|file|thumbnail)($|_)/i
const FILE_META_RE = /(^|_)(mime|mimetype|filename|filesize|size|width|height|alt)($|_)/i

/** Split camelCase so `imageUrl` matches the `_`-delimited column patterns. */
const splitCamelCol = (name: string) => name.replace(/([a-z0-9])([A-Z])/g, '$1_$2')

/** Heuristic: does this imported table look like a media library? */
function isMediaTable(table: DetectedTable): boolean {
	if (MEDIA_NAME_RE.test(table.name)) return true
	const hasRef = table.columns.some((c) => FILE_REF_RE.test(splitCamelCol(c.name)))
	const hasMeta = table.columns.some((c) => FILE_META_RE.test(splitCamelCol(c.name)))
	return hasRef && hasMeta
}

/** Best guess for the column holding the file path/key. */
function pickPathColumn(table: DetectedTable): string {
	const ref = table.columns.find((c) => FILE_REF_RE.test(splitCamelCol(c.name)))
	return ref?.name || table.columns[0]?.name || ''
}

/** Heuristic applied to an already-imported collection (operates on its `fields`). */
function isMediaCollectionLike(col: { name: string; fields: { name: string }[] }): boolean {
	if (MEDIA_NAME_RE.test(col.name)) return true
	const hasRef = col.fields.some((f) => FILE_REF_RE.test(splitCamelCol(f.name)))
	const hasMeta = col.fields.some((f) => FILE_META_RE.test(splitCamelCol(f.name)))
	return hasRef && hasMeta
}

/** Best guess for the file-path field of an imported collection. */
function pickPathField(fields: { name: string }[]): string {
	return fields.find((f) => FILE_REF_RE.test(splitCamelCol(f.name)))?.name || fields[0]?.name || ''
}

interface MediaCreds {
	accountId: string
	accessKeyId: string
	secretAccessKey: string
	bucket: string
	accountHash: string
	signingKey: string
	apiToken: string
}

const emptyCreds = (): MediaCreds => ({
	accountId: '',
	accessKeyId: '',
	secretAccessKey: '',
	bucket: '',
	accountHash: '',
	signingKey: '',
	apiToken: '',
})

interface MediaStorageConfig {
	enabled: boolean
	adapter: string
	pathColumn: string
	baseUrl: string
	access?: 'public' | 'private'
	credentials?: MediaCreds
	/** Server flag: credentials are already stored (the values themselves are never sent). */
	hasCredentials?: boolean
}

// `label` is a brand name kept verbatim; `descKey` is an i18n key resolved at render.
const DB_OPTIONS = [
	{
		value: 'built-in',
		label: 'Innolope CMS',
		descKey: 'settings.database.dbDesc.builtIn',
		logo: '/logo.svg',
	},
	{
		value: 'mongodb',
		label: 'MongoDB',
		descKey: 'settings.database.dbDesc.mongodb',
		logo: '/db-logos/mongodb.svg',
	},
	{
		value: 'postgresql',
		label: 'PostgreSQL',
		descKey: 'settings.database.dbDesc.postgresql',
		logo: '/db-logos/postgresql.svg',
	},
	{
		value: 'mysql',
		label: 'MySQL',
		descKey: 'settings.database.dbDesc.mysql',
		logo: '/db-logos/mysql.svg',
	},
	{
		value: 'supabase',
		label: 'Supabase',
		descKey: 'settings.database.dbDesc.supabase',
		logo: '/db-logos/supabase.svg',
	},
	{
		value: 'cockroachdb',
		label: 'CockroachDB',
		descKey: 'settings.database.dbDesc.cockroachdb',
		logo: '/db-logos/cockroachdb.svg',
	},
	{
		value: 'firebase',
		label: 'Firebase',
		descKey: 'settings.database.dbDesc.firebase',
		logo: '/db-logos/firebase.svg',
	},
	{
		value: 'neon',
		label: 'Neon',
		descKey: 'settings.database.dbDesc.neon',
		logo: '/db-logos/neon.svg',
	},
	{
		value: 'vercel-postgres',
		label: 'Vercel Postgres',
		descKey: 'settings.database.dbDesc.vercelPostgres',
		logo: '/db-logos/vercel.svg',
	},
] as const

// Static identifiers and structural data live here; user-facing strings (label,
// instructions) are i18n keys resolved at render in the components below.
const CONNECTION_HELP: Record<
	string,
	{ labelKey: string; placeholder: string; instructionKeys: string[]; format: string }
> = {
	mongodb: {
		labelKey: 'settings.database.connHelp.mongodb.label',
		placeholder: 'mongodb+srv://username:password@cluster.mongodb.net/database',
		format: 'mongodb+srv://<username>:<password>@<cluster>.mongodb.net/<database>',
		instructionKeys: [
			'settings.database.connHelp.mongodb.instructions.0',
			'settings.database.connHelp.mongodb.instructions.1',
			'settings.database.connHelp.mongodb.instructions.2',
		],
	},
	postgresql: {
		labelKey: 'settings.database.connHelp.postgresql.label',
		placeholder: 'postgresql://user:password@host:5432/database',
		format: 'postgresql://<user>:<password>@<host>:<port>/<database>',
		instructionKeys: [
			'settings.database.connHelp.postgresql.instructions.0',
			'settings.database.connHelp.postgresql.instructions.1',
			'settings.database.connHelp.postgresql.instructions.2',
		],
	},
	mysql: {
		labelKey: 'settings.database.connHelp.mysql.label',
		placeholder: 'mysql://user:password@host:3306/database',
		format: 'mysql://<user>:<password>@<host>:<port>/<database>',
		instructionKeys: [
			'settings.database.connHelp.mysql.instructions.0',
			'settings.database.connHelp.mysql.instructions.1',
			'settings.database.connHelp.mysql.instructions.2',
		],
	},
	supabase: {
		labelKey: 'settings.database.connHelp.supabase.label',
		placeholder:
			'postgresql://postgres.[ref]:[password]@aws-0-[region].pooler.supabase.com:6543/postgres',
		format:
			'postgresql://postgres.[ref]:[password]@aws-0-[region].pooler.supabase.com:6543/postgres',
		instructionKeys: [
			'settings.database.connHelp.supabase.instructions.0',
			'settings.database.connHelp.supabase.instructions.1',
			'settings.database.connHelp.supabase.instructions.2',
			'settings.database.connHelp.supabase.instructions.3',
		],
	},
	cockroachdb: {
		labelKey: 'settings.database.connHelp.cockroachdb.label',
		placeholder:
			'postgresql://user:password@cluster.cockroachlabs.cloud:26257/database?sslmode=verify-full',
		format:
			'postgresql://<user>:<password>@<cluster>.cockroachlabs.cloud:26257/<database>?sslmode=verify-full',
		instructionKeys: [
			'settings.database.connHelp.cockroachdb.instructions.0',
			'settings.database.connHelp.cockroachdb.instructions.1',
			'settings.database.connHelp.cockroachdb.instructions.2',
			'settings.database.connHelp.cockroachdb.instructions.3',
		],
	},
	firebase: {
		labelKey: 'settings.database.connHelp.firebase.label',
		placeholder: '{\n  "type": "service_account",\n  "project_id": "your-project",\n  ...\n}',
		format: 'JSON object with type, project_id, private_key, client_email, etc.',
		instructionKeys: [
			'settings.database.connHelp.firebase.instructions.0',
			'settings.database.connHelp.firebase.instructions.1',
			'settings.database.connHelp.firebase.instructions.2',
			'settings.database.connHelp.firebase.instructions.3',
		],
	},
	neon: {
		labelKey: 'settings.database.connHelp.neon.label',
		placeholder:
			'postgresql://user:password@ep-cool-name-123456.us-east-2.aws.neon.tech/neondb?sslmode=require',
		format: 'postgresql://<user>:<password>@<endpoint>.aws.neon.tech/<database>?sslmode=require',
		instructionKeys: [
			'settings.database.connHelp.neon.instructions.0',
			'settings.database.connHelp.neon.instructions.1',
			'settings.database.connHelp.neon.instructions.2',
			'settings.database.connHelp.neon.instructions.3',
		],
	},
	'vercel-postgres': {
		labelKey: 'settings.database.connHelp.vercelPostgres.label',
		placeholder:
			'postgres://default:xxxxx@ep-xxx-pooler.us-east-1.aws.neon.tech/verceldb?sslmode=require',
		format: 'postgres://default:<password>@<host>/verceldb?sslmode=require',
		instructionKeys: [
			'settings.database.connHelp.vercelPostgres.instructions.0',
			'settings.database.connHelp.vercelPostgres.instructions.1',
			'settings.database.connHelp.vercelPostgres.instructions.2',
			'settings.database.connHelp.vercelPostgres.instructions.3',
		],
	},
}

const STORAGE_KEY = 'innolope:db-wizard'

/** Mask the password portion of a connection string, keeping everything else visible */
function maskConnectionString(str: string): string {
	if (!str) return ''
	if (str.trim().startsWith('{')) {
		return str.replace(
			/"private_key"\s*:\s*"[^"]*"/,
			'"private_key": "\u2022\u2022\u2022\u2022\u2022\u2022"',
		)
	}
	return str.replace(/:\/\/([^:]+):([^@]+)@/, '://$1:\u2022\u2022\u2022\u2022@')
}

function updateUrlStep(stepName: string | null) {
	const url = new URL(window.location.href)
	if (stepName) url.searchParams.set('db-step', stepName)
	else url.searchParams.delete('db-step')
	window.history.replaceState({}, '', url.toString())
}

function saveWizardState(data: { dbType: string; connectionString: string; selectedDb: string }) {
	try {
		sessionStorage.setItem(STORAGE_KEY, JSON.stringify(data))
	} catch {}
}

function loadWizardState(): {
	dbType: string
	connectionString: string
	selectedDb: string
} | null {
	try {
		const raw = sessionStorage.getItem(STORAGE_KEY)
		return raw ? JSON.parse(raw) : null
	} catch {
		return null
	}
}

function clearWizardState() {
	try {
		sessionStorage.removeItem(STORAGE_KEY)
	} catch {}
}

function BackLink({ onClick, children }: { onClick: () => void; children: React.ReactNode }) {
	return (
		<button
			type="button"
			onClick={onClick}
			className="flex items-center gap-1.5 text-sm text-text-secondary hover:text-text transition-colors"
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
			{children}
		</button>
	)
}

function StepIndicator({ steps, current }: { steps: string[]; current: number }) {
	return (
		<div className="flex items-center justify-center gap-1.5 mb-10">
			{steps.map((label, i) => (
				<div key={label} className="flex items-center gap-1.5">
					<div
						className={`flex items-center gap-1.5 text-xs font-medium transition-colors ${
							i < current ? 'text-accent' : i === current ? 'text-text' : 'text-text-muted'
						}`}
					>
						<div
							className={`w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-semibold transition-colors ${
								i < current
									? 'bg-accent text-btn-primary-text'
									: i === current
										? 'bg-text text-surface'
										: 'bg-surface-alt text-text-muted'
							}`}
						>
							{i < current ? (
								<svg
									width="10"
									height="10"
									viewBox="0 0 24 24"
									fill="none"
									stroke="currentColor"
									strokeWidth="3"
									strokeLinecap="round"
									strokeLinejoin="round"
								>
									<polyline points="20 6 9 17 4 12" />
								</svg>
							) : (
								i + 1
							)}
						</div>
						{label}
					</div>
					{i < steps.length - 1 && (
						<div
							className={`w-6 h-px transition-colors ${i < current ? 'bg-accent' : 'bg-border'}`}
						/>
					)}
				</div>
			))}
		</div>
	)
}

interface DatabaseSettingsProps {
	/** When provided, the step-1 "Change database" back link is hidden (parent handles it) */
	onChangeDatabase?: () => void
}

export function DatabaseSettings({ onChangeDatabase }: DatabaseSettingsProps = {}) {
	const { t } = useTranslation()
	const { currentProject, refreshProjects } = useAuth()
	const { refreshCollections } = useCollections()
	const navigate = useNavigate()
	const _license = useLicense()
	const toast = useToast()

	const needsDbSelectFor = (type: string) => type === 'mongodb' || type === 'firebase'
	const isNoSqlType = (type: string) => type === 'mongodb' || type === 'firebase'

	// Restore state from URL + sessionStorage
	const [dbType, setDbType] = useState(() => {
		const saved = loadWizardState()
		return saved?.dbType || 'built-in'
	})
	const [connectionString, setConnectionString] = useState(() => {
		const saved = loadWizardState()
		return saved?.connectionString || ''
	})
	const [selectedDb, setSelectedDb] = useState(() => {
		const saved = loadWizardState()
		return saved?.selectedDb || ''
	})
	const [step, setStepLocal] = useState(() => {
		const params = new URLSearchParams(window.location.search)
		const s = params.get('db-step')
		const saved = loadWizardState()
		const type = saved?.dbType || 'built-in'
		if (s === 'tables') return needsDbSelectFor(type) ? 3 : 2
		if (s === 'select-db') return 2
		if (s === 'connection') return 1
		return 0
	})

	const [testing, setTesting] = useState(false)
	const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null)
	const [scanning, setScanning] = useState(false)
	const [databases, setDatabases] = useState<string[]>([])
	const [tables, setTables] = useState<DetectedTable[]>([])
	const [selectedTables, setSelectedTables] = useState<Set<string>>(new Set())
	const [saving, setSaving] = useState(false)
	const [saved, setSaved] = useState(false)
	const [resyncing, setResyncing] = useState(false)
	const [resyncPhase, setResyncPhase] = useState<
		'scanning' | 'importing' | 'finishing' | 'done' | null
	>(null)
	const [resyncResult, setResyncResult] = useState<{ count: number } | null>(null)
	// Tables returned by the re-sync scan, awaiting the user's collection selection.
	const [resyncTables, setResyncTables] = useState<DetectedTable[] | null>(null)
	const [resyncSelected, setResyncSelected] = useState<Set<string>>(new Set())
	const [tableSort, setTableSort] = useState<'name' | 'records'>('name')
	const [hideEmpty, setHideEmpty] = useState(false)
	const [accessMode, setAccessMode] = useState<'read-write' | 'read-only'>('read-write')
	const [mediaConfigs, setMediaConfigs] = useState<Record<string, MediaStorageConfig>>({})
	const [mediaProbes, setMediaProbes] = useState<Record<string, ProbeState>>({})
	const initialDbType = useRef('built-in')
	const debounceRef = useRef<ReturnType<typeof setTimeout>>(undefined)
	// Monotonic token: each auto-test bumps it; stale in-flight responses are discarded.
	const testSeqRef = useRef(0)

	useEffect(() => {
		if (currentProject) {
			const settings = (currentProject.settings as Record<string, unknown>) || {}
			const extDb = settings.externalDb as Record<string, unknown> | undefined
			if (extDb) {
				const t = (extDb.type as string) || 'built-in'
				setDbType(t)
				initialDbType.current = t
				setConnectionString('')
			}
		}
	}, [currentProject])

	// Persist wizard state on changes
	useEffect(() => {
		if (step > 0) {
			saveWizardState({ dbType, connectionString, selectedDb })
		}
	}, [dbType, connectionString, selectedDb, step])

	const dirty = dbType !== initialDbType.current
	const needsDbSelect = needsDbSelectFor(dbType)
	const isFirebase = dbType === 'firebase'
	const isNoSql = isNoSqlType(dbType)
	const help = CONNECTION_HELP[dbType]

	// Build step labels dynamically — use "Collections" for NoSQL, "Tables" for SQL
	const tableWord = isNoSql
		? t('settings.database.tableWord.collections')
		: t('settings.database.tableWord.tables')
	const stepLabels = [
		t('settings.database.steps.database'),
		t('settings.database.steps.connection'),
	]
	if (needsDbSelect) stepLabels.push(t('settings.database.steps.confirmDb'))
	stepLabels.push(tableWord)

	const tableStepIndex = needsDbSelect ? 3 : 2
	const mediaStepIndex = tableStepIndex + 1
	const selectedMediaTables = tables.filter(
		(tbl) => selectedTables.has(tbl.name) && isMediaTable(tbl),
	)
	const hasMediaStep = selectedMediaTables.length > 0
	if (hasMediaStep) stepLabels.push(t('settings.database.steps.mediaStorage'))

	const setStep = useCallback(
		(n: number) => {
			setStepLocal(n)
			const stepName =
				n === 0
					? null
					: n === 1
						? 'connection'
						: n === 2
							? needsDbSelect
								? 'select-db'
								: 'tables'
							: n === 3
								? 'tables'
								: null
			updateUrlStep(stepName)
		},
		[needsDbSelect],
	)

	const selectDbType = (value: string) => {
		setDbType(value)
		setTestResult(null)
		setDatabases([])
		setSelectedDb('')
		setTables([])
		setSelectedTables(new Set())
		setConnectionString('')
		if (value === 'built-in') {
			setStep(0)
			clearWizardState()
		} else {
			setStep(1)
		}
	}

	// Auto-test and auto-advance when connection string changes
	const testAndAdvance = useCallback(
		async (connStr: string) => {
			if (!currentProject || !connStr.trim()) return

			const seq = ++testSeqRef.current
			const isStale = () => testSeqRef.current !== seq

			setTesting(true)
			setTestResult(null)
			try {
				const result = await api.post<{ ok: boolean; message: string }>(
					`/api/v1/projects/${currentProject.id}/database/test`,
					{ type: dbType, connectionString: connStr },
				)
				if (isStale()) return
				setTestResult(result)
				if (result.ok) {
					if (needsDbSelect) {
						setScanning(true)
						try {
							const dbResult = await api.post<{ databases: string[] }>(
								`/api/v1/projects/${currentProject.id}/database/scan-databases`,
								{ type: dbType, connectionString: connStr },
							)
							if (isStale()) return
							setDatabases(dbResult.databases)
							if (dbResult.databases.length === 1) {
								setSelectedDb(dbResult.databases[0])
								setStep(3)
								setScanning(true)
								try {
									const tableResult = await api.post<{ tables: DetectedTable[] }>(
										`/api/v1/projects/${currentProject.id}/database/scan`,
										{ type: dbType, connectionString: connStr, database: dbResult.databases[0] },
									)
									if (isStale()) return
									if (isStale()) return
									setTables(tableResult.tables)
								} catch (err) {
									toast(
										err instanceof Error ? err.message : t('settings.database.scanFailed'),
										'error',
									)
								} finally {
									setScanning(false)
								}
							} else {
								setStep(2)
							}
						} catch (err) {
							toast(
								err instanceof Error ? err.message : t('settings.database.scanDatabasesFailed'),
								'error',
							)
						} finally {
							setScanning(false)
						}
					} else {
						setStep(2)
						setScanning(true)
						try {
							const tableResult = await api.post<{ tables: DetectedTable[] }>(
								`/api/v1/projects/${currentProject.id}/database/scan`,
								{ type: dbType, connectionString: connStr },
							)
							setTables(tableResult.tables)
						} catch (err) {
							toast(err instanceof Error ? err.message : t('settings.database.scanFailed'), 'error')
						} finally {
							setScanning(false)
						}
					}
				}
			} catch (err) {
				if (isStale()) return
				setTestResult({
					ok: false,
					message: err instanceof Error ? err.message : t('settings.database.connectionFailed'),
				})
			} finally {
				// Only the most recent attempt owns the testing flag.
				if (!isStale()) setTesting(false)
			}
		},
		[currentProject, dbType, needsDbSelect, toast, setStep, t],
	)

	// Debounced effect: auto-test 800ms after user stops typing
	useEffect(() => {
		if (step !== 1 || !connectionString.trim()) return
		clearTimeout(debounceRef.current)
		debounceRef.current = setTimeout(() => {
			testAndAdvance(connectionString)
		}, 800)
		return () => clearTimeout(debounceRef.current)
	}, [connectionString, step, testAndAdvance])

	const scanTablesFor = useCallback(
		async (db: string) => {
			if (!currentProject || !connectionString.trim()) return
			setScanning(true)
			try {
				const result = await api.post<{ tables: DetectedTable[] }>(
					`/api/v1/projects/${currentProject.id}/database/scan`,
					{ type: dbType, connectionString, database: db },
				)
				setTables(result.tables)
			} catch (err) {
				toast(err instanceof Error ? err.message : t('settings.database.scanFailed'), 'error')
			} finally {
				setScanning(false)
			}
		},
		[currentProject, connectionString, dbType, toast, t],
	)

	const selectDatabase = (db: string) => {
		setSelectedDb(db)
		setTables([])
		setStep(3)
		scanTablesFor(db)
	}

	const toggleTable = (name: string) => {
		const next = new Set(selectedTables)
		if (next.has(name)) {
			next.delete(name)
		} else {
			next.add(name)
			// Auto-include related collections so relation fields stay editable.
			const table = tables.find((t) => t.name === name)
			if (table) {
				for (const target of relationTargets(table, tables)) next.add(target)
			}
		}
		setSelectedTables(next)
	}

	const save = async () => {
		if (!currentProject) return
		setSaving(true)
		try {
			const selectedTableData = tables.filter((t) => selectedTables.has(t.name))

			// Build the per-table media storage map from the wizard's media step.
			const mediaStorage: Record<string, Record<string, unknown>> = {}
			for (const [name, cfg] of Object.entries(mediaConfigs)) {
				if (!cfg.enabled || !selectedTables.has(name) || !cfg.pathColumn) continue
				const access = cfg.access || 'public'
				const entry: Record<string, unknown> = {
					adapter: cfg.adapter,
					pathColumn: cfg.pathColumn,
					access,
				}
				if (access === 'public') {
					if (cfg.adapter !== 'absolute' && cfg.baseUrl.trim()) entry.baseUrl = cfg.baseUrl.trim()
				} else {
					const c = cfg.credentials || emptyCreds()
					const filled = Object.fromEntries(Object.entries(c).filter(([, v]) => v.trim()))
					if (Object.keys(filled).length > 0) entry.credentials = filled
				}
				mediaStorage[name] = entry
			}

			const result = await api.put<{
				project: unknown
				collections: Array<{ name: string }>
				warnings?: string[]
			}>(`/api/v1/projects/${currentProject.id}/database`, {
				type: dbType === 'built-in' ? null : dbType,
				connectionString: dbType === 'built-in' ? null : connectionString,
				database: selectedDb || null,
				tables: selectedTableData,
				// Every table here was explicitly ticked, so all of them should show.
				visibleTables: selectedTableData.map((t) => t.name),
				accessMode,
				mediaStorage: Object.keys(mediaStorage).length > 0 ? mediaStorage : undefined,
			})

			clearWizardState()
			await refreshProjects()
			await refreshCollections()

			if (result.warnings?.length) {
				for (const w of result.warnings) toast(w, 'error')
			}

			// Redirect to first created collection
			if (result.collections?.length > 0) {
				const sorted = [...result.collections].sort((a, b) => a.name.localeCompare(b.name))
				navigate({ to: `/collections/${sorted[0].name}` })
			} else {
				setSaved(true)
				setTimeout(() => setSaved(false), 2000)
			}
		} catch (err) {
			toast(err instanceof Error ? err.message : t('settings.database.saveFailed'), 'error')
		} finally {
			setSaving(false)
		}
	}

	// From the tables step: go to the media-storage step when a media library is
	// detected among the selection, otherwise save directly.
	const proceedFromTables = () => {
		if (!hasMediaStep) {
			save()
			return
		}
		const next = { ...mediaConfigs }
		const freshlyAdded: string[] = []
		for (const t of tables.filter((tt) => selectedTables.has(tt.name))) {
			if (!next[t.name]) {
				next[t.name] = {
					enabled: isMediaTable(t),
					adapter: 'custom-url',
					pathColumn: pickPathColumn(t),
					baseUrl: '',
					access: 'public',
					credentials: emptyCreds(),
					hasCredentials: false,
				}
				freshlyAdded.push(t.name)
			}
		}
		setMediaConfigs(next)
		setStep(mediaStepIndex)
		// Auto-probe each detected library live from the external DB — no button click.
		for (const tname of freshlyAdded) {
			if (next[tname].enabled) probeMedia(tname, next[tname])
		}
	}

	const updateMediaConfig = (name: string, patch: Partial<MediaStorageConfig>) => {
		setMediaConfigs((prev) => {
			const current: MediaStorageConfig = prev[name] || {
				enabled: false,
				adapter: 'absolute',
				pathColumn: '',
				baseUrl: '',
				access: 'public',
				credentials: emptyCreds(),
				hasCredentials: false,
			}
			return { ...prev, [name]: { ...current, ...patch } }
		})
	}

	const updateMediaCreds = (name: string, patch: Partial<MediaCreds>) => {
		setMediaConfigs((prev) => {
			const cur = prev[name]
			if (!cur) return prev
			return {
				...prev,
				[name]: { ...cur, credentials: { ...(cur.credentials || emptyCreds()), ...patch } },
			}
		})
	}

	// Probe a media library live from the external DB during the wizard (before import).
	const probeMedia = async (tableName: string, cfgOverride?: MediaStorageConfig) => {
		if (!currentProject) return
		const cfg = cfgOverride || mediaConfigs[tableName]
		if (!cfg) return
		setMediaProbes((p) => ({ ...p, [tableName]: { loading: true } }))
		try {
			const res = await api.post<{ result: string; detail?: string; provider?: string }>(
				`/api/v1/projects/${currentProject.id}/database/media-probe`,
				{
					table: tableName,
					type: dbType,
					connectionString: connectionString || undefined,
					database: selectedDb || undefined,
					pathColumn: cfg.pathColumn,
					baseUrl: cfg.baseUrl.trim() || undefined,
				},
			)
			setMediaProbes((p) => ({
				...p,
				[tableName]: { result: res.result, detail: res.detail, provider: res.provider },
			}))
			if (res.result === 'public')
				updateMediaConfig(tableName, { access: 'public', adapter: 'custom-url' })
			else if (res.result === 'private')
				updateMediaConfig(tableName, {
					access: 'private',
					adapter: res.provider === 'cloudflare-images' ? 'cloudflare-images' : 'r2',
				})
		} catch (err) {
			setMediaProbes((p) => ({
				...p,
				[tableName]: {
					result: 'error',
					detail: err instanceof Error ? err.message : t('settings.database.probeFailed'),
				},
			}))
		}
	}

	// External-DB config saved on the project (the connection string never round-trips
	// to the client, so re-sync reuses the server-stored one).
	const externalDbSettings = () =>
		(currentProject?.settings as Record<string, unknown> | undefined)?.externalDb as
			| Record<string, unknown>
			| undefined

	// Re-sync step 1: re-scan the connected database and show its tables so the user
	// can choose which collections to display.
	const startResync = async () => {
		const ext = externalDbSettings()
		if (!currentProject || !ext?.type) return
		setResyncing(true)
		setResyncResult(null)
		setResyncTables(null)
		setResyncPhase('scanning')
		try {
			const scan = await api.post<{ tables: DetectedTable[] }>(
				`/api/v1/projects/${currentProject.id}/database/scan`,
				{ type: ext.type, database: ext.database || undefined },
			)
			const scanned = new Set(scan.tables.map((t) => t.name))
			// Pre-select the collections already imported (that still exist in the database).
			const imported = ((ext.tables as string[]) || []).filter((n) => scanned.has(n))
			setResyncSelected(new Set(imported))
			setResyncTables(scan.tables)
			setResyncPhase(null)
		} catch (err) {
			setResyncPhase(null)
			toast(err instanceof Error ? err.message : t('settings.database.resyncFailed'), 'error')
		} finally {
			setResyncing(false)
		}
	}

	const toggleResyncTable = (name: string) => {
		setResyncSelected((prev) => {
			const next = new Set(prev)
			if (next.has(name)) next.delete(name)
			else next.add(name)
			return next
		})
	}

	// Re-sync step 2: import the chosen collections and refresh their field schema
	// (picks up new date/relation typing). Related tables are pulled in automatically.
	const confirmResync = async () => {
		const ext = externalDbSettings()
		if (!currentProject || !ext?.type || !resyncTables) return
		const toImport = new Set(resyncSelected)
		// Include related collections so relation fields stay editable.
		for (const tbl of resyncTables) {
			if (resyncSelected.has(tbl.name)) {
				for (const target of relationTargets(tbl, resyncTables)) toImport.add(target)
			}
		}
		const tablesToSave = resyncTables.filter((tbl) => toImport.has(tbl.name))
		if (tablesToSave.length === 0) {
			toast(t('settings.database.selectAtLeastOne'), 'error')
			return
		}
		setResyncing(true)
		setResyncPhase('importing')
		try {
			const result = await api.put<{ collections: Array<{ name: string }>; warnings?: string[] }>(
				`/api/v1/projects/${currentProject.id}/database`,
				{
					type: ext.type,
					// null = reuse the connection string already stored on the project
					// (it is never sent back to the client, so we cannot resend it here).
					connectionString: null,
					database: ext.database || null,
					tables: tablesToSave,
					// Only the tables the user actually ticked become sidebar-visible; the
					// relation targets auto-added above stay hidden on `auto`.
					visibleTables: tablesToSave.filter((t) => resyncSelected.has(t.name)).map((t) => t.name),
					accessMode: ext.accessMode || 'read-write',
				},
			)
			setResyncPhase('finishing')
			await refreshProjects()
			await refreshCollections()
			if (result.warnings?.length) {
				for (const w of result.warnings) toast(w, 'error')
			}
			setResyncResult({ count: tablesToSave.length })
			setResyncTables(null)
			setResyncPhase('done')
		} catch (err) {
			setResyncPhase(null)
			toast(err instanceof Error ? err.message : t('settings.database.resyncFailed'), 'error')
		} finally {
			setResyncing(false)
		}
	}

	const goBack = () => {
		if (step === mediaStepIndex) {
			setStep(tableStepIndex)
		} else if (step === 1) {
			setStep(0)
			setConnectionString('')
			setTestResult(null)
			clearWizardState()
		} else if (step === 2) {
			if (needsDbSelect) {
				setStep(1)
				setTestResult(null)
				setDatabases([])
			} else {
				setStep(1)
				setTestResult(null)
				setTables([])
			}
		} else if (step === 3) {
			// If only 1 database was found, skip back to connection (step 1) since step 2 was auto-skipped
			if (databases.length <= 1) {
				setStep(1)
				setTestResult(null)
				setDatabases([])
				setSelectedDb('')
			} else {
				setStep(2)
			}
			setTables([])
		}
	}

	const selectedOption = DB_OPTIONS.find((o) => o.value === dbType) ?? DB_OPTIONS[0]

	// ─── Step 0: Select database type ─────────────────────────────────────
	if (step === 0) {
		const hasExternalDb = initialDbType.current !== 'built-in'
		const connectedOption = hasExternalDb
			? DB_OPTIONS.find((o) => o.value === initialDbType.current)
			: null

		return (
			<div className="space-y-4">
				{/* Connected database info */}
				{connectedOption && (
					<div className="flex items-center gap-3 px-4 py-3 rounded-lg bg-surface-alt border border-border">
						<svg
							width="16"
							height="16"
							viewBox="0 0 24 24"
							fill="none"
							stroke="currentColor"
							strokeWidth="2"
							strokeLinecap="round"
							strokeLinejoin="round"
							className="text-accent shrink-0"
						>
							<polyline points="20 6 9 17 4 12" />
						</svg>
						<div className="flex-1 min-w-0">
							<p className="text-sm text-text">
								{t('settings.database.connectedTo')}{' '}
								<span className="font-medium">{connectedOption.label}</span>
							</p>
							<p className="text-xs text-text-muted font-mono truncate">
								{connectionString
									? maskConnectionString(connectionString)
									: t('settings.database.connectionSavedSecurely')}
							</p>
						</div>
						<img src={connectedOption.logo} alt="" className="w-5 h-5 shrink-0 opacity-60" />
					</div>
				)}

				{connectedOption && (
					<div className="px-4 py-3 rounded-lg border border-border">
						<div className="flex items-center justify-between gap-3">
							<div className="min-w-0">
								<p className="text-sm text-text font-medium">
									{t('settings.database.resyncTitle')}
								</p>
								<p className="text-xs text-text-muted mt-0.5">
									{t('settings.database.resyncDesc')}
								</p>
							</div>
							<button
								type="button"
								onClick={startResync}
								disabled={resyncing}
								className="shrink-0 px-3 py-2 bg-btn-secondary text-text rounded text-sm font-medium hover:bg-btn-secondary-hover disabled:opacity-50"
							>
								{resyncing ? t('settings.database.resyncing') : t('settings.database.resync')}
							</button>
						</div>

						{resyncPhase && (
							<div className="mt-3 pt-3 border-t border-border animate-[slideIn_0.2s_ease-out]">
								{resyncPhase === 'done' ? (
									<div className="flex items-center gap-2 text-sm text-accent">
										<svg
											width="16"
											height="16"
											viewBox="0 0 24 24"
											fill="none"
											stroke="currentColor"
											strokeWidth="2.5"
											strokeLinecap="round"
											strokeLinejoin="round"
											className="shrink-0"
										>
											<polyline points="20 6 9 17 4 12" />
										</svg>
										<span className="font-medium">
											{t('settings.database.resyncComplete', {
												count: resyncResult?.count ?? 0,
											})}
										</span>
									</div>
								) : (
									<>
										<div className="flex items-center justify-between mb-2">
											<span className="text-xs font-medium text-text-secondary">
												{resyncPhase === 'scanning'
													? t('settings.database.resyncPhase.scanning')
													: resyncPhase === 'importing'
														? t('settings.database.resyncPhase.importing')
														: t('settings.database.resyncPhase.refreshing')}
											</span>
											<span className="text-xs text-text-muted">
												{t('settings.database.stepOfTotal', {
													current:
														resyncPhase === 'scanning' ? 1 : resyncPhase === 'importing' ? 2 : 3,
													total: 3,
												})}
											</span>
										</div>
										<div className="h-1.5 w-full rounded-full bg-surface-alt overflow-hidden">
											<div
												className="h-full rounded-full bg-accent transition-[width] duration-500 ease-out"
												style={{
													width:
														resyncPhase === 'scanning'
															? '25%'
															: resyncPhase === 'importing'
																? '65%'
																: '88%',
												}}
											/>
										</div>
									</>
								)}
							</div>
						)}

						{resyncTables && !resyncPhase && (
							<div className="mt-3 pt-3 border-t border-border">
								<p className="text-xs font-medium text-text-secondary mb-2">
									{t('settings.database.selectCollectionsToDisplay')}
								</p>
								{resyncTables.length === 0 ? (
									<p className="text-xs text-text-muted py-2">
										{t('settings.database.noCollectionsFound')}
									</p>
								) : (
									<div className="max-h-64 overflow-auto">
										{[...resyncTables]
											.sort((a, b) => a.name.localeCompare(b.name))
											.map((tbl) => (
												<label
													key={tbl.name}
													className="flex items-center gap-2 px-1 py-1.5 rounded hover:bg-surface-alt cursor-pointer"
												>
													<input
														type="checkbox"
														checked={resyncSelected.has(tbl.name)}
														onChange={() => toggleResyncTable(tbl.name)}
														className="rounded"
													/>
													<span className="text-sm text-text flex-1 min-w-0">
														{tbl.name}
														{relationTargets(tbl, resyncTables).map((target) => (
															<span
																key={target}
																title={t('settings.database.referencesAuto', { target })}
																className="ml-1.5 px-1.5 py-0.5 text-[10px] rounded bg-surface-alt text-text-muted"
															>
																&rarr; {target}
															</span>
														))}
													</span>
													<span className="text-xs text-text-muted shrink-0">
														{tbl.count ?? '—'}{' '}
														{t('settings.database.recordsCount', { count: tbl.count ?? 0 })}
													</span>
												</label>
											))}
									</div>
								)}
								<div className="mt-3 flex items-center gap-2">
									<button
										type="button"
										onClick={confirmResync}
										disabled={resyncing || resyncSelected.size === 0}
										className="px-3 py-1.5 bg-btn-primary text-btn-primary-text rounded text-sm font-medium hover:bg-btn-primary-hover disabled:opacity-50"
									>
										{t('settings.database.importCollections', { count: resyncSelected.size })}
									</button>
									<button
										type="button"
										onClick={() => setResyncTables(null)}
										className="text-sm text-text-secondary hover:text-text"
									>
										{t('common.cancel')}
									</button>
								</div>
							</div>
						)}
					</div>
				)}

				{connectedOption && <ImportedMediaStorage />}

				<CollapsibleCard
					title={
						hasExternalDb
							? t('settings.database.changeDbSource')
							: t('settings.database.selectDbSource')
					}
					defaultOpen={!!onChangeDatabase}
					borderless={!!onChangeDatabase}
				>
					<div className="grid grid-cols-3 gap-3">
						{DB_OPTIONS.map((opt) => (
							<button
								key={opt.value}
								type="button"
								onClick={() => selectDbType(opt.value)}
								className={`p-5 rounded-lg border text-left transition-colors relative ${
									dbType === opt.value
										? 'border-accent bg-accent-soft'
										: 'border-border hover:border-border-strong'
								}`}
							>
								<div
									className={`absolute top-4 right-4 w-[18px] h-[18px] rounded-full border-2 flex items-center justify-center ${
										dbType === opt.value ? 'border-accent' : 'border-border-strong'
									}`}
								>
									{dbType === opt.value && <div className="w-2.5 h-2.5 rounded-full bg-accent" />}
								</div>
								<img src={opt.logo} alt="" className="w-6 h-6 mb-2" />
								<p className={`font-medium ${dbType === opt.value ? 'text-accent' : 'text-text'}`}>
									{opt.label}
								</p>
								<p className="text-xs text-text-muted mt-1">{t(opt.descKey)}</p>
							</button>
						))}
					</div>
				</CollapsibleCard>

				{dbType === 'built-in' && (
					<p className="text-xs text-text-muted">{t('settings.database.builtInDesc')}</p>
				)}

				{/* Only show save when switching back to built-in (disconnecting external DB) */}
				{dbType === 'built-in' && dirty && (
					<SaveBar
						dirty={dirty}
						saving={saving}
						saved={saved}
						onSave={save}
						saveLabel={t('settings.database.switchToBuiltIn')}
					/>
				)}
			</div>
		)
	}

	// ─── Step 1: Connection string ────────────────────────────────────────
	if (step === 1 && help) {
		const masked = maskConnectionString(connectionString)

		return (
			<div>
				<div className="-mt-2 -ml-1 mb-6">
					<BackLink onClick={goBack}>{t('settings.database.changeProvider')}</BackLink>
				</div>
				<div className="space-y-5">
					<StepIndicator steps={stepLabels} current={1} />

					<div className="flex items-center gap-3 mb-8">
						<img src={selectedOption.logo} alt="" className="w-8 h-8" />
						<div>
							<p className="font-medium text-text">{selectedOption.label}</p>
							<p className="text-xs text-text-muted">{t(selectedOption.descKey)}</p>
						</div>
					</div>

					{/* Input */}
					<div>
						<label
							htmlFor="db-connection-string"
							className="block text-xs text-text-secondary mb-1.5"
						>
							{t(help.labelKey)}
						</label>
						{isFirebase ? (
							<textarea
								id="db-connection-string"
								value={connectionString}
								onChange={(e) => {
									setConnectionString(e.target.value)
									setTestResult(null)
								}}
								placeholder={help.placeholder}
								rows={6}
								className="w-full px-3 py-2 bg-input border border-border-strong rounded text-sm text-text font-mono focus:outline-none focus:border-border-strong resize-y"
							/>
						) : (
							<input
								id="db-connection-string"
								type="password"
								value={connectionString}
								onChange={(e) => {
									setConnectionString(e.target.value)
									setTestResult(null)
								}}
								placeholder={help.placeholder}
								className="w-full px-3 py-2 bg-input border border-border-strong rounded text-sm text-text font-mono focus:outline-none focus:border-border-strong"
							/>
						)}
						{connectionString && !isFirebase && (
							<p className="mt-1.5 text-[11px] text-text-muted font-mono break-all">{masked}</p>
						)}
					</div>

					{/* Instructions */}
					<div className="bg-surface-alt rounded-lg p-4 space-y-2">
						<p className="text-xs font-medium text-text-secondary">
							{t('settings.database.howToFind')}
						</p>
						<ol className="space-y-1.5">
							{help.instructionKeys.map((key, i) => (
								<li key={key} className="flex gap-2 text-sm text-text-muted">
									<span className="text-text-secondary font-medium shrink-0">{i + 1}.</span>
									{t(key)}
								</li>
							))}
						</ol>
						<div className="mt-2 pt-2 border-t border-border">
							<p className="text-[11px] text-text-muted font-mono break-all">
								{t('settings.database.formatLabel')}: {help.format}
							</p>
						</div>
					</div>

					{/* Status indicator */}
					{testing && (
						<div className="flex items-center gap-2 text-sm text-text-muted">
							<div className="w-3.5 h-3.5 border-2 border-accent border-t-transparent rounded-full animate-spin" />
							{t('settings.database.testingConnection')}
						</div>
					)}

					{scanning && (
						<div className="flex items-center gap-2 text-sm text-text-muted">
							<div className="w-3.5 h-3.5 border-2 border-accent border-t-transparent rounded-full animate-spin" />
							{t('settings.database.scanning')}
						</div>
					)}

					{testResult && !testResult.ok && !testing && (
						<div className="flex items-center gap-2 text-sm px-3 py-2.5 rounded-lg bg-danger-surface text-danger">
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
								<line x1="15" y1="9" x2="9" y2="15" />
								<line x1="9" y1="9" x2="15" y2="15" />
							</svg>
							{testResult.message}
						</div>
					)}
				</div>
			</div>
		)
	}

	// ─── Step 2: Select database (MongoDB / Firebase only) ────────────────
	if (step === 2 && needsDbSelect) {
		return (
			<div>
				<div className="-mt-2 -ml-1 mb-6">
					<BackLink onClick={goBack}>{t('settings.database.editConnectionString')}</BackLink>
				</div>
				<div className="space-y-5">
					<StepIndicator steps={stepLabels} current={2} />

					<div>
						<div className="block text-xs text-text-secondary mb-2">
							{t('settings.database.selectADatabase')}
						</div>
						<p className="text-sm text-text-muted mb-3">
							{t('settings.database.foundDatabases', { count: databases.length })}
						</p>
						<div className="grid grid-cols-3 gap-3">
							{databases.map((db) => (
								<button
									key={db}
									type="button"
									onClick={() => selectDatabase(db)}
									className="p-5 rounded-lg border border-border hover:border-border-strong text-left transition-colors relative"
								>
									<div className="absolute top-4 right-4 w-[18px] h-[18px] rounded-full border-2 border-border-strong flex items-center justify-center" />
									<svg
										width="20"
										height="20"
										viewBox="0 0 24 24"
										fill="none"
										stroke="currentColor"
										strokeWidth="1.5"
										strokeLinecap="round"
										strokeLinejoin="round"
										className="text-text-muted mb-3"
									>
										<ellipse cx="12" cy="5" rx="9" ry="3" />
										<path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3" />
										<path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5" />
									</svg>
									<p className="font-medium text-text">{db}</p>
								</button>
							))}
						</div>
					</div>
				</div>
			</div>
		)
	}

	// ─── Tables / Collections step ────────────────────────────────────────
	if (step === tableStepIndex) {
		return (
			<div>
				<div className="-mt-2 -ml-1 mb-6">
					<BackLink onClick={goBack}>
						{needsDbSelect
							? t('settings.database.chooseDifferentDatabase')
							: t('settings.database.editConnectionString')}
					</BackLink>
				</div>
				<div className="space-y-5">
					<StepIndicator steps={stepLabels} current={tableStepIndex} />

					<div className="text-center space-y-1">
						<div className="flex items-center justify-center gap-2">
							<svg
								width="16"
								height="16"
								viewBox="0 0 24 24"
								fill="none"
								stroke="currentColor"
								strokeWidth="2"
								strokeLinecap="round"
								strokeLinejoin="round"
								className="text-accent"
							>
								<polyline points="20 6 9 17 4 12" />
							</svg>
							<span className="text-sm text-text-secondary">
								{t('settings.database.connectedTo')}{' '}
								<span className="font-medium text-text">{selectedOption.label}</span>
							</span>
							<button
								type="button"
								onClick={() => scanTablesFor(selectedDb || '')}
								disabled={scanning}
								title={t('settings.database.refreshCollections')}
								className="text-text-muted hover:text-text transition-colors disabled:opacity-40"
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
									className={scanning ? 'animate-spin' : ''}
								>
									<polyline points="23 4 23 10 17 10" />
									<path d="M20.49 15a9 9 0 11-2.12-9.36L23 10" />
								</svg>
							</button>
						</div>
						{selectedDb && (
							<p className="text-sm text-text-muted">
								{t('settings.database.databaseFound')}{' '}
								<span className="font-medium text-text">{selectedDb}</span>
							</p>
						)}
					</div>

					{scanning ? (
						<div className="flex items-center gap-3 py-8 justify-center">
							<div className="w-4 h-4 border-2 border-accent border-t-transparent rounded-full animate-spin" />
							<span className="text-sm text-text-muted">
								{isNoSql
									? t('settings.database.scanningCollections')
									: t('settings.database.scanningTables')}
							</span>
						</div>
					) : tables.length > 0 ? (
						<div>
							<div className="flex items-center justify-between mb-3">
								<div className="text-xs text-text-secondary">
									{isNoSql
										? t('settings.database.detectedCollectionsLabel')
										: t('settings.database.detectedTablesLabel')}
								</div>
							</div>
							<div className="flex items-center gap-4 mb-3">
								<div className="flex items-center gap-2 text-xs text-text-secondary">
									<span>{t('settings.database.sort')}:</span>
									<button
										type="button"
										onClick={() => setTableSort('name')}
										className={`px-2 py-0.5 rounded ${tableSort === 'name' ? 'bg-surface-alt text-text font-medium' : 'hover:text-text'}`}
									>
										{t('settings.database.sortAZ')}
									</button>
									<button
										type="button"
										onClick={() => setTableSort('records')}
										className={`px-2 py-0.5 rounded ${tableSort === 'records' ? 'bg-surface-alt text-text font-medium' : 'hover:text-text'}`}
									>
										{t('settings.database.sortRecords')}
									</button>
								</div>
								<label className="flex items-center gap-1.5 text-xs text-text-secondary cursor-pointer">
									<input
										type="checkbox"
										checked={hideEmpty}
										onChange={(e) => setHideEmpty(e.target.checked)}
										className="rounded"
									/>
									{t('settings.database.hideEmpty')}
								</label>
							</div>
							<table className="w-full text-sm">
								<thead>
									<tr className="text-left text-xs text-text-muted border-b border-border">
										<th className="pb-2 pl-1 w-8" />
										<th className="pb-2">{t('settings.database.colName')}</th>
										<th className="pb-2 text-right">
											{isNoSql
												? t('settings.database.colFields')
												: t('settings.database.colColumns')}
										</th>
										<th className="pb-2 text-right">{t('settings.database.colRecords')}</th>
										<th className="pb-2 text-right pr-1">{t('settings.database.colSize')}</th>
									</tr>
								</thead>
								<tbody>
									{tables
										.filter((tbl) => !hideEmpty || (tbl.count ?? 0) > 0)
										.sort((a, b) =>
											tableSort === 'name'
												? a.name.localeCompare(b.name)
												: (b.count ?? 0) - (a.count ?? 0),
										)
										.map((tbl) => (
											<tr
												key={tbl.name}
												className="border-b border-border hover:bg-surface-alt transition-colors cursor-pointer"
												onClick={() => toggleTable(tbl.name)}
											>
												<td className="py-2 pl-1">
													<input
														type="checkbox"
														checked={selectedTables.has(tbl.name)}
														onChange={() => toggleTable(tbl.name)}
														className="rounded"
													/>
												</td>
												<td className="py-2 font-medium">
													{tbl.name}
													{relationTargets(tbl, tables).map((target) => (
														<span
															key={target}
															title={t('settings.database.referencesAutoImport', { target })}
															className="ml-1.5 px-1.5 py-0.5 text-[10px] rounded bg-surface-alt text-text-muted font-normal"
														>
															&rarr; {target}
														</span>
													))}
												</td>
												<td className="py-2 text-right text-text-muted">{tbl.columns.length}</td>
												<td className="py-2 text-right text-text-muted">{tbl.count ?? '—'}</td>
												<td className="py-2 text-right text-text-muted pr-1">
													{tbl.sizeBytes != null ? formatBytes(tbl.sizeBytes) : '—'}
												</td>
											</tr>
										))}
								</tbody>
							</table>
							{hideEmpty && tables.some((tbl) => (tbl.count ?? 0) === 0) && (
								<p className="text-xs text-text-muted mt-2">
									{isNoSql
										? t('settings.database.emptyHiddenCollections', {
												count: tables.filter((tbl) => (tbl.count ?? 0) === 0).length,
											})
										: t('settings.database.emptyHiddenTables', {
												count: tables.filter((tbl) => (tbl.count ?? 0) === 0).length,
											})}
								</p>
							)}
						</div>
					) : (
						<p className="text-sm text-text-muted py-4 text-center">
							{isNoSql
								? t('settings.database.noCollectionsInDb')
								: t('settings.database.noTablesInDb')}
						</p>
					)}

					{/* Size estimate — based on the collections you selected, not the whole database */}
					{selectedTables.size > 0 &&
						(() => {
							const selectedSizeBytes = tables
								.filter((tbl) => selectedTables.has(tbl.name))
								.reduce((sum, tbl) => sum + (tbl.sizeBytes ?? 0), 0)
							return (
								<p className="text-xs text-text-muted">
									{isNoSql
										? t('settings.database.selectedCollectionsSize', {
												size: formatBytes(selectedSizeBytes),
											})
										: t('settings.database.selectedTablesSize', {
												size: formatBytes(selectedSizeBytes),
											})}
									{selectedSizeBytes > 100 * 1024 * 1024 && (
										<span className="text-text-secondary">
											{' '}
											{t('settings.database.tooLargeToCache')}
										</span>
									)}
								</p>
							)
						})()}

					{/* Access mode */}
					{tables.length > 0 && (
						<div className="flex items-center gap-4 text-xs text-text-secondary">
							<span>{t('settings.database.accessMode')}:</span>
							<label className="flex items-center gap-1.5 cursor-pointer">
								<input
									type="radio"
									name="accessMode"
									checked={accessMode === 'read-write'}
									onChange={() => setAccessMode('read-write')}
								/>
								{t('settings.database.readWrite')}
							</label>
							<label className="flex items-center gap-1.5 cursor-pointer">
								<input
									type="radio"
									name="accessMode"
									checked={accessMode === 'read-only'}
									onChange={() => setAccessMode('read-only')}
								/>
								{t('settings.database.readOnly')}
							</label>
						</div>
					)}

					<SaveBar
						dirty={selectedTables.size > 0 || dirty}
						saving={saving}
						saved={saved}
						onSave={proceedFromTables}
						saveLabel={hasMediaStep ? t('settings.database.continue') : t('settings.database.save')}
					/>
				</div>
			</div>
		)
	}

	// ─── Media storage step ───────────────────────────────────────────────
	if (step === mediaStepIndex) {
		const selectedTableList = tables.filter((tbl) => selectedTables.has(tbl.name))
		return (
			<div>
				<div className="-mt-2 -ml-1 mb-6">
					<BackLink onClick={goBack}>
						{t('settings.database.backTo', { target: tableWord.toLowerCase() })}
					</BackLink>
				</div>
				<div className="space-y-5">
					<StepIndicator steps={stepLabels} current={mediaStepIndex} />

					<div className="text-center space-y-1">
						<h3 className="text-sm font-semibold text-text">
							{t('settings.database.mediaWhereTitle')}
						</h3>
						<p className="text-sm text-text-muted">
							{t('settings.database.mediaWhereDesc', {
								count: selectedMediaTables.length,
							})}
						</p>
					</div>

					<div className="space-y-3">
						{selectedTableList.map((tbl) => {
							const cfg = mediaConfigs[tbl.name] || {
								enabled: isMediaTable(tbl),
								adapter: 'absolute',
								pathColumn: pickPathColumn(tbl),
								baseUrl: '',
								access: 'public' as const,
								credentials: emptyCreds(),
								hasCredentials: false,
							}
							return (
								<MediaStorageCard
									key={tbl.name}
									name={tbl.name}
									label={tbl.name}
									columnNames={tbl.columns.map((c) => c.name)}
									detected={isMediaTable(tbl)}
									config={cfg}
									probeState={mediaProbes[tbl.name]}
									onChange={(patch) => updateMediaConfig(tbl.name, patch)}
									onChangeCreds={(patch) => updateMediaCreds(tbl.name, patch)}
									onProbe={() => probeMedia(tbl.name)}
								/>
							)
						})}
					</div>

					<SaveBar
						dirty={selectedTables.size > 0 || dirty}
						saving={saving}
						saved={saved}
						onSave={save}
						saveLabel={t('settings.database.save')}
					/>
				</div>
			</div>
		)
	}

	return null
}

interface ProbeState {
	loading?: boolean
	result?: string
	detail?: string
	/** Best-guess host detected from a sample URL (`r2`, `cloudflare-images`, …). */
	provider?: string
}

function CredField({
	label,
	value,
	onChange,
	password,
	saved,
}: {
	label: string
	value: string
	onChange: (v: string) => void
	password?: boolean
	saved?: boolean
}) {
	const { t } = useTranslation()
	return (
		<div>
			<div className="block text-[11px] text-text-secondary mb-1">{label}</div>
			<input
				type={password ? 'password' : 'text'}
				value={value}
				onChange={(e) => onChange(e.target.value)}
				placeholder={saved ? t('settings.database.credSavedPlaceholder') : ''}
				className="w-full max-w-sm px-3 py-1.5 bg-input border border-border-strong rounded text-sm text-text font-mono focus:outline-none focus:border-border-strong"
			/>
		</div>
	)
}

// Brand names stay verbatim; descriptions are i18n keys resolved at render.
const PROVIDER_OPTIONS = [
	{
		id: 'public',
		labelKey: 'settings.database.providers.public.label',
		descKey: 'settings.database.providers.public.desc',
	},
	{
		id: 'r2',
		labelKey: 'settings.database.providers.r2.label',
		descKey: 'settings.database.providers.r2.desc',
	},
	{
		id: 'cloudflare-images',
		labelKey: 'settings.database.providers.cloudflareImages.label',
		descKey: 'settings.database.providers.cloudflareImages.desc',
	},
]

function useProviderLabel() {
	const { t } = useTranslation()
	return (id: string): string => {
		const opt = PROVIDER_OPTIONS.find((p) => p.id === id)
		return opt ? t(opt.labelKey) : id
	}
}

const TONE_CLASS: Record<string, string> = {
	ok: 'text-accent',
	warn: 'text-text',
	muted: 'text-text-muted',
}

/** The plain-language conclusion from the auto-probe, shown above the provider choice. */
function probeConclusion(
	p: ProbeState | undefined,
	t: (key: string, opts?: Record<string, unknown>) => string,
	providerLabel: (id: string) => string,
): { tone: string; text: string } {
	if (!p || p.loading) {
		return { tone: 'muted', text: t('settings.database.probe.checking') }
	}
	if (p.result === 'public') {
		return {
			tone: 'ok',
			text: t('settings.database.probe.public'),
		}
	}
	if (p.result === 'private') {
		return {
			tone: 'warn',
			text: p.provider
				? t('settings.database.probe.privateWithProvider', {
						provider: providerLabel(p.provider),
					})
				: t('settings.database.probe.privateGeneric'),
		}
	}
	if (p.result === 'need-base-url') {
		return {
			tone: 'muted',
			text: t('settings.database.probe.needBaseUrl'),
		}
	}
	return {
		tone: 'muted',
		text: p.detail
			? t('settings.database.probe.errorWithDetail', { detail: p.detail })
			: t('settings.database.probe.errorGeneric'),
	}
}

/**
 * One imported media library's storage config. The parent auto-probes a sample of files
 * to conclude public vs. private; this card then asks only for what can't be detected —
 * which host and its credentials — via provider cards. Shared by the wizard and panel.
 */
function MediaStorageCard({
	name: _name,
	label,
	columnNames,
	detected,
	config,
	probeState,
	onChange,
	onChangeCreds,
	onProbe,
}: {
	name: string
	label: string
	columnNames: string[]
	detected?: boolean
	config: MediaStorageConfig
	probeState?: ProbeState
	onChange: (patch: Partial<MediaStorageConfig>) => void
	onChangeCreds: (patch: Partial<MediaCreds>) => void
	onProbe: () => void
}) {
	const { t } = useTranslation()
	const providerLabel = useProviderLabel()
	const [showColumnPicker, setShowColumnPicker] = useState(false)
	const creds = config.credentials || emptyCreds()
	const selectedProvider = config.access === 'private' ? config.adapter : 'public'
	const conclusion = probeConclusion(probeState, t, providerLabel)

	const selectProvider = (id: string) => {
		if (id === 'public') onChange({ access: 'public', adapter: 'custom-url' })
		else onChange({ access: 'private', adapter: id })
	}

	return (
		<div className="rounded-lg border border-border p-3">
			<label className="flex items-center gap-2.5 cursor-pointer">
				<input
					type="checkbox"
					checked={config.enabled}
					onChange={(e) => onChange({ enabled: e.target.checked })}
					className="rounded"
				/>
				<span className="text-sm font-medium text-text">{label}</span>
				{detected && (
					<span className="px-1.5 py-0.5 text-[10px] rounded bg-surface-alt text-text-muted">
						{t('settings.database.mediaLibraryBadge')}
					</span>
				)}
			</label>

			{config.enabled && (
				<div className="mt-3 pl-6 space-y-3">
					{/* Auto-probe conclusion */}
					<div className="flex items-start gap-2">
						{probeState?.loading && (
							<span className="mt-0.5 w-3.5 h-3.5 border-2 border-accent border-t-transparent rounded-full animate-spin shrink-0" />
						)}
						<p className={`text-xs ${TONE_CLASS[conclusion.tone]}`}>{conclusion.text}</p>
					</div>

					{/* Where are the files stored — provider cards */}
					<div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
						{PROVIDER_OPTIONS.map((opt) => {
							const active = selectedProvider === opt.id
							const suggested = probeState?.provider === opt.id
							return (
								<button
									key={opt.id}
									type="button"
									onClick={() => selectProvider(opt.id)}
									className={`p-3 rounded-lg border text-left transition-colors ${
										active
											? 'border-accent bg-accent-soft'
											: 'border-border hover:border-border-strong'
									}`}
								>
									<p className={`text-sm font-medium ${active ? 'text-accent' : 'text-text'}`}>
										{t(opt.labelKey)}
									</p>
									<p className="text-[11px] text-text-muted mt-0.5 leading-snug">
										{t(opt.descKey)}
									</p>
									{suggested && !active && (
										<p className="text-[10px] text-accent mt-1">
											{t('settings.database.suggested')}
										</p>
									)}
								</button>
							)
						})}
					</div>

					{/* Inputs for the chosen provider */}
					{selectedProvider === 'public' ? (
						<div>
							<div className="block text-xs text-text-secondary mb-1">
								{t('settings.database.baseUrl')}{' '}
								<span className="text-text-muted">{t('settings.database.optionalSuffix')}</span>
							</div>
							<input
								type="text"
								value={config.baseUrl}
								onChange={(e) => onChange({ baseUrl: e.target.value })}
								placeholder="https://cdn.example.com"
								className="w-full max-w-sm px-3 py-2 bg-input border border-border-strong rounded text-sm text-text font-mono focus:outline-none focus:border-border-strong"
							/>
							<p className="mt-1 text-[11px] text-text-muted">
								{t('settings.database.baseUrlHelp')}
							</p>
						</div>
					) : selectedProvider === 'cloudflare-images' ? (
						<div className="space-y-2.5">
							<CredField
								label={t('settings.database.creds.accountId')}
								value={creds.accountId}
								onChange={(v) => onChangeCreds({ accountId: v })}
								saved={config.hasCredentials}
							/>
							<CredField
								label={t('settings.database.creds.apiToken')}
								value={creds.apiToken}
								onChange={(v) => onChangeCreds({ apiToken: v })}
								password
								saved={config.hasCredentials}
							/>
							<CredField
								label={t('settings.database.creds.accountHash')}
								value={creds.accountHash}
								onChange={(v) => onChangeCreds({ accountHash: v })}
								saved={config.hasCredentials}
							/>
							<CredField
								label={t('settings.database.creds.signingKey')}
								value={creds.signingKey}
								onChange={(v) => onChangeCreds({ signingKey: v })}
								password
								saved={config.hasCredentials}
							/>
							<p className="text-[11px] text-text-muted">
								{t('settings.database.creds.serverSideNote')}
							</p>
						</div>
					) : (
						<div className="space-y-2.5">
							<CredField
								label={t('settings.database.creds.accountId')}
								value={creds.accountId}
								onChange={(v) => onChangeCreds({ accountId: v })}
								saved={config.hasCredentials}
							/>
							<CredField
								label={t('settings.database.creds.r2Bucket')}
								value={creds.bucket}
								onChange={(v) => onChangeCreds({ bucket: v })}
								saved={config.hasCredentials}
							/>
							<CredField
								label={t('settings.database.creds.accessKeyId')}
								value={creds.accessKeyId}
								onChange={(v) => onChangeCreds({ accessKeyId: v })}
								saved={config.hasCredentials}
							/>
							<CredField
								label={t('settings.database.creds.secretAccessKey')}
								value={creds.secretAccessKey}
								onChange={(v) => onChangeCreds({ secretAccessKey: v })}
								password
								saved={config.hasCredentials}
							/>
							<p className="text-[11px] text-text-muted">
								{t('settings.database.creds.serverSideNote')}
							</p>
						</div>
					)}

					{/* Secondary: which column holds the file path + re-check */}
					<div className="flex items-center gap-3 text-[11px] text-text-muted pt-1">
						<span>
							{t('settings.database.filePathsFrom')}{' '}
							<code className="text-text-secondary">{config.pathColumn || '—'}</code>
						</span>
						<button
							type="button"
							onClick={() => setShowColumnPicker((s) => !s)}
							className="text-accent hover:underline"
						>
							{showColumnPicker ? t('settings.database.done') : t('settings.database.change')}
						</button>
						<span className="text-border">·</span>
						<button
							type="button"
							onClick={onProbe}
							disabled={probeState?.loading}
							className="text-accent hover:underline disabled:opacity-50"
						>
							{t('settings.database.recheckAccess')}
						</button>
					</div>
					{showColumnPicker && (
						<Dropdown
							value={config.pathColumn}
							onChange={(v) => onChange({ pathColumn: v })}
							options={columnNames.map((n) => ({ value: n, label: n }))}
							className="w-full max-w-xs"
						/>
					)}
				</div>
			)}
		</div>
	)
}

/** Collapsible header + body. Defaults to a bordered card; pass `borderless` to render flush. */
function CollapsibleCard({
	title,
	description,
	defaultOpen = false,
	borderless = false,
	children,
}: {
	title: string
	description?: string
	defaultOpen?: boolean
	borderless?: boolean
	children: ReactNode
}) {
	const [open, setOpen] = useState(defaultOpen)
	return (
		<div className={borderless ? '' : 'rounded-lg border border-border'}>
			<button
				type="button"
				onClick={() => setOpen((v) => !v)}
				aria-expanded={open}
				className={`w-full flex items-start gap-3 text-left ${borderless ? 'px-0 py-2' : 'px-4 py-3'}`}
			>
				<span
					className={`w-5 mt-0.5 text-base leading-none text-text-muted transition-transform ${open ? 'rotate-90' : ''}`}
				>
					&#8250;
				</span>
				<span className="flex-1 min-w-0">
					<span className="block text-sm text-text font-medium">{title}</span>
					{description && (
						<span className="block text-xs text-text-muted mt-0.5">{description}</span>
					)}
				</span>
			</button>
			{open && <div className={borderless ? 'pl-8 pt-2' : 'pl-12 pr-4 pb-4'}>{children}</div>}
		</div>
	)
}

/**
 * Configure where the files of imported (external) media-library collections live.
 * Lives on the connected-database view so it is reachable after import / re-sync —
 * not only inside the first-time import wizard. Probes sample files to detect whether
 * the library is public; for private libraries it collects credentials so the CMS can
 * generate signed URLs.
 */
function ImportedMediaStorage() {
	const { t } = useTranslation()
	const { collections } = useCollections()
	const { currentProject, refreshProjects } = useAuth()
	const toast = useToast()
	const [configs, setConfigs] = useState<Record<string, MediaStorageConfig>>({})
	const [probes, setProbes] = useState<Record<string, ProbeState>>({})
	const [saving, setSaving] = useState(false)
	const [saved, setSaved] = useState(false)
	const [dirty, setDirty] = useState(false)

	const autoProbed = useRef<Set<string>>(new Set())
	const mediaCols = collections.filter((c) => c.source === 'external' && isMediaCollectionLike(c))

	const update = (name: string, patch: Partial<MediaStorageConfig>) => {
		setConfigs((prev) => ({ ...prev, [name]: { ...prev[name], ...patch } }))
		setDirty(true)
	}

	const updateCreds = (name: string, patch: Partial<MediaCreds>) => {
		setConfigs((prev) => {
			const cur = prev[name]
			return {
				...prev,
				[name]: { ...cur, credentials: { ...(cur.credentials || emptyCreds()), ...patch } },
			}
		})
		setDirty(true)
	}

	const probe = async (name: string, cfgOverride?: MediaStorageConfig) => {
		if (!currentProject) return
		const cfg = cfgOverride || configs[name]
		if (!cfg) return
		setProbes((p) => ({ ...p, [name]: { loading: true } }))
		try {
			const res = await api.post<{ result: string; detail?: string; provider?: string }>(
				`/api/v1/projects/${currentProject.id}/database/media-probe`,
				{
					collectionName: name,
					pathColumn: cfg.pathColumn,
					baseUrl: cfg.baseUrl.trim() || undefined,
				},
			)
			setProbes((p) => ({
				...p,
				[name]: { result: res.result, detail: res.detail, provider: res.provider },
			}))
			if (res.result === 'public') update(name, { access: 'public', adapter: 'custom-url' })
			else if (res.result === 'private')
				update(name, {
					access: 'private',
					adapter: res.provider === 'cloudflare-images' ? 'cloudflare-images' : 'r2',
				})
		} catch (err) {
			setProbes((p) => ({
				...p,
				[name]: {
					result: 'error',
					detail: err instanceof Error ? err.message : t('settings.database.probeFailed'),
				},
			}))
		}
	}

	// biome-ignore lint/correctness/useExhaustiveDependencies: one-shot init — `probe` is guarded by the autoProbed ref, and re-running on its identity change would clobber user edits.
	useEffect(() => {
		const externalDb = (currentProject?.settings as Record<string, unknown> | undefined)
			?.externalDb as Record<string, unknown> | undefined
		const savedMap = (externalDb?.mediaStorage || {}) as Record<
			string,
			{
				adapter: string
				pathColumn: string
				baseUrl?: string
				access?: 'public' | 'private'
				hasCredentials?: boolean
			}
		>
		const detected = collections.filter((c) => c.source === 'external' && isMediaCollectionLike(c))
		const next: Record<string, MediaStorageConfig> = {}
		for (const c of detected) {
			const s = savedMap[c.name]
			next[c.name] = s
				? {
						enabled: true,
						adapter: s.adapter,
						pathColumn: s.pathColumn,
						baseUrl: s.baseUrl || '',
						access: s.access || 'public',
						credentials: emptyCreds(),
						hasCredentials: Boolean(s.hasCredentials),
					}
				: {
						enabled: true,
						adapter: 'custom-url',
						pathColumn: pickPathField(c.fields),
						baseUrl: '',
						access: 'public',
						credentials: emptyCreds(),
						hasCredentials: false,
					}
		}
		setConfigs(next)
		setDirty(detected.some((c) => !savedMap[c.name]))
		// Auto-probe freshly-detected, unconfigured libraries — no button click needed.
		for (const c of detected) {
			if (!savedMap[c.name] && !autoProbed.current.has(c.name)) {
				autoProbed.current.add(c.name)
				probe(c.name, next[c.name])
			}
		}
	}, [collections, currentProject])

	if (mediaCols.length === 0) return null

	const save = async () => {
		if (!currentProject) return
		setSaving(true)
		try {
			const map: Record<string, Record<string, unknown>> = {}
			for (const [name, cfg] of Object.entries(configs)) {
				if (!cfg.enabled || !cfg.pathColumn) continue
				const access = cfg.access || 'public'
				const entry: Record<string, unknown> = {
					adapter: cfg.adapter,
					pathColumn: cfg.pathColumn,
					access,
				}
				if (access === 'public') {
					if (cfg.adapter !== 'absolute' && cfg.baseUrl.trim()) entry.baseUrl = cfg.baseUrl.trim()
				} else {
					// Only send credentials the user actually filled in; the server keeps
					// previously-saved values when a field is omitted.
					const c = cfg.credentials || emptyCreds()
					const filled = Object.fromEntries(Object.entries(c).filter(([, v]) => v.trim()))
					if (Object.keys(filled).length > 0) entry.credentials = filled
				}
				map[name] = entry
			}
			const res = await api.put<{ adapterPromoted?: boolean }>(
				`/api/v1/projects/${currentProject.id}/database/media-storage`,
				{ mediaStorage: Object.keys(map).length > 0 ? map : undefined },
			)
			await refreshProjects()
			setSaved(true)
			setDirty(false)
			setTimeout(() => setSaved(false), 2000)
			if (res?.adapterPromoted) {
				toast(t('settings.database.adapterPromotedToast'), 'success')
			}
		} catch (err) {
			toast(err instanceof Error ? err.message : t('settings.database.saveFailed'), 'error')
		} finally {
			setSaving(false)
		}
	}

	const mediaDescription = t('settings.database.importedMediaDescription', {
		count: mediaCols.length,
	})
	return (
		<CollapsibleCard
			title={t('settings.database.importedMediaTitle')}
			description={mediaDescription}
		>
			<div className="space-y-3">
				{mediaCols.map((c) => {
					const cfg = configs[c.name] || {
						enabled: true,
						adapter: 'absolute',
						pathColumn: pickPathField(c.fields),
						baseUrl: '',
						access: 'public' as const,
						credentials: emptyCreds(),
						hasCredentials: false,
					}
					return (
						<MediaStorageCard
							key={c.id}
							name={c.name}
							label={c.label || c.name}
							columnNames={c.fields.map((f) => f.name)}
							config={cfg}
							probeState={probes[c.name]}
							onChange={(patch) => update(c.name, patch)}
							onChangeCreds={(patch) => updateCreds(c.name, patch)}
							onProbe={() => probe(c.name)}
						/>
					)
				})}
				<SaveBar
					dirty={dirty}
					saving={saving}
					saved={saved}
					onSave={save}
					saveLabel={t('settings.database.saveMediaStorage')}
				/>
			</div>
		</CollapsibleCard>
	)
}
