import { createContext, type ReactNode, useCallback, useContext, useState } from 'react'
import { ConfirmModal } from '../components/confirm-modal'
import { PromptModal } from '../components/prompt-modal'

interface ConfirmOptions {
	title: string
	message: string
	confirmLabel?: string
	danger?: boolean
	requireText?: string
}

interface PromptOptions {
	title: string
	message?: string
	label?: string
	placeholder?: string
	defaultValue?: string
	confirmLabel?: string
	required?: boolean
	multiline?: boolean
}

interface PendingConfirm extends ConfirmOptions {
	kind: 'confirm'
	resolve: (confirmed: boolean) => void
}

interface PendingPrompt extends PromptOptions {
	kind: 'prompt'
	resolve: (value: string | null) => void
}

type Pending = PendingConfirm | PendingPrompt

interface DialogContext {
	confirm: (options: ConfirmOptions) => Promise<boolean>
	prompt: (options: PromptOptions) => Promise<string | null>
}

const DialogContext = createContext<DialogContext | null>(null)

export function ConfirmProvider({ children }: { children: ReactNode }) {
	const [pending, setPending] = useState<Pending | null>(null)

	const confirm = useCallback(
		(options: ConfirmOptions) =>
			new Promise<boolean>((resolve) => {
				setPending({ kind: 'confirm', ...options, resolve })
			}),
		[],
	)

	const prompt = useCallback(
		(options: PromptOptions) =>
			new Promise<string | null>((resolve) => {
				setPending({ kind: 'prompt', ...options, resolve })
			}),
		[],
	)

	return (
		<DialogContext.Provider value={{ confirm, prompt }}>
			{children}
			{pending?.kind === 'confirm' && (
				<ConfirmModal
					title={pending.title}
					message={pending.message}
					confirmLabel={pending.confirmLabel}
					danger={pending.danger}
					requireText={pending.requireText}
					onConfirm={() => {
						pending.resolve(true)
						setPending(null)
					}}
					onCancel={() => {
						pending.resolve(false)
						setPending(null)
					}}
				/>
			)}
			{pending?.kind === 'prompt' && (
				<PromptModal
					title={pending.title}
					message={pending.message}
					label={pending.label}
					placeholder={pending.placeholder}
					defaultValue={pending.defaultValue}
					confirmLabel={pending.confirmLabel}
					required={pending.required}
					multiline={pending.multiline}
					onConfirm={(value) => {
						pending.resolve(value)
						setPending(null)
					}}
					onCancel={() => {
						pending.resolve(null)
						setPending(null)
					}}
				/>
			)}
		</DialogContext.Provider>
	)
}

export function useConfirm() {
	const ctx = useContext(DialogContext)
	if (!ctx) throw new Error('useConfirm must be used within ConfirmProvider')
	return ctx.confirm
}

export function usePrompt() {
	const ctx = useContext(DialogContext)
	if (!ctx) throw new Error('usePrompt must be used within ConfirmProvider')
	return ctx.prompt
}
