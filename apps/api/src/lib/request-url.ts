/** Capability URLs must be useful in diagnostics without exporting their secret. */
export function redactRequestUrl(url: string): string {
	return url.replace(/([?&])([^=&#]+)=([^&#]*)/g, (pair, delimiter: string, key: string) => {
		let name: string
		try {
			name = decodeURIComponent(key.replace(/\+/g, ' '))
		} catch {
			return pair
		}
		return name.toLowerCase() === 'token' ? `${delimiter}${key}=[REDACTED]` : pair
	})
}

/** Sentry also captures the incoming request independently of explicit extras. */
export function redactTelemetryRequest(request?: { url?: string; query_string?: unknown }) {
	if (!request) return
	if (request.url) request.url = redactRequestUrl(request.url)
	if (typeof request.query_string === 'string') {
		request.query_string = redactRequestUrl(`?${request.query_string}`).slice(1)
	} else if (Array.isArray(request.query_string)) {
		request.query_string = request.query_string.map(([key, value]) => [
			key,
			String(key).toLowerCase() === 'token' ? '[REDACTED]' : value,
		])
	} else if (request.query_string && typeof request.query_string === 'object') {
		request.query_string = Object.fromEntries(
			Object.entries(request.query_string).map(([key, value]) => [
				key,
				key.toLowerCase() === 'token' ? '[REDACTED]' : value,
			]),
		)
	}
}
