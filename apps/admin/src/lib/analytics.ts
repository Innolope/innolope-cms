const MEASUREMENT_ID = import.meta.env.VITE_GA_MEASUREMENT_ID

declare global {
	interface Window {
		dataLayer: unknown[]
		gtag: (...args: unknown[]) => void
	}
}

export function initAnalytics() {
	if (!MEASUREMENT_ID) return

	const script = document.createElement('script')
	script.async = true
	script.src = `https://www.googletagmanager.com/gtag/js?id=${MEASUREMENT_ID}`
	document.head.appendChild(script)

	window.dataLayer = window.dataLayer || []
	window.gtag = function gtag() {
		// biome-ignore lint/complexity/noArguments: GA's gtag relies on the live `arguments` object.
		window.dataLayer.push(arguments)
	}
	window.gtag('js', new Date())
	window.gtag('config', MEASUREMENT_ID, { send_page_view: false })
}

export function trackPageView(path: string) {
	if (!MEASUREMENT_ID || typeof window.gtag !== 'function') return
	window.gtag('event', 'page_view', { page_path: path })
}
