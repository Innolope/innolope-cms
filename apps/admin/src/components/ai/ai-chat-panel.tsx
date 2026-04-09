import { useState, useRef, useEffect } from 'react'
import { api } from '../../lib/api-client'

interface ChatMessage {
	id: string
	role: 'user' | 'assistant'
	text: string
	field?: string
	model?: string
	provider?: string
}

interface AiChatPanelProps {
	targetField: string | null
	selectedText: string | null
	onApply: (field: string, text: string) => void
	onClose: () => void
}

export function AiChatPanel({ targetField, selectedText, onApply, onClose }: AiChatPanelProps) {
	const [messages, setMessages] = useState<ChatMessage[]>([])
	const [input, setInput] = useState('')
	const [loading, setLoading] = useState(false)
	const bottomRef = useRef<HTMLDivElement>(null)
	const inputRef = useRef<HTMLTextAreaElement>(null)

	useEffect(() => {
		bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
	}, [messages])

	useEffect(() => {
		inputRef.current?.focus()
	}, [targetField])

	const send = async (prompt?: string, action?: string) => {
		const text = prompt || input.trim()
		if (!text && !action) return

		const userMsg: ChatMessage = {
			id: crypto.randomUUID(),
			role: 'user',
			text: action ? `[${action}] ${selectedText?.slice(0, 50) || ''}...` : text,
			field: targetField || undefined,
		}
		setMessages((prev) => [...prev, userMsg])
		setInput('')
		setLoading(true)

		try {
			const result = await api.post<{
				text: string
				field: string
				model: string
				provider: string
			}>('/api/v1/ai/complete', {
				prompt: action ? undefined : text,
				field: targetField || 'body',
				selectedText: selectedText || undefined,
				action: action || undefined,
			})

			const assistantMsg: ChatMessage = {
				id: crypto.randomUUID(),
				role: 'assistant',
				text: result.text,
				field: result.field,
				model: result.model,
				provider: result.provider,
			}
			setMessages((prev) => [...prev, assistantMsg])
		} catch (err) {
			setMessages((prev) => [
				...prev,
				{
					id: crypto.randomUUID(),
					role: 'assistant',
					text: `Error: ${err instanceof Error ? err.message : 'Failed'}`,
				},
			])
		} finally {
			setLoading(false)
		}
	}

	return (
		<div className="flex flex-col h-full border-l border-border bg-bg">
			{/* Header */}
			<div className="flex items-center justify-between px-4 py-3 border-b border-border">
				<div>
					<h3 className="text-sm font-semibold">AI Assistant</h3>
					{targetField && (
						<p className="text-[10px] text-text-secondary mt-0.5">
							Targeting: <span className="text-text-muted">{targetField}</span>
						</p>
					)}
				</div>
				<button
					type="button"
					onClick={onClose}
					className="text-text-secondary hover:text-text text-xs p-1"
				>
					Close
				</button>
			</div>

			{/* Messages */}
			<div className="flex-1 overflow-auto px-4 py-3 space-y-3">
				{messages.length === 0 && (
					<div className="text-center text-text-secondary text-xs py-8">
						<p>Select text in a field and use quick actions,</p>
						<p>or type a prompt below.</p>
					</div>
				)}
				{messages.map((msg) => (
					<div key={msg.id} className={msg.role === 'user' ? 'text-right' : ''}>
						{msg.role === 'user' ? (
							<div className="inline-block bg-surface-alt rounded-lg px-3 py-2 text-sm max-w-[85%] text-left">
								{msg.field && (
									<span className="text-[10px] text-text-secondary block mb-1">
										{msg.field}
									</span>
								)}
								{msg.text}
							</div>
						) : (
							<div className="space-y-2">
								<div className="bg-surface rounded-lg px-3 py-3 text-sm border border-border">
									{msg.field && (
										<div className="flex items-center justify-between mb-2">
											<span className="text-[10px] text-text-secondary">
												{msg.field}
											</span>
											<span className="text-[10px] text-text-muted">
												{msg.model}
											</span>
										</div>
									)}
									<pre className="whitespace-pre-wrap text-text-secondary text-sm leading-relaxed font-sans">
										{msg.text}
									</pre>
								</div>
								{msg.field && !msg.text.startsWith('Error:') && (
									<div className="flex gap-2">
										<button
											type="button"
											onClick={() => onApply(msg.field!, msg.text)}
											className="px-3 py-1 bg-btn-primary text-btn-primary-text rounded text-xs font-medium hover:bg-btn-primary-hover transition-colors"
										>
											Apply to {msg.field}
										</button>
										<button
											type="button"
											onClick={() => {
												navigator.clipboard.writeText(msg.text)
											}}
											className="px-3 py-1 bg-btn-secondary rounded text-xs hover:bg-btn-secondary-hover transition-colors"
										>
											Copy
										</button>
									</div>
								)}
							</div>
						)}
					</div>
				))}
				{loading && (
					<div className="flex gap-1 px-3 py-2">
						<span className="w-1.5 h-1.5 bg-text-muted rounded-full animate-pulse" />
						<span className="w-1.5 h-1.5 bg-text-muted rounded-full animate-pulse [animation-delay:150ms]" />
						<span className="w-1.5 h-1.5 bg-text-muted rounded-full animate-pulse [animation-delay:300ms]" />
					</div>
				)}
				<div ref={bottomRef} />
			</div>

			{/* Quick actions */}
			{selectedText && (
				<div className="px-4 py-2 border-t border-border flex flex-wrap gap-1.5">
					{[
						{ label: 'Rewrite', action: 'rewrite' },
						{ label: 'Shorter', action: 'shorter' },
						{ label: 'Longer', action: 'longer' },
						{ label: 'Fix Grammar', action: 'fix-grammar' },
						{ label: 'SEO', action: 'seo' },
					].map(({ label, action }) => (
						<button
							key={action}
							type="button"
							onClick={() => send(undefined, action)}
							disabled={loading}
							className="px-2.5 py-1 bg-btn-secondary rounded text-[11px] text-text-muted hover:bg-btn-secondary-hover hover:text-text-secondary disabled:opacity-50 transition-colors"
						>
							{label}
						</button>
					))}
				</div>
			)}

			{/* Input */}
			<div className="px-4 py-3 border-t border-border">
				<div className="flex gap-2">
					<textarea
						ref={inputRef}
						value={input}
						onChange={(e) => setInput(e.target.value)}
						onKeyDown={(e) => {
							if (e.key === 'Enter' && !e.shiftKey) {
								e.preventDefault()
								send()
							}
						}}
						placeholder="Ask AI to help..."
						rows={2}
						className="flex-1 px-3 py-2 bg-input border border-border rounded-lg text-sm resize-none focus:outline-none focus:border-border-strong"
					/>
					<button
						type="button"
						onClick={() => send()}
						disabled={loading || !input.trim()}
						className="px-3 self-end py-2 bg-btn-primary text-btn-primary-text rounded-lg text-xs font-medium hover:bg-btn-primary-hover disabled:opacity-30 transition-colors"
					>
						Send
					</button>
				</div>
			</div>
		</div>
	)
}
