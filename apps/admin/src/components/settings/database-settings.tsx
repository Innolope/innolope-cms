import { useState, useEffect, useRef } from 'react'
import { useAuth } from '../../lib/auth'
import { api } from '../../lib/api-client'
import { useToast } from '../../lib/toast'
import { SaveBar } from '../save-bar'


interface DetectedTable {
	name: string
	columns: { name: string; type: string }[]
}

export function DatabaseSettings() {
	const { currentProject, refreshProjects } = useAuth()
	const toast = useToast()
	const [dbType, setDbType] = useState('built-in')
	const [connectionString, setConnectionString] = useState('')
	const [testing, setTesting] = useState(false)
	const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null)
	const [scanning, setScanning] = useState(false)
	const [databases, setDatabases] = useState<string[]>([])
	const [selectedDb, setSelectedDb] = useState<string>('')
	const [tables, setTables] = useState<DetectedTable[]>([])
	const [selectedTables, setSelectedTables] = useState<Set<string>>(new Set())
	const [saving, setSaving] = useState(false)
	const [saved, setSaved] = useState(false)
	const initialDbType = useRef('built-in')

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

	const dirty = dbType !== initialDbType.current

	const testConnection = async () => {
		if (!currentProject || !connectionString.trim()) return
		setTesting(true)
		setTestResult(null)
		try {
			const result = await api.post<{ ok: boolean; message: string }>(
				`/api/v1/projects/${currentProject.id}/database/test`,
				{ type: dbType, connectionString },
			)
			setTestResult(result)
		} catch (err) {
			setTestResult({ ok: false, message: err instanceof Error ? err.message : 'Connection failed' })
		} finally {
			setTesting(false)
		}
	}

	const needsDbSelect = dbType === 'mongodb' || dbType === 'firebase'

	const scanDatabases = async () => {
		if (!currentProject || !connectionString.trim()) return
		setScanning(true)
		try {
			const result = await api.post<{ databases: string[] }>(
				`/api/v1/projects/${currentProject.id}/database/scan-databases`,
				{ type: dbType, connectionString },
			)
			setDatabases(result.databases)
			if (result.databases.length === 1) {
				setSelectedDb(result.databases[0])
			}
		} catch (err) {
			toast(err instanceof Error ? err.message : 'Scan failed', 'error')
		} finally {
			setScanning(false)
		}
	}

	const scanTables = async () => {
		if (!currentProject || !connectionString.trim()) return
		setScanning(true)
		try {
			const result = await api.post<{ tables: DetectedTable[] }>(
				`/api/v1/projects/${currentProject.id}/database/scan`,
				{ type: dbType, connectionString, database: selectedDb || undefined },
			)
			setTables(result.tables)
		} catch (err) {
			toast(err instanceof Error ? err.message : 'Scan failed', 'error')
		} finally {
			setScanning(false)
		}
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
			await api.put(`/api/v1/projects/${currentProject.id}/database`, {
				type: dbType === 'built-in' ? null : dbType,
				connectionString: dbType === 'built-in' ? null : connectionString,
				database: selectedDb || null,
				tables: Array.from(selectedTables),
			})
			setSaved(true)
			setTimeout(() => setSaved(false), 2000)
			await refreshProjects()
		} catch (err) {
			toast(err instanceof Error ? err.message : 'Failed to save', 'error')
		} finally {
			setSaving(false)
		}
	}

	return (
		<div className="space-y-4">
			<div>
				<label className="block text-xs text-text-secondary mb-2">Database source</label>
				<div className="grid grid-cols-3 gap-3">
					{[
						{ value: 'built-in', label: 'Built-in', desc: 'Innolope CMS database' },
						{ value: 'mongodb', label: 'MongoDB', desc: 'Atlas or self-hosted' },
						{ value: 'postgresql', label: 'PostgreSQL', desc: 'Direct connection' },
						{ value: 'mysql', label: 'MySQL', desc: 'Direct connection' },
						{ value: 'supabase', label: 'Supabase', desc: 'Managed Postgres' },
						{ value: 'cockroachdb', label: 'CockroachDB', desc: 'Distributed SQL' },
						{ value: 'firebase', label: 'Firebase', desc: 'Firestore connection' },
						{ value: 'neon', label: 'Neon', desc: 'Serverless Postgres' },
						{ value: 'vercel-postgres', label: 'Vercel Postgres', desc: 'Serverless SQL' },
					].map((opt) => (
						<button
							key={opt.value}
							type="button"
							onClick={() => { setDbType(opt.value); setTestResult(null); setDatabases([]); setSelectedDb(''); setTables([]) }}
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
							<p className={`font-medium ${dbType === opt.value ? 'text-accent' : 'text-text'}`}>{opt.label}</p>
							<p className="text-xs text-text-muted mt-1">{opt.desc}</p>
						</button>
					))}
				</div>
			</div>

			{dbType !== 'built-in' && (
				<>
					<div>
						<label className="block text-xs text-text-secondary mb-1.5">
							{dbType === 'supabase' ? 'Supabase connection string' :
							 dbType === 'vercel-postgres' ? 'POSTGRES_URL from Vercel dashboard' :
							 'Connection string'}
						</label>
						<div className="flex gap-2">
							<input
								type="password"
								value={connectionString}
								onChange={(e) => setConnectionString(e.target.value)}
								placeholder={
									dbType === 'mongodb' ? 'mongodb+srv://...' :
									dbType === 'mysql' ? 'mysql://user:pass@host:3306/db' :
									'postgresql://user:pass@host:5432/db'
								}
								className="flex-1 px-3 py-2 bg-input border border-border-strong rounded text-sm text-text font-mono focus:outline-none focus:border-border-strong"
							/>
							<button
								type="button"
								onClick={testConnection}
								disabled={testing || !connectionString.trim()}
								className="px-4 py-2 bg-btn-secondary border border-border rounded text-sm hover:bg-btn-secondary-hover disabled:opacity-50 transition-colors shrink-0"
							>
								{testing ? 'Testing...' : 'Test Connection'}
							</button>
						</div>
					</div>

					{testResult?.ok && needsDbSelect && databases.length === 0 && (
						<button
							type="button"
							onClick={scanDatabases}
							disabled={scanning}
							className="px-4 py-2 bg-btn-primary text-btn-primary-text rounded text-sm hover:bg-btn-primary-hover disabled:opacity-50 transition-colors"
						>
							{scanning ? 'Scanning...' : 'Scan Databases'}
						</button>
					)}

					{databases.length > 0 && (
						<div>
							<label className="block text-xs text-text-secondary mb-2">Select database</label>
							<div className="flex flex-wrap gap-2">
								{databases.map((db) => (
									<button
										key={db}
										type="button"
										onClick={() => { setSelectedDb(db); setTables([]) }}
										className={`px-3 py-1.5 rounded-lg border text-sm transition-colors ${
											selectedDb === db
												? 'border-accent bg-accent-soft font-medium'
												: 'border-border hover:border-border-strong'
										}`}
									>
										{db}
									</button>
								))}
							</div>
						</div>
					)}

					{testResult?.ok && (!needsDbSelect || selectedDb) && (
						<button
							type="button"
							onClick={scanTables}
							disabled={scanning}
							className="px-4 py-2 bg-btn-primary text-btn-primary-text rounded text-sm hover:bg-btn-primary-hover disabled:opacity-50 transition-colors"
						>
							{scanning ? 'Scanning...' : needsDbSelect ? 'Scan Collections' : 'Scan Tables'}
						</button>
					)}

					{testResult && (
						<div className={`flex items-center gap-2 text-sm px-3 py-2.5 rounded-lg ${testResult.ok ? 'bg-surface-alt text-text' : 'bg-danger-surface text-danger'}`}>
							{testResult.ok ? (
								<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12" /></svg>
							) : (
								<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10" /><line x1="15" y1="9" x2="9" y2="15" /><line x1="9" y1="9" x2="15" y2="15" /></svg>
							)}
							{testResult.message}
						</div>
					)}

					{tables.length > 0 && (
						<div>
							<label className="block text-xs text-text-secondary mb-2">
								{needsDbSelect ? 'Detected collections' : 'Detected tables'} — select which to manage as CMS collections
							</label>
							<div className="space-y-1 max-h-60 overflow-auto border border-border rounded p-2">
								{tables.map((t) => (
									<label
										key={t.name}
										className="flex items-center gap-2 px-2 py-1.5 rounded hover:bg-surface-alt cursor-pointer"
									>
										<input
											type="checkbox"
											checked={selectedTables.has(t.name)}
											onChange={() => toggleTable(t.name)}
											className="rounded"
										/>
										<span className="text-sm font-mono">{t.name}</span>
										<span className="text-[11px] text-text-muted">
											{t.columns.length} {needsDbSelect ? 'fields' : 'columns'}
										</span>
									</label>
								))}
							</div>
						</div>
					)}
				</>
			)}

			{dbType === 'built-in' && (
				<p className="text-xs text-text-muted">Content stored in the default Innolope CMS database. No external connection needed.</p>
			)}

			<SaveBar dirty={dirty} saving={saving} saved={saved} onSave={save} onReset={() => setDbType(initialDbType.current)} />
		</div>
	)
}
