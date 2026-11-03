import DOMPurify from 'dompurify'
import { marked } from 'marked'

export interface PreviewTemplateData {
	html: string
	classMap: Record<string, string>
}

export interface PreviewContent {
	title: string
	markdown: string
	imageUrl?: string | null
	imageAlt?: string | null
	locale?: string | null
}

const SLOT = '[data-innolope-slot]'
const CSP =
	"default-src 'none'; img-src * data: blob:; media-src * data: blob:; style-src * 'unsafe-inline' data:; font-src * data:; script-src 'none'; object-src 'none'; frame-src 'none'; form-action 'none'; connect-src 'none'"

export function buildPreviewDocument(
	template: PreviewTemplateData,
	content: PreviewContent,
): string {
	const doc = new DOMParser().parseFromString(template.html, 'text/html')
	const csp = doc.createElement('meta')
	csp.httpEquiv = 'Content-Security-Policy'
	csp.content = CSP
	doc.head.prepend(csp)
	const referrer = doc.createElement('meta')
	referrer.name = 'referrer'
	referrer.content = 'no-referrer'
	for (const old of doc.querySelectorAll('meta[name]')) {
		if (old.getAttribute('name')?.toLowerCase() === 'referrer') old.remove()
	}
	csp.after(referrer)
	const bases = Array.from(doc.querySelectorAll('base'))
	const base = bases.shift() ?? doc.createElement('base')
	for (const extra of bases) extra.remove()
	base.target = '_blank'
	if (!base.parentNode) doc.head.append(base)
	fillPreviewSlots(doc, template.classMap, content)
	return `${doc.doctype ? '<!DOCTYPE html>' : ''}${doc.documentElement.outerHTML}`
}

export function fillPreviewSlots(
	doc: Document,
	classMap: Record<string, string>,
	content: PreviewContent,
): void {
	const title = doc.querySelector('[data-innolope-slot="title"]')
	if (title) title.textContent = content.title
	doc.title = content.title
	if (content.locale) doc.documentElement.lang = content.locale
	const body = doc.querySelector('[data-innolope-slot="body"]')
	if (body) {
		const rendered = doc.createElement('template')
		rendered.innerHTML = DOMPurify.sanitize(
			marked.parse(content.markdown, { async: false, gfm: true }),
			{
				FORBID_TAGS: [
					'script',
					'style',
					'iframe',
					'object',
					'embed',
					'form',
					'base',
					'meta',
					'link',
				],
				FORBID_ATTR: ['data-innolope-slot'],
			},
		)
		for (const el of rendered.content.querySelectorAll('*')) {
			const tag = el.tagName.toLowerCase()
			if (classMap[tag] && !(tag === 'code' && el.closest('pre'))) {
				el.setAttribute('class', classMap[tag])
			}
		}
		for (const child of Array.from(body.childNodes)) {
			if (child.nodeType === 1) {
				const el = child as Element
				if (el.matches(SLOT) || el.querySelector(SLOT)) continue
			}
			child.remove()
		}
		body.append(rendered.content)
	}
	const image = doc.querySelector('[data-innolope-slot="image"]')
	if (image) {
		for (const attr of Array.from(image.attributes)) {
			if (/^(srcset|sizes|data-src.*|data-lazy-src|data-original)$/i.test(attr.name)) {
				image.removeAttribute(attr.name)
			}
		}
		for (const source of image.closest('picture')?.querySelectorAll('source') ?? []) source.remove()
		const safeImage =
			content.imageUrl &&
			!/^(javascript:|vbscript:|data:text\/html)/i.test(
				Array.from(content.imageUrl)
					.filter((char) => char.charCodeAt(0) > 32 && !/\s/.test(char))
					.join(''),
			)
		if (safeImage && content.imageUrl) {
			image.setAttribute('src', content.imageUrl)
			image.setAttribute('alt', content.imageAlt ?? content.title)
			for (const hidden of doc.querySelectorAll('[data-innolope-image-hidden]')) {
				hidden.removeAttribute('hidden')
				hidden.removeAttribute('data-innolope-image-hidden')
			}
		} else {
			image.removeAttribute('src')
			const box = imageBox(image)
			box.setAttribute('hidden', '')
			box.setAttribute('data-innolope-image-hidden', '')
		}
	}
}

/**
 * What to hide when the record has no cover: the image plus wrappers that exist
 * only to frame it (`<figure>` with its caption, `<picture>`, a link or div around
 * it), so the page doesn't keep an empty, styled box where the sample's image was.
 * Stops at anything holding other content or another slot.
 */
function imageBox(image: Element): Element {
	let box = image
	while (box.parentElement && !box.parentElement.matches('body, main, article')) {
		const parent: Element = box.parentElement
		if (parent.matches(SLOT)) break
		const others = Array.from(parent.children).filter(
			(child) => child !== box && !child.matches('source, figcaption'),
		)
		const ownText = Array.from(parent.childNodes)
			.filter((node) => node.nodeType === 3)
			.some((node) => node.textContent?.trim())
		if (others.length > 0 || ownText) break
		box = parent
	}
	return box
}
