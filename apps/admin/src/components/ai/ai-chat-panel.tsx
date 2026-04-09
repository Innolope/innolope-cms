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
		<div className="flex flex-col h-full border-l border-zinc-200 bg-zinc-50">
			{/* Header */}
			<div className="flex items-center justify-between px-4 py-3 border-b border-zinc-200">
				<div>
					<h3 className="text-sm font-semibold">AI Assistant</h3>
					{targetField && (
						<p className="text-[10px] text-zinc-500 mt-0.5">
							Targeting: <span className="text-zinc-400">{targetField}</span>
						</p>
					)}
				</div>
				<button
					type="button"
					onClick={onClose}
					className="text-zinc-600 hover:text-zinc-600 text-xs p-1"
				>
					Close
				</button>
			</div>

			{/* Messages */}
			<div className="flex-1 overflow-auto px-4 py-3 space-y-3">
				{messages.length === 0 && (
					<div className="text-center text-zinc-600 text-xs py-8">
						<p>Select text in a field and use quick actions,</p>
						<p>or type a prompt below.</p>
					</div>
				)}
				{messages.map((msg) => (
					<div key={msg.id} className={msg.role === 'user' ? 'text-right' : ''}>
						{msg.role === 'user' ? (
							<div className="inline-block bg-zinc-100 rounded-lg px-3 py-2 text-sm max-w-[85%] text-left">
								{msg.field && (
									<span className="text-[10px] text-zinc-500 block mb-1">
										{msg.field}
									</span>
								)}
								{msg.text}
							</div>
						) : (
							<div className="space-y-2">
								<div className="bg-white rounded-lg px-3 py-3 text-sm border border-zinc-200">
									{msg.field && (
										<div className="flex items-center justify-between mb-2">
											<span className="text-[10px] text-zinc-500">
												{msg.field}
											</span>
											<span className="text-[10px] text-zinc-600">
												{msg.model}
											</span>
										</div>
									)}
									<pre className="whitespace-pre-wrap text-zinc-300 text-sm leading-relaxed font-sans">
										{msg.text}
									</pre>
								</div>
								{msg.field && !msg.text.startsWith('Error:') && (
									<div className="flex gap-2">
										<button
											type="button"
											onClick={() => onApply(msg.field!, msg.text)}
											className="px-3 py-1 bg-zinc-900 text-white rounded text-xs font-medium hover:bg-zinc-200 transition-colors"
										>
											Apply to {msg.field}
										</button>
										<button
											type="button"
											onClick={() => {
												navigator.clipboard.writeText(msg.text)
											}}
											className="px-3 py-1 bg-zinc-100 rounded text-xs hover:bg-zinc-200 transition-colors"
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
						<span className="w-1.5 h-1.5 bg-zinc-600 rounded-full animate-pulse" />
						<span className="w-1.5 h-1.5 bg-zinc-600 rounded-full animate-pulse [animation-delay:150ms]" />
						<span className="w-1.5 h-1.5 bg-zinc-600 rounded-full animate-pulse [animation-delay:300ms]" />
					</div>
				)}
				<div ref={bottomRef} />
			</div>

			{/* Quick actions */}
			{selectedText && (
				<div className="px-4 py-2 border-t border-zinc-200 flex flex-wrap gap-1.5">
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
							className="px-2.5 py-1 bg-zinc-100 rounded text-[11px] text-zinc-400 hover:bg-zinc-200 hover:text-zinc-300 disabled:opacity-50 transition-colors"
						>
							{label}
						</button>
					))}
				</div>
			)}

			{/* Input */}
			<div className="px-4 py-3 border-t border-zinc-200">
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
						className="flex-1 px-3 py-2 bg-white border border-zinc-200 rounded-lg text-sm resize-none focus:outline-none focus:border-zinc-600"
					/>
					<button
						type="button"
						onClick={() => send()}
						disabled={loading || !input.trim()}
						className="px-3 self-end py-2 bg-zinc-900 text-white rounded-lg text-xs font-medium hover:bg-zinc-800 disabled:opacity-30 transition-colors"
					>
						Send
					</button>
				</div>
			</div>
		</div>
	)
}
