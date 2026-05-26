import i18n from './i18n'

const UNITS: Array<{ unit: Intl.RelativeTimeFormatUnit; ms: number }> = [
	{ unit: 'year', ms: 365.25 * 24 * 60 * 60 * 1000 },
	{ unit: 'month', ms: 30 * 24 * 60 * 60 * 1000 },
	{ unit: 'week', ms: 7 * 24 * 60 * 60 * 1000 },
	{ unit: 'day', ms: 24 * 60 * 60 * 1000 },
	{ unit: 'hour', ms: 60 * 60 * 1000 },
	{ unit: 'minute', ms: 60 * 1000 },
]

function currentLocale() {
	return i18n.language || 'en'
}

export function relativeTime(input: string | number | Date): string {
	const d = input instanceof Date ? input : new Date(input)
	const diffMs = d.getTime() - Date.now()
	const abs = Math.abs(diffMs)
	if (abs < 60_000) return i18n.t('common.time.justNow')
	const rtf = new Intl.RelativeTimeFormat(currentLocale(), { numeric: 'auto' })
	for (const { unit, ms } of UNITS) {
		if (abs >= ms) return rtf.format(Math.round(diffMs / ms), unit)
	}
	return rtf.format(Math.round(diffMs / 1000), 'second')
}

export function absoluteDate(input: string | number | Date): string {
	const d = input instanceof Date ? input : new Date(input)
	return d.toLocaleString(currentLocale())
}
