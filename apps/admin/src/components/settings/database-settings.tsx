import { useState, useEffect } from 'react'
import { useAuth } from '../../lib/auth'
import { api } from '../../lib/api-client'

interface DetectedTable {
	name: string
	columns: { name: string; type: string }[]
}

export function DatabaseSettings() {
	const { currentProject, refreshProjects } = useAuth()
	const [dbType, setDbType] = useState('built-in')
	const [connectionString, setConnectionString] = useState('')
	const [testing, setTesting] = useState(false)
	const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null)
	const [scanning, setScanning] = useState(false)
	const [tables, setTables] = useState<DetectedTable[]>([])
	const [selectedTables, setSelectedTables] = useState<Set<string>>(new Set())
	const [saving, setSaving] = useState(false)
	const [saved, setSaved] = useState(false)

	useEffect(() => {
		if (currentProject) {
			const settings = currentProject.settings as Record<string, unknown> || {}
			const extDb = settings.externalDb as Record<string, unknown> | undefined
			if (extDb) {
				setDbType((extDb.type as string) || 'built-in')
				setConnectionString((extDb.connectionString as string) || '')
			}
		}
	}, [currentProject])

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

	const scanTables = async () => {
		if (!currentProject || !connectionString.trim()) return
		setScanning(true)
		try {
			const result = await api.post<{ tables: DetectedTable[] }>(
				`/api/v1/projects/${currentProject.id}/database/scan`,
				{ type: dbType, connectionString },
			)
			setTables(result.tables)
		} catch (err) {
			alert(err instanceof Error ? err.message : 'Scan failed')
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
				tables: Array.from(selectedTables),
			})
			setSaved(true)
			setTimeout(() => setSaved(false), 2000)
			await refreshProjects()
		} catch (err) {
			alert(err instanceof Error ? err.message : 'Failed to save')
		} finally {
			setSaving(false)
		}
	}

	return (
		<div className="space-y-4">
			<div>
				<label className="block text-xs text-text-secondary mb-1.5">Database source</label>
				<select
					value={dbType}
					onChange={(e) => {
						setDbType(e.target.value)
						setTestResult(null)
						setTables([])
					}}
					className="w-full max-w-xs px-3 py-2 bg-input border border-border-strong rounded text-sm text-text focus:outline-none focus:border-border-strong"
				>
					<option value="built-in">Built-in (Innolope CMS database)</option>
					<option value="postgresql">PostgreSQL</option>
					<option value="mysql">MySQL</option>
					<option value="mongodb">MongoDB</option>
					<option value="supabase">Supabase</option>
					<option value="vercel-postgres">Vercel Postgres</option>
				</select>
			</div>

			{dbType !== 'built-in' && (
				<>
					<div>
						<label className="block text-xs text-text-secondary mb-1.5">
							{dbType === 'supabase' ? 'Supabase connection string' :
							 dbType === 'vercel-postgres' ? 'POSTGRES_URL from Vercel dashboard' :
							 'Connection string'}
						</label>
						<input
							type="password"
							value={connectionString}
							onChange={(e) => setConnectionString(e.target.value)}
							placeholder={
								dbType === 'mongodb' ? 'mongodb+srv://...' :
								dbType === 'mysql' ? 'mysql://user:pass@host:3306/db' :
								'postgresql://user:pass@host:5432/db'
							}
							className="w-full px-3 py-2 bg-input border border-border-strong rounded text-sm text-text font-mono focus:outline-none focus:border-border-strong"
						/>
					</div>

					<div className="flex gap-2">
						<button
							type="button"
							onClick={testConnection}
							disabled={testing || !connectionString.trim()}
							className="px-4 py-2 bg-btn-secondary border border-border rounded text-sm hover:bg-btn-secondary-hover disabled:opacity-50 transition-colors"
						>
							{testing ? 'Testing...' : 'Test Connection'}
						</button>
						{testResult?.ok && (
							<button
								type="button"
								onClick={scanTables}
								disabled={scanning}
								className="px-4 py-2 bg-btn-primary text-btn-primary-text rounded text-sm hover:bg-btn-primary-hover disabled:opacity-50 transition-colors"
							>
								{scanning ? 'Scanning...' : 'Scan Tables'}
							</button>
						)}
					</div>

					{testResult && (
						<p className={`text-sm px-3 py-2 rounded ${testResult.ok ? 'bg-surface text-text border border-border' : 'bg-danger-surface text-danger border border-danger'}`}>
							{testResult.message}
						</p>
					)}

					{tables.length > 0 && (
						<div>
							<label className="block text-xs text-text-secondary mb-2">
								Detected tables — select which to manage as CMS collections
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
											{t.columns.length} columns
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

			<button
				type="button"
				onClick={save}
				disabled={saving}
				className="px-4 py-2 bg-btn-primary text-btn-primary-text rounded text-sm font-medium hover:bg-btn-primary-hover disabled:opacity-50 transition-colors"
			>
				{saving ? 'Saving...' : saved ? 'Saved' : 'Save'}
			</button>
		</div>
	)
}
