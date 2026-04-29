const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' })

const UNITS: Array<{ unit: Intl.RelativeTimeFormatUnit; ms: number }> = [
	{ unit: 'year', ms: 365.25 * 24 * 60 * 60 * 1000 },
	{ unit: 'month', ms: 30 * 24 * 60 * 60 * 1000 },
	{ unit: 'week', ms: 7 * 24 * 60 * 60 * 1000 },
	{ unit: 'day', ms: 24 * 60 * 60 * 1000 },
	{ unit: 'hour', ms: 60 * 60 * 1000 },
	{ unit: 'minute', ms: 60 * 1000 },
]

export function relativeTime(input: string | number | Date): string {
	const d = input instanceof Date ? input : new Date(input)
	const diffMs = d.getTime() - Date.now()
	const abs = Math.abs(diffMs)
	if (abs < 60_000) return 'just now'
	for (const { unit, ms } of UNITS) {
		if (abs >= ms) return rtf.format(Math.round(diffMs / ms), unit)
	}
	return rtf.format(Math.round(diffMs / 1000), 'second')
}

export function absoluteDate(input: string | number | Date): string {
	const d = input instanceof Date ? input : new Date(input)
	return d.toLocaleString()
}
