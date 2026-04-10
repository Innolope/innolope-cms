import { createContext, useContext, useState, useCallback, type ReactNode } from 'react'

interface Toast {
	id: number
	message: string
	type: 'success' | 'error' | 'info'
}

interface ToastContext {
	toast: (message: string, type?: Toast['type']) => void
}

const ToastContext = createContext<ToastContext | null>(null)

let nextId = 0

export function ToastProvider({ children }: { children: ReactNode }) {
	const [toasts, setToasts] = useState<Toast[]>([])

	const toast = useCallback((message: string, type: Toast['type'] = 'info') => {
		const id = nextId++
		setToasts((prev) => [...prev, { id, message, type }])
		setTimeout(() => {
			setToasts((prev) => prev.filter((t) => t.id !== id))
		}, 4000)
	}, [])

	return (
		<ToastContext.Provider value={{ toast }}>
			{children}
			{/* Toast container */}
			<div className="fixed bottom-4 right-4 z-50 flex flex-col gap-2 pointer-events-none">
				{toasts.map((t) => (
					<div
						key={t.id}
						className={`pointer-events-auto px-4 py-2.5 rounded-lg shadow-lg text-sm font-medium animate-[slideIn_0.2s_ease-out] ${
							t.type === 'error'
								? 'bg-red-900 text-red-100'
								: t.type === 'success'
									? 'bg-green-900 text-green-100'
									: 'bg-surface-alt text-text border border-border'
						}`}
					>
						{t.message}
					</div>
				))}
			</div>
		</ToastContext.Provider>
	)
}

export function useToast() {
	const ctx = useContext(ToastContext)
	if (!ctx) throw new Error('useToast must be used within ToastProvider')
	return ctx.toast
}
