import { createContext, type ReactNode, useCallback, useContext, useState } from 'react'

interface ToastAction {
	label: string
	onClick: () => void
}

interface ToastOptions {
	/** Stay until dismissed instead of auto-hiding — for news that must not be missed. */
	sticky?: boolean
	/** Optional action button rendered inside the toast (e.g. "Reload"). */
	action?: ToastAction
}

interface Toast {
	id: number
	message: string
	type: 'success' | 'error' | 'info'
	sticky?: boolean
	action?: ToastAction
}

interface ToastContext {
	toast: (message: string, type?: Toast['type'], options?: ToastOptions) => void
}

const ToastContext = createContext<ToastContext | null>(null)

let nextId = 0

export function ToastProvider({ children }: { children: ReactNode }) {
	const [toasts, setToasts] = useState<Toast[]>([])

	const dismiss = useCallback((id: number) => {
		setToasts((prev) => prev.filter((t) => t.id !== id))
	}, [])

	const toast = useCallback(
		(message: string, type: Toast['type'] = 'info', options?: ToastOptions) => {
			const id = nextId++
			setToasts((prev) => [...prev, { id, message, type, ...options }])
			if (!options?.sticky) {
				setTimeout(() => {
					setToasts((prev) => prev.filter((t) => t.id !== id))
				}, 4000)
			}
		},
		[],
	)

	return (
		<ToastContext.Provider value={{ toast }}>
			{children}
			{/* Toast container */}
			<div className="fixed bottom-4 right-4 z-50 flex flex-col gap-2 pointer-events-none">
				{toasts.map((t) => (
					<div
						key={t.id}
						className={`pointer-events-auto flex items-center gap-3 px-4 py-2.5 rounded-lg shadow-lg text-sm font-medium animate-[slideIn_0.2s_ease-out] ${
							t.type === 'error'
								? 'bg-red-900 text-red-100'
								: t.type === 'success'
									? 'bg-green-900 text-green-100'
									: 'bg-surface-alt text-text border border-border'
						}`}
					>
						<span>{t.message}</span>
						{t.action && (
							<button
								type="button"
								onClick={() => {
									t.action?.onClick()
									dismiss(t.id)
								}}
								className="shrink-0 px-2.5 py-1 rounded bg-btn-primary text-btn-primary-text text-xs font-semibold hover:bg-btn-primary-hover transition-colors"
							>
								{t.action.label}
							</button>
						)}
						{t.sticky && (
							<button
								type="button"
								aria-label="Dismiss"
								onClick={() => dismiss(t.id)}
								className="shrink-0 -mr-1 p-1 rounded text-current opacity-60 hover:opacity-100 transition-opacity"
							>
								<svg
									width="12"
									height="12"
									viewBox="0 0 24 24"
									fill="none"
									stroke="currentColor"
									strokeWidth="2"
									strokeLinecap="round"
								>
									<line x1="18" y1="6" x2="6" y2="18" />
									<line x1="6" y1="6" x2="18" y2="18" />
								</svg>
							</button>
						)}
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
