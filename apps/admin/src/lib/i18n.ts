import i18n from 'i18next'
import LanguageDetector from 'i18next-browser-languagedetector'
import { initReactI18next } from 'react-i18next'
import enCommon from '../locales/en/common.json'
import ukCommon from '../locales/uk/common.json'

export const SUPPORTED_UI_LOCALES = ['en', 'uk'] as const
export type UiLocale = (typeof SUPPORTED_UI_LOCALES)[number]
export const UI_LOCALE_STORAGE_KEY = 'innolope_ui_locale'

i18n
	.use(LanguageDetector)
	.use(initReactI18next)
	.init({
		resources: {
			en: { common: enCommon },
			uk: { common: ukCommon },
		},
		fallbackLng: 'en',
		supportedLngs: [...SUPPORTED_UI_LOCALES],
		// Collapses `uk-UA`/`en-US` → `uk`/`en` so the navigator-language fallback
		// matches an actual resource bundle.
		nonExplicitSupportedLngs: true,
		ns: ['common'],
		defaultNS: 'common',
		interpolation: { escapeValue: false },
		detection: {
			order: ['localStorage', 'navigator', 'htmlTag'],
			lookupLocalStorage: UI_LOCALE_STORAGE_KEY,
			caches: ['localStorage'],
		},
	})

export default i18n
