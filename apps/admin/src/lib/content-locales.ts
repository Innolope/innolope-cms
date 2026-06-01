/** Curated set of common content locale codes offered in the locale pickers. */
export const CONTENT_LOCALES = [
	// Western & Northern Europe
	'en',
	'en-GB',
	'en-US',
	'es',
	'es-MX',
	'es-AR',
	'pt',
	'pt-BR',
	'pt-PT',
	'fr',
	'fr-CA',
	'de',
	'de-AT',
	'de-CH',
	'it',
	'nl',
	'nl-BE',
	'ca',
	'gl',
	'eu',
	'sv',
	'da',
	'fi',
	'nb',
	'nn',
	'is',
	'ga',
	'cy',
	'mt',
	// Central & Eastern Europe, Baltics
	'uk',
	'ru',
	'be',
	'pl',
	'cs',
	'sk',
	'sl',
	'hr',
	'sr',
	'bs',
	'bg',
	'mk',
	'sq',
	'ro',
	'el',
	'hu',
	'lt',
	'lv',
	'et',
	// Caucasus & Central Asia
	'hy',
	'ka',
	'az',
	'kk',
	'ky',
	'uz',
	'mn',
	// Middle East
	'tr',
	'ar',
	'he',
	'fa',
	'ku',
	'ur',
	// South Asia
	'hi',
	'bn',
	'pa',
	'gu',
	'mr',
	'ta',
	'te',
	'kn',
	'ml',
	'ne',
	'si',
	// Southeast & East Asia
	'zh',
	'zh-TW',
	'zh-HK',
	'ja',
	'ko',
	'th',
	'vi',
	'id',
	'ms',
	'fil',
	'km',
	'lo',
	'my',
	// Africa
	'sw',
	'am',
	'ha',
	'yo',
	'ig',
	'zu',
	'af',
] as const

const displayNamesCache = new Map<string, Intl.DisplayNames | null>()

function displayNamesFor(uiLang: string): Intl.DisplayNames | null {
	if (!displayNamesCache.has(uiLang)) {
		try {
			displayNamesCache.set(uiLang, new Intl.DisplayNames([uiLang], { type: 'language' }))
		} catch {
			displayNamesCache.set(uiLang, null)
		}
	}
	return displayNamesCache.get(uiLang) ?? null
}

/** Human-readable label for a locale code, e.g. "English (en)". Falls back to the raw code. */
export function localeLabel(code: string, uiLang?: string): string {
	const dn = displayNamesFor(uiLang || 'en')
	let name: string | undefined
	try {
		name = dn?.of(code)
	} catch {
		name = undefined
	}
	return name && name !== code ? `${name} (${code})` : code
}
