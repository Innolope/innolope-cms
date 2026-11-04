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
	inlineSvgUses(doc, base.getAttribute('href'))
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

const SVG_NS = 'http://www.w3.org/2000/svg'
const XLINK_NS = 'http://www.w3.org/1999/xlink'
/** Enough for any icon set; a page repeating a large sprite can't balloon the preview. */
const MAX_INLINED_USES = 500

/** The id a `<use>` reference names when it points into the page itself, else null. */
function sameDocumentId(ref: string | null, pageUrl: string | null): string | null {
	const value = ref?.trim()
	if (!value) return null
	try {
		const url = new URL(value, pageUrl ?? 'about:blank')
		if (!url.hash) return null
		if (!value.startsWith('#') && (!pageUrl || url.href.split('#')[0] !== pageUrl.split('#')[0]))
			return null
		return decodeURIComponent(url.hash.slice(1))
	} catch {
		return null
	}
}

/**
 * `<use href="#icon">` shows an element defined elsewhere in the page. With the
 * preview's `<base>` pointing at the live site, browsers look for it there instead
 * (the capture also writes the reference out in full), and the frame may not load
 * it, so the icon goes blank. Replace each one with a copy of what it shows.
 */
function inlineSvgUses(doc: Document, pageUrl: string | null): void {
	let inlined = 0
	// A symbol can use another symbol; a few passes cover real icon sets and stop loops.
	for (let pass = 0; pass < 3; pass++) {
		const uses = Array.from(doc.getElementsByTagNameNS(SVG_NS, 'use'))
		let changed = false
		for (const use of uses) {
			if (inlined >= MAX_INLINED_USES) return
			const id = sameDocumentId(
				use.getAttribute('href') ?? use.getAttributeNS(XLINK_NS, 'href'),
				pageUrl,
			)
			const target = id ? doc.getElementById(id) : null
			if (!target || target.contains(use) || target.namespaceURI !== SVG_NS) continue

			const symbol = target.localName === 'symbol'
			const copy = doc.createElementNS(SVG_NS, symbol ? 'svg' : 'g')
			// The <use>'s own class, fill and style still apply to what it showed.
			for (const attr of Array.from(use.attributes)) {
				if (!/^(href|xlink:href|x|y|width|height)$/i.test(attr.name))
					copy.setAttribute(attr.name, attr.value)
			}
			const x = use.getAttribute('x') ?? '0'
			const y = use.getAttribute('y') ?? '0'
			if (symbol) {
				for (const name of ['viewBox', 'preserveAspectRatio']) {
					const value = target.getAttribute(name)
					if (value !== null) copy.setAttribute(name, value)
				}
				copy.setAttribute('x', x)
				copy.setAttribute('y', y)
				copy.setAttribute('width', use.getAttribute('width') ?? '100%')
				copy.setAttribute('height', use.getAttribute('height') ?? '100%')
				for (const child of Array.from(target.childNodes)) copy.append(child.cloneNode(true))
			} else {
				if (x !== '0' || y !== '0') {
					const own = use.getAttribute('transform')
					copy.setAttribute('transform', `${own ? `${own} ` : ''}translate(${x} ${y})`)
				}
				const clone = target.cloneNode(true) as Element
				clone.removeAttribute('id')
				copy.append(clone)
			}
			use.replaceWith(copy)
			inlined++
			changed = true
		}
		if (!changed) return
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
