import { useState } from 'react'
import { useAuth } from '../lib/auth'
import { api } from '../lib/api-client'

export function ProjectSelector() {
	const { projects, currentProject, switchProject, refreshProjects } = useAuth()
	const [open, setOpen] = useState(false)
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
			alert(err instanceof Error ? err.message : 'Failed to create project')
		}
		setCreating(false)
		setNewName('')
	}

	return (
		<div className="relative">
			<button
				type="button"
				onClick={() => setOpen(!open)}
				className="w-full text-left px-3 py-2 rounded-md hover:bg-surface-alt transition-colors"
			>
				<p className="text-sm font-medium truncate">
					{currentProject?.name || 'Select project'}
				</p>
				<p className="text-[10px] text-text-muted truncate">
					{currentProject ? `/${currentProject.slug}` : 'No project selected'}
				</p>
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
