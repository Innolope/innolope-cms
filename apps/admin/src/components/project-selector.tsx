import { useState, useEffect, useRef } from 'react'
import { useAuth } from '../lib/auth'
import { api } from '../lib/api-client'
import { useToast } from '../lib/toast'

export function ProjectSelector() {
	const { projects, currentProject, switchProject, refreshProjects } = useAuth()
	const toast = useToast()
	const [open, setOpen] = useState(false)
	const containerRef = useRef<HTMLDivElement>(null)

	useEffect(() => {
		if (!open) return
		const handler = (e: MouseEvent) => {
			if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
				setOpen(false)
			}
		}
		document.addEventListener('mousedown', handler)
		return () => document.removeEventListener('mousedown', handler)
	}, [open])
	const [creating, setCreating] = useState(false)
	const [newName, setNewName] = useState('')

	const createProject = async () => {
		if (!newName.trim()) return
		const slug = newName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
		try {
			const project = await api.post<{ id: string }>('/api/v1/projects', { name: newName, slug })
			await refreshProjects()
			switchProject(project.id)
		} catch (err) {
			toast(err instanceof Error ? err.message : 'Failed to create project', 'error')
		}
		setCreating(false)
		setNewName('')
	}

	return (
		<div className="relative" ref={containerRef}>
			<button
				type="button"
				onClick={() => setOpen(!open)}
				className="w-full flex items-center justify-between px-3 py-2 rounded-md hover:bg-surface-alt transition-colors"
			>
				<p className="text-base font-semibold truncate text-left min-w-0">
					{currentProject?.name || 'Select project'}
				</p>
				<svg
					className={`w-4 h-4 text-text-muted shrink-0 ml-2 transition-transform ${open ? 'rotate-180' : ''}`}
					fill="none"
					viewBox="0 0 24 24"
					stroke="currentColor"
					strokeWidth={2}
				>
					<path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
				</svg>
			</button>

			{open && (
				<div className="absolute left-0 right-0 top-full mt-1 bg-surface border border-border-strong rounded-lg shadow-xl z-50 overflow-hidden">
					{projects.map((p) => (
						<button
							type="button"
							key={p.id}
							onClick={() => {
								switchProject(p.id)
								setOpen(false)
							}}
							className={`w-full text-left px-3 py-2 text-sm hover:bg-surface-alt transition-colors ${
								p.id === currentProject?.id ? 'bg-surface-alt text-text' : 'text-text-muted'
							}`}
						>
							<span className="block truncate">{p.name}</span>
							<span className="text-[10px] text-text-secondary">{p.role}</span>
						</button>
					))}

					<div className="border-t border-border-strong">
						{creating ? (
							<div className="p-2 flex gap-1">
								<input
									type="text"
									value={newName}
									onChange={(e) => setNewName(e.target.value)}
									onKeyDown={(e) => e.key === 'Enter' && createProject()}
									placeholder="Project name"
									className="flex-1 px-2 py-1 bg-input border border-border-strong rounded text-xs focus:outline-none"
									autoFocus
								/>
								<button
									type="button"
									onClick={createProject}
									className="px-2 py-1 bg-btn-primary text-btn-primary-text rounded text-xs"
								>
									Create
								</button>
							</div>
						) : (
							<button
								type="button"
								onClick={() => setCreating(true)}
								className="w-full text-left px-3 py-2 text-sm text-text-secondary hover:bg-surface-alt hover:text-text-muted"
							>
								+ New Project
							</button>
						)}
					</div>
				</div>
			)}
		</div>
	)
}
