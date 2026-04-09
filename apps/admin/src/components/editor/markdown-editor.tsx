import { useEditor, EditorContent } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import Image from '@tiptap/extension-image'
import Link from '@tiptap/extension-link'
import Placeholder from '@tiptap/extension-placeholder'
import TurndownService from 'turndown'
import { useCallback, useEffect, useRef, useState } from 'react'
import { ImagePickerModal } from './image-picker-modal'

const turndown = new TurndownService({
	headingStyle: 'atx',
	codeBlockStyle: 'fenced',
	bulletListMarker: '-',
})

// Improve turndown rules for cleaner markdown
turndown.addRule('strikethrough', {
	filter: ['del', 's'],
	replacement: (content) => `~~${content}~~`,
})

interface MarkdownEditorProps {
	content: string
	onChange: (markdown: string) => void
	placeholder?: string
}

export function MarkdownEditor({ content, onChange, placeholder }: MarkdownEditorProps) {
	const isInternalUpdate = useRef(false)

	const editor = useEditor({
		extensions: [
			StarterKit.configure({
				codeBlock: { HTMLAttributes: { class: 'bg-zinc-900 rounded-lg p-4 my-3' } },
			}),
			Image.configure({ inline: false, allowBase64: true }),
			Link.configure({ openOnClick: false }),
			Placeholder.configure({ placeholder: placeholder || 'Start writing...' }),
		],
		content: content ? htmlFromMarkdown(content) : '',
		editorProps: {
			attributes: {
				class:
					'prose prose-invert prose-zinc max-w-none min-h-[400px] focus:outline-none px-4 py-3',
			},
		},
		onUpdate: ({ editor }) => {
			if (isInternalUpdate.current) return
			const html = editor.getHTML()
			const md = turndown.turndown(html)
			onChange(md)
		},
	})

	useEffect(() => {
		if (editor && content) {
			const currentMd = turndown.turndown(editor.getHTML())
			if (currentMd !== content) {
				isInternalUpdate.current = true
				editor.commands.setContent(htmlFromMarkdown(content))
				isInternalUpdate.current = false
			}
		}
	}, [content, editor])

	const [showImagePicker, setShowImagePicker] = useState(false)

	const addImage = useCallback(() => {
		setShowImagePicker(true)
	}, [])

	const handleImageSelect = useCallback(
		(url: string, alt: string) => {
			if (editor) {
				editor.chain().focus().setImage({ src: url, alt }).run()
			}
		},
		[editor],
	)

	const addLink = useCallback(() => {
		const url = prompt('Link URL:')
		if (url && editor) {
			editor.chain().focus().setLink({ href: url }).run()
		}
	}, [editor])

	if (!editor) return null

	return (
		<div className="border border-zinc-800 rounded-lg overflow-hidden">
			<div className="flex flex-wrap gap-1 p-2 border-b border-zinc-800 bg-zinc-900/50">
				<ToolbarBtn
					active={editor.isActive('bold')}
					onClick={() => editor.chain().focus().toggleBold().run()}
					label="B"
					className="font-bold"
				/>
				<ToolbarBtn
					active={editor.isActive('italic')}
					onClick={() => editor.chain().focus().toggleItalic().run()}
					label="I"
					className="italic"
				/>
				<ToolbarBtn
					active={editor.isActive('strike')}
					onClick={() => editor.chain().focus().toggleStrike().run()}
					label="S"
					className="line-through"
				/>
				<div className="w-px bg-zinc-700 mx-1" />
				<ToolbarBtn
					active={editor.isActive('heading', { level: 1 })}
					onClick={() => editor.chain().focus().toggleHeading({ level: 1 }).run()}
					label="H1"
				/>
				<ToolbarBtn
					active={editor.isActive('heading', { level: 2 })}
					onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()}
					label="H2"
				/>
				<ToolbarBtn
					active={editor.isActive('heading', { level: 3 })}
					onClick={() => editor.chain().focus().toggleHeading({ level: 3 }).run()}
					label="H3"
				/>
				<div className="w-px bg-zinc-700 mx-1" />
				<ToolbarBtn
					active={editor.isActive('bulletList')}
					onClick={() => editor.chain().focus().toggleBulletList().run()}
					label="List"
				/>
				<ToolbarBtn
					active={editor.isActive('orderedList')}
					onClick={() => editor.chain().focus().toggleOrderedList().run()}
					label="1."
				/>
				<ToolbarBtn
					active={editor.isActive('blockquote')}
					onClick={() => editor.chain().focus().toggleBlockquote().run()}
					label="Quote"
				/>
				<ToolbarBtn
					active={editor.isActive('codeBlock')}
					onClick={() => editor.chain().focus().toggleCodeBlock().run()}
					label="Code"
				/>
				<div className="w-px bg-zinc-700 mx-1" />
				<ToolbarBtn active={false} onClick={addImage} label="Image" />
				<ToolbarBtn
					active={editor.isActive('link')}
					onClick={addLink}
					label="Link"
				/>
			</div>
			<EditorContent editor={editor} />
			{showImagePicker && (
				<ImagePickerModal
					onSelect={handleImageSelect}
					onClose={() => setShowImagePicker(false)}
				/>
			)}
		</div>
	)
}

function ToolbarBtn({
	active,
	onClick,
	label,
	className = '',
}: {
	active: boolean
	onClick: () => void
	label: string
	className?: string
}) {
	return (
		<button
			type="button"
			onClick={onClick}
			className={`px-2 py-1 rounded text-xs transition-colors ${
				active ? 'bg-zinc-700 text-white' : 'text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200'
			} ${className}`}
		>
			{label}
		</button>
	)
}

function htmlFromMarkdown(md: string): string {
	// Simple markdown → HTML for TipTap initialization
	// TipTap only needs basic HTML structure, not full rendering
	let html = md
		.replace(/^### (.+)$/gm, '<h3>$1</h3>')
		.replace(/^## (.+)$/gm, '<h2>$1</h2>')
		.replace(/^# (.+)$/gm, '<h1>$1</h1>')
		.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
		.replace(/\*(.+?)\*/g, '<em>$1</em>')
		.replace(/~~(.+?)~~/g, '<s>$1</s>')
		.replace(/`([^`]+)`/g, '<code>$1</code>')
		.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '<img src="$2" alt="$1" />')
		.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>')

	// Convert paragraphs (lines separated by blank lines)
	html = html
		.split('\n\n')
		.map((block) => {
			if (block.startsWith('<h') || block.startsWith('<img') || block.startsWith('<ul') || block.startsWith('<ol') || block.startsWith('<blockquote') || block.startsWith('<pre')) {
				return block
			}
			if (block.trim()) return `<p>${block.replace(/\n/g, '<br />')}</p>`
			return ''
		})
		.join('')

	return html
}
