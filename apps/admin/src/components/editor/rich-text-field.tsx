/**
 * A field the source stores as rich-text editor state (Lexical, Editor.js,
 * Portable Text, Slate), edited as markdown.
 *
 * The API converts the stored document to markdown when every block it uses
 * converts losslessly, and converts the edited markdown back into the field's
 * own format on save. When the document uses blocks it cannot represent —
 * embeds, columns, tables, custom components — the field shows a read-only
 * preview and says why: a locked, readable preview is better than a JSON
 * textarea, and far better than an edit that would drop those blocks.
 */

import { detectRichTextFormat } from '@innolope/config'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { api } from '../../lib/api-client'
import { MarkdownEditor } from './markdown-editor'

export type RichTextConversion =
	| { format: string; markdown: string }
	| { format: string; unsupported: string; preview: string }

/** Convert stored editor state to markdown (or a preview) through the API. */
export function useRichTextConversion(value: unknown): RichTextConversion | null {
	const [state, setState] = useState<{ key: string; result: RichTextConversion | null } | null>(
		null,
	)
	const isState =
		value !== null && typeof value === 'object' && Boolean(detectRichTextFormat(value))
	const key = isState ? JSON.stringify(value) : ''
	useEffect(() => {
		if (!key) return
		let cancelled = false
		api
			.post<RichTextConversion>('/api/v1/content/rich-text/markdown', { value: JSON.parse(key) })
			.then((result) => {
				if (!cancelled) setState({ key, result })
			})
			.catch(() => {
				if (!cancelled) setState({ key, result: null })
			})
		return () => {
			cancelled = true
		}
	}, [key])
	return state?.key === key ? state.result : null
}

export function RichTextPreview({
	conversion,
}: {
	conversion: { unsupported: string; preview: string }
}) {
	const { t } = useTranslation()
	return (
		<div className="space-y-1.5">
			<p className="text-xs text-text-muted">
				{t('editor.richText.unsupported', { what: conversion.unsupported })}
			</p>
			<div className="max-h-96 overflow-auto whitespace-pre-wrap rounded border border-border bg-surface-alt px-3 py-2 text-sm text-text-secondary">
				{conversion.preview || t('editor.richText.empty')}
			</div>
		</div>
	)
}

export function RichTextField({
	value,
	onChange,
	disabled,
}: {
	value: unknown
	onChange: (value: unknown) => void
	disabled?: boolean
}) {
	const { t } = useTranslation()
	const conversion = useRichTextConversion(value)
	// Once edited, the value is the markdown the API will convert on save.
	if (typeof value === 'string' || value === null || value === undefined) {
		return (
			<div className="rounded border border-border bg-input px-3 py-2">
				<MarkdownEditor content={typeof value === 'string' ? value : ''} onChange={onChange} />
			</div>
		)
	}
	if (!conversion) {
		return <p className="text-xs text-text-muted">{t('editor.richText.loading')}</p>
	}
	if ('unsupported' in conversion) return <RichTextPreview conversion={conversion} />
	if (disabled) {
		return (
			<div className="whitespace-pre-wrap rounded border border-border bg-surface-alt px-3 py-2 text-sm text-text-secondary">
				{conversion.markdown}
			</div>
		)
	}
	return (
		<div className="rounded border border-border bg-input px-3 py-2">
			<MarkdownEditor content={conversion.markdown} onChange={onChange} />
		</div>
	)
}
