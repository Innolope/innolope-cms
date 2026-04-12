import { useState, useEffect, useRef, useCallback } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { useAuth } from '../../lib/auth'
import { useCollections } from '../../lib/collections'
import { api } from '../../lib/api-client'
import { useToast } from '../../lib/toast'
import { useLicense } from '../license-gate'
import { SaveBar } from '../save-bar'


interface DetectedTable {
	name: string
	columns: { name: string; type: string }[]
	count?: number
}

const DB_OPTIONS = [
	{ value: 'built-in', label: 'Innolope CMS', desc: 'Managed PostgreSQL', logo: '/logo.svg' },
	{ value: 'mongodb', label: 'MongoDB', desc: 'Atlas or self-hosted', logo: '/db-logos/mongodb.svg' },
	{ value: 'postgresql', label: 'PostgreSQL', desc: 'Direct connection', logo: '/db-logos/postgresql.svg' },
	{ value: 'mysql', label: 'MySQL', desc: 'Direct connection', logo: '/db-logos/mysql.svg' },
	{ value: 'supabase', label: 'Supabase', desc: 'Managed Postgres', logo: '/db-logos/supabase.svg' },
	{ value: 'cockroachdb', label: 'CockroachDB', desc: 'Distributed SQL', logo: '/db-logos/cockroachdb.svg' },
	{ value: 'firebase', label: 'Firebase', desc: 'Firestore connection', logo: '/db-logos/firebase.svg' },
	{ value: 'neon', label: 'Neon', desc: 'Serverless Postgres', logo: '/db-logos/neon.svg' },
	{ value: 'vercel-postgres', label: 'Vercel Postgres', desc: 'Serverless SQL', logo: '/db-logos/vercel.svg' },
] as const

const CONNECTION_HELP: Record<string, { label: string; placeholder: string; instructions: string[]; format: string }> = {
	mongodb: {
		label: 'MongoDB connection string',
		placeholder: 'mongodb+srv://username:password@cluster.mongodb.net/database',
		format: 'mongodb+srv://<username>:<password>@<cluster>.mongodb.net/<database>',
		instructions: [
			'Open MongoDB Atlas and select your cluster',
			'Click "Connect" then choose "Drivers"',
			'Copy the connection string and replace <password> with your database user password',
		],
	},
	postgresql: {
		label: 'PostgreSQL connection string',
		placeholder: 'postgresql://user:password@host:5432/database',
		format: 'postgresql://<user>:<password>@<host>:<port>/<database>',
		instructions: [
			'Find the connection details in your PostgreSQL hosting dashboard',
			'Combine host, port, user, password, and database name into the URI format',
			'If SSL is required, append ?sslmode=require to the string',
		],
	},
	mysql: {
		label: 'MySQL connection string',
		placeholder: 'mysql://user:password@host:3306/database',
		format: 'mysql://<user>:<password>@<host>:<port>/<database>',
		instructions: [
			'Find the connection details in your MySQL hosting dashboard or server config',
			'Combine host, port, user, password, and database name into the URI format',
			'Default port is 3306 unless configured otherwise',
		],
	},
	supabase: {
		label: 'Supabase connection string',
		placeholder: 'postgresql://postgres.[ref]:[password]@aws-0-[region].pooler.supabase.com:6543/postgres',
		format: 'postgresql://postgres.[ref]:[password]@aws-0-[region].pooler.supabase.com:6543/postgres',
		instructions: [
			'Open your Supabase project dashboard',
			'Go to Project Settings \u2192 Database',
			'Scroll to "Connection string" section and select URI',
			'Copy the string and replace [YOUR-PASSWORD] with your database password',
		],
	},
	cockroachdb: {
		label: 'CockroachDB connection string',
		placeholder: 'postgresql://user:password@cluster.cockroachlabs.cloud:26257/database?sslmode=verify-full',
		format: 'postgresql://<user>:<password>@<cluster>.cockroachlabs.cloud:26257/<database>?sslmode=verify-full',
		instructions: [
			'Open the CockroachDB Cloud Console',
			'Select your cluster and click "Connect"',
			'Choose "General connection string" and copy it',
			'Replace the password placeholder with your SQL user password',
		],
	},
	firebase: {
		label: 'Firebase service account JSON',
		placeholder: '{\n  "type": "service_account",\n  "project_id": "your-project",\n  ...\n}',
		format: 'JSON object with type, project_id, private_key, client_email, etc.',
		instructions: [
			'Open the Firebase Console and select your project',
			'Go to Project Settings \u2192 Service accounts',
			'Click "Generate new private key" to download the JSON file',
			'Open the file and paste the entire JSON content below',
		],
	},
	neon: {
		label: 'Neon connection string',
		placeholder: 'postgresql://user:password@ep-cool-name-123456.us-east-2.aws.neon.tech/neondb?sslmode=require',
		format: 'postgresql://<user>:<password>@<endpoint>.aws.neon.tech/<database>?sslmode=require',
		instructions: [
			'Open your Neon project dashboard',
			'The connection string is displayed on the main Dashboard page',
			'Click the copy button next to "Connection Details"',
			'Make sure sslmode=require is included',
		],
	},
	'vercel-postgres': {
		label: 'Vercel Postgres URL',
		placeholder: 'postgres://default:xxxxx@ep-xxx-pooler.us-east-1.aws.neon.tech/verceldb?sslmode=require',
		format: 'postgres://default:<password>@<host>/verceldb?sslmode=require',
		instructions: [
			'Open the Vercel dashboard and go to Storage',
			'Select your Postgres database',
			'Switch to the ".env.local" tab',
			'Copy the value of POSTGRES_URL (not POSTGRES_URL_NON_POOLING)',
		],
	},
}

const STORAGE_KEY = 'innolope:db-wizard'

/** Mask the password portion of a connection string, keeping everything else visible */
function maskConnectionString(str: string): string {
	if (!str) return ''
	if (str.trim().startsWith('{')) {
		return str.replace(/"private_key"\s*:\s*"[^"]*"/, '"private_key": "\u2022\u2022\u2022\u2022\u2022\u2022"')
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
	try { sessionStorage.setItem(STORAGE_KEY, JSON.stringify(data)) } catch {}
}

function loadWizardState(): { dbType: string; connectionString: string; selectedDb: string } | null {
	try {
		const raw = sessionStorage.getItem(STORAGE_KEY)
		return raw ? JSON.parse(raw) : null
	} catch { return null }
}

function clearWizardState() {
	try { sessionStorage.removeItem(STORAGE_KEY) } catch {}
}

function BackLink({ onClick, children }: { onClick: () => void; children: React.ReactNode }) {
	return (
		<button
			type="button"
			onClick={onClick}
			className="flex items-center gap-1.5 text-sm text-text-secondary hover:text-text transition-colors"
		>
			<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="15 18 9 12 15 6" /></svg>
			{children}
		</button>
	)
}

function StepIndicator({ steps, current }: { steps: string[]; current: number }) {
	return (
		<div className="flex items-center justify-center gap-1.5 mb-10">
			{steps.map((label, i) => (
				<div key={label} className="flex items-center gap-1.5">
					<div className={`flex items-center gap-1.5 text-xs font-medium transition-colors ${
						i < current ? 'text-accent' : i === current ? 'text-text' : 'text-text-muted'
					}`}>
						<div className={`w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-semibold transition-colors ${
							i < current
								? 'bg-accent text-btn-primary-text'
								: i === current
									? 'bg-text text-surface'
									: 'bg-surface-alt text-text-muted'
						}`}>
							{i < current ? (
								<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12" /></svg>
							) : i + 1}
						</div>
						{label}
					</div>
					{i < steps.length - 1 && (
						<div className={`w-6 h-px transition-colors ${i < current ? 'bg-accent' : 'bg-border'}`} />
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
	const { currentProject, refreshProjects } = useAuth()
	const { refreshCollections } = useCollections()
	const navigate = useNavigate()
	const license = useLicense()
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
	const [tableSort, setTableSort] = useState<'name' | 'records'>('name')
	const [hideEmpty, setHideEmpty] = useState(false)
	const [accessMode, setAccessMode] = useState<'read-write' | 'read-only'>('read-write')
	const [estimatedSizeBytes, setEstimatedSizeBytes] = useState<number | null>(null)
	const initialDbType = useRef('built-in')
	const debounceRef = useRef<ReturnType<typeof setTimeout>>(undefined)
	const abortRef = useRef<AbortController>(undefined)

	useEffect(() => {
		if (currentProject) {
			const settings = currentProject.settings as Record<string, unknown> || {}
			const extDb = settings.externalDb as Record<string, unknown> | undefined
			if (extDb) {
				const t = (extDb.type as string) || 'built-in'
				setDbType(t)
				initialDbType.current = t
				setConnectionString((extDb.connectionString as string) || '')
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
	const tableWord = isNoSql ? 'Collections' : 'Tables'
	const stepLabels = ['Database', 'Connection']
	if (needsDbSelect) stepLabels.push('Confirm DB')
	stepLabels.push(tableWord)

	const setStep = (n: number) => {
		setStepLocal(n)
		const stepName = n === 0 ? null
			: n === 1 ? 'connection'
			: n === 2 ? (needsDbSelect ? 'select-db' : 'tables')
			: n === 3 ? 'tables'
			: null
		updateUrlStep(stepName)
	}

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
	const testAndAdvance = useCallback(async (connStr: string) => {
		if (!currentProject || !connStr.trim()) return

		abortRef.current?.abort()
		abortRef.current = new AbortController()

		setTesting(true)
		setTestResult(null)
		try {
			const result = await api.post<{ ok: boolean; message: string }>(
				`/api/v1/projects/${currentProject.id}/database/test`,
				{ type: dbType, connectionString: connStr },
			)
			setTestResult(result)
			if (result.ok) {
				if (needsDbSelect) {
					setScanning(true)
					try {
						const dbResult = await api.post<{ databases: string[] }>(
							`/api/v1/projects/${currentProject.id}/database/scan-databases`,
							{ type: dbType, connectionString: connStr },
						)
						setDatabases(dbResult.databases)
						if (dbResult.databases.length === 1) {
							setSelectedDb(dbResult.databases[0])
							setStep(3)
							setScanning(true)
							try {
								const tableResult = await api.post<{ tables: DetectedTable[]; estimatedSizeBytes?: number }>(
									`/api/v1/projects/${currentProject.id}/database/scan`,
									{ type: dbType, connectionString: connStr, database: dbResult.databases[0] },
								)
								setTables(tableResult.tables)
								if (tableResult.estimatedSizeBytes != null) setEstimatedSizeBytes(tableResult.estimatedSizeBytes)
							} catch (err) {
								toast(err instanceof Error ? err.message : 'Scan failed', 'error')
							} finally {
								setScanning(false)
							}
						} else {
							setStep(2)
						}
					} catch (err) {
						toast(err instanceof Error ? err.message : 'Failed to scan databases', 'error')
					} finally {
						setScanning(false)
					}
				} else {
					setStep(2)
					setScanning(true)
					try {
						const tableResult = await api.post<{ tables: DetectedTable[]; estimatedSizeBytes?: number }>(
							`/api/v1/projects/${currentProject.id}/database/scan`,
							{ type: dbType, connectionString: connStr },
						)
						setTables(tableResult.tables)
								if (tableResult.estimatedSizeBytes != null) setEstimatedSizeBytes(tableResult.estimatedSizeBytes)
					} catch (err) {
						toast(err instanceof Error ? err.message : 'Scan failed', 'error')
					} finally {
						setScanning(false)
					}
				}
			}
		} catch (err) {
			setTestResult({ ok: false, message: err instanceof Error ? err.message : 'Connection failed' })
		} finally {
			setTesting(false)
		}
	}, [currentProject, dbType, needsDbSelect, toast])

	// Debounced effect: auto-test 800ms after user stops typing
	useEffect(() => {
		if (step !== 1 || !connectionString.trim()) return
		clearTimeout(debounceRef.current)
		debounceRef.current = setTimeout(() => {
			testAndAdvance(connectionString)
		}, 800)
		return () => clearTimeout(debounceRef.current)
	}, [connectionString, step, testAndAdvance])

	const scanTablesFor = useCallback(async (db: string) => {
		if (!currentProject || !connectionString.trim()) return
		setScanning(true)
		try {
			const result = await api.post<{ tables: DetectedTable[] }>(
				`/api/v1/projects/${currentProject.id}/database/scan`,
				{ type: dbType, connectionString, database: db },
			)
			setTables(result.tables)
		} catch (err) {
			toast(err instanceof Error ? err.message : 'Scan failed', 'error')
		} finally {
			setScanning(false)
		}
	}, [currentProject, connectionString, dbType, toast])

	const selectDatabase = (db: string) => {
		setSelectedDb(db)
		setTables([])
		setStep(3)
		scanTablesFor(db)
	}

	const toggleTable = (name: string) => {
		const next = new Set(selectedTables)
		if (next.has(name)) next.delete(name)
		else next.add(name)
		setSelectedTables(next)
	}

	const save = async () => {
		if (!currentProject) return
		setSaving(true)
		try {
			const selectedTableData = tables.filter(t => selectedTables.has(t.name))
			const result = await api.put<{
				project: unknown
				collections: Array<{ name: string }>
				warnings?: string[]
			}>(`/api/v1/projects/${currentProject.id}/database`, {
				type: dbType === 'built-in' ? null : dbType,
				connectionString: dbType === 'built-in' ? null : connectionString,
				database: selectedDb || null,
				tables: selectedTableData,
				accessMode,
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
			toast(err instanceof Error ? err.message : 'Failed to save', 'error')
		} finally {
			setSaving(false)
		}
	}

	const goBack = () => {
		if (step === 1) {
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

	const selectedOption = DB_OPTIONS.find(o => o.value === dbType)!

	// ─── Step 0: Select database type ─────────────────────────────────────
	if (step === 0) {
		return (
			<div className="space-y-4">
				<div>
					<label className="block text-xs text-text-secondary mb-2">Select database source</label>
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
								<div className={`absolute top-4 right-4 w-[18px] h-[18px] rounded-full border-2 flex items-center justify-center ${
									dbType === opt.value ? 'border-accent' : 'border-border-strong'
								}`}>
									{dbType === opt.value && <div className="w-2.5 h-2.5 rounded-full bg-accent" />}
								</div>
								<img src={opt.logo} alt="" className="w-6 h-6 mb-2" />
								<p className={`font-medium ${dbType === opt.value ? 'text-accent' : 'text-text'}`}>{opt.label}</p>
								<p className="text-xs text-text-muted mt-1">{opt.desc}</p>
							</button>
						))}
					</div>
				</div>

				{dbType === 'built-in' && (
					<p className="text-xs text-text-muted">Content stored in the default Innolope CMS database. No external connection needed.</p>
				)}

				{/* Only show save when switching back to built-in (disconnecting external DB) */}
				{dbType === 'built-in' && dirty && (
					<SaveBar dirty={dirty} saving={saving} saved={saved} onSave={save} saveLabel="Switch to Built-in" />
				)}
			</div>
		)
	}

	// ─── Step 1: Connection string ────────────────────────────────────────
	if (step === 1 && help) {
		const masked = maskConnectionString(connectionString)

		return (
			<div>
				{!onChangeDatabase && (
					<div className="-mt-2 -ml-1 mb-6">
						<BackLink onClick={goBack}>Change provider</BackLink>
					</div>
				)}
				<div className="space-y-5">
					<StepIndicator steps={stepLabels} current={1} />

					<div className="flex items-center gap-3 mb-8">
						<img src={selectedOption.logo} alt="" className="w-8 h-8" />
						<div>
							<p className="font-medium text-text">{selectedOption.label}</p>
							<p className="text-xs text-text-muted">{selectedOption.desc}</p>
						</div>
					</div>

					{/* Input */}
					<div>
						<label className="block text-xs text-text-secondary mb-1.5">{help.label}</label>
						{isFirebase ? (
							<textarea
								value={connectionString}
								onChange={(e) => { setConnectionString(e.target.value); setTestResult(null) }}
								placeholder={help.placeholder}
								rows={6}
								className="w-full px-3 py-2 bg-input border border-border-strong rounded text-sm text-text font-mono focus:outline-none focus:border-border-strong resize-y"
							/>
						) : (
							<input
								type="password"
								value={connectionString}
								onChange={(e) => { setConnectionString(e.target.value); setTestResult(null) }}
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
						<p className="text-xs font-medium text-text-secondary">How to find your connection string</p>
						<ol className="space-y-1.5">
							{help.instructions.map((line, i) => (
								<li key={i} className="flex gap-2 text-sm text-text-muted">
									<span className="text-text-secondary font-medium shrink-0">{i + 1}.</span>
									{line}
								</li>
							))}
						</ol>
						<div className="mt-2 pt-2 border-t border-border">
							<p className="text-[11px] text-text-muted font-mono break-all">Format: {help.format}</p>
						</div>
					</div>

					{/* Status indicator */}
					{testing && (
						<div className="flex items-center gap-2 text-sm text-text-muted">
							<div className="w-3.5 h-3.5 border-2 border-accent border-t-transparent rounded-full animate-spin" />
							Testing connection...
						</div>
					)}

					{scanning && (
						<div className="flex items-center gap-2 text-sm text-text-muted">
							<div className="w-3.5 h-3.5 border-2 border-accent border-t-transparent rounded-full animate-spin" />
							Scanning...
						</div>
					)}

					{testResult && !testResult.ok && !testing && (
						<div className="flex items-center gap-2 text-sm px-3 py-2.5 rounded-lg bg-danger-surface text-danger">
							<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10" /><line x1="15" y1="9" x2="9" y2="15" /><line x1="9" y1="9" x2="15" y2="15" /></svg>
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
				{!onChangeDatabase && (
					<div className="-mt-2 -ml-1 mb-6">
						<BackLink onClick={goBack}>Edit connection string</BackLink>
					</div>
				)}
				<div className="space-y-5">
					<StepIndicator steps={stepLabels} current={2} />

					<div>
						<label className="block text-xs text-text-secondary mb-2">
							Select a database
						</label>
						<p className="text-sm text-text-muted mb-3">
							We found {databases.length} database{databases.length !== 1 ? 's' : ''} on this server. Choose which one to connect.
						</p>
						<div className="grid grid-cols-2 gap-2">
							{databases.map((db) => (
								<button
									key={db}
									type="button"
									onClick={() => selectDatabase(db)}
									className="px-4 py-3 rounded-lg border border-border hover:border-border-strong text-left transition-colors group"
								>
									<span className="text-sm font-mono text-text group-hover:text-accent transition-colors">{db}</span>
								</button>
							))}
						</div>
					</div>
				</div>
			</div>
		)
	}

	// ─── Tables / Collections step ────────────────────────────────────────
	const tableStepIndex = needsDbSelect ? 3 : 2
	if (step === tableStepIndex) {
		return (
			<div>
				{!onChangeDatabase && (
					<div className="-mt-2 -ml-1 mb-6">
						<BackLink onClick={goBack}>
							{needsDbSelect ? 'Choose different database' : 'Edit connection string'}
						</BackLink>
					</div>
				)}
				<div className="space-y-5">
				<StepIndicator steps={stepLabels} current={stepLabels.length - 1} />

				<div className="text-center space-y-1">
					<div className="flex items-center justify-center gap-2">
						<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-accent"><polyline points="20 6 9 17 4 12" /></svg>
						<span className="text-sm text-text-secondary">Connected to <span className="font-medium text-text">{selectedOption.label}</span></span>
					</div>
					{selectedDb && (
						<p className="text-sm text-text-muted">Database found: <span className="font-medium text-text">{selectedDb}</span></p>
					)}
				</div>

				{scanning ? (
					<div className="flex items-center gap-3 py-8 justify-center">
						<div className="w-4 h-4 border-2 border-accent border-t-transparent rounded-full animate-spin" />
						<span className="text-sm text-text-muted">
							Scanning {isNoSql ? 'collections' : 'tables'}...
						</span>
					</div>
				) : tables.length > 0 ? (
					<div>
						<div className="flex items-center justify-between mb-3">
							<label className="text-xs text-text-secondary">
								{isNoSql ? 'Detected collections' : 'Detected tables'} &mdash; select which to manage as CMS collections
							</label>
						</div>
						<div className="flex items-center gap-4 mb-3">
							<div className="flex items-center gap-2 text-xs text-text-secondary">
								<span>Sort:</span>
								<button type="button" onClick={() => setTableSort('name')} className={`px-2 py-0.5 rounded ${tableSort === 'name' ? 'bg-surface-alt text-text font-medium' : 'hover:text-text'}`}>A-Z</button>
								<button type="button" onClick={() => setTableSort('records')} className={`px-2 py-0.5 rounded ${tableSort === 'records' ? 'bg-surface-alt text-text font-medium' : 'hover:text-text'}`}>Records</button>
							</div>
							<label className="flex items-center gap-1.5 text-xs text-text-secondary cursor-pointer">
								<input type="checkbox" checked={hideEmpty} onChange={e => setHideEmpty(e.target.checked)} className="rounded" />
								Hide empty
							</label>
						</div>
						<table className="w-full text-sm">
							<thead>
								<tr className="text-left text-xs text-text-muted border-b border-border">
									<th className="pb-2 pl-1 w-8" />
									<th className="pb-2">Name</th>
									<th className="pb-2 text-right">{isNoSql ? 'Fields' : 'Columns'}</th>
									<th className="pb-2 text-right pr-1">Records</th>
								</tr>
							</thead>
							<tbody>
								{tables
									.filter(t => !hideEmpty || (t.count ?? 0) > 0)
									.sort((a, b) => tableSort === 'name' ? a.name.localeCompare(b.name) : (b.count ?? 0) - (a.count ?? 0))
									.map(t => (
									<tr key={t.name} className="border-b border-border hover:bg-surface-alt transition-colors cursor-pointer" onClick={() => toggleTable(t.name)}>
										<td className="py-2 pl-1">
											<input type="checkbox" checked={selectedTables.has(t.name)} onChange={() => toggleTable(t.name)} className="rounded" />
										</td>
										<td className="py-2 font-medium">{t.name}</td>
										<td className="py-2 text-right text-text-muted">{t.columns.length}</td>
										<td className="py-2 text-right text-text-muted pr-1">{t.count ?? '—'}</td>
									</tr>
								))}
							</tbody>
						</table>
						{hideEmpty && tables.some(t => (t.count ?? 0) === 0) && (
							<p className="text-xs text-text-muted mt-2">{tables.filter(t => (t.count ?? 0) === 0).length} empty {isNoSql ? 'collections' : 'tables'} hidden</p>
						)}
					</div>
				) : (
					<p className="text-sm text-text-muted py-4 text-center">
						No {isNoSql ? 'collections' : 'tables'} found in this database.
					</p>
				)}

				{/* Size estimate */}
				{estimatedSizeBytes != null && (
					<p className="text-xs text-text-muted">
						Estimated database size: {estimatedSizeBytes < 1024 * 1024 ? `${Math.round(estimatedSizeBytes / 1024)} KB` : `${Math.round(estimatedSizeBytes / 1024 / 1024)} MB`}
						{estimatedSizeBytes > 100 * 1024 * 1024 && (
							<span className="text-text-secondary"> — Content will be cached on demand</span>
						)}
					</p>
				)}

				{/* Access mode */}
				{tables.length > 0 && (
					<div className="flex items-center gap-4 text-xs text-text-secondary">
						<span>Access mode:</span>
						<label className="flex items-center gap-1.5 cursor-pointer">
							<input type="radio" name="accessMode" checked={accessMode === 'read-write'} onChange={() => setAccessMode('read-write')} />
							Read & Write
						</label>
						<label className="flex items-center gap-1.5 cursor-pointer">
							<input type="radio" name="accessMode" checked={accessMode === 'read-only'} onChange={() => setAccessMode('read-only')} />
							Read Only
						</label>
					</div>
				)}

				<SaveBar
					dirty={selectedTables.size > 0 || dirty}
					saving={saving}
					saved={saved}
					onSave={save}
					saveLabel="Save"
				/>
				</div>
			</div>
		)
	}

	return null
}
