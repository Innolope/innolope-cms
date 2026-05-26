import { createContext, type ReactNode, useCallback, useContext, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { getCsrfToken } from './api-client'
import { useAuth } from './auth'
import i18n, { SUPPORTED_UI_LOCALES, type UiLocale } from './i18n'

interface LocaleState {
	locale: UiLocale
	setLocale: (locale: UiLocale) => Promise<void>
}

const LocaleContext = createContext<LocaleState | null>(null)

function normalize(value: string | undefined | null): UiLocale {
	const head = (value ?? '').split('-')[0].toLowerCase()
	return (SUPPORTED_UI_LOCALES as readonly string[]).includes(head) ? (head as UiLocale) : 'en'
}

export function LocaleProvider({ children }: { children: ReactNode }) {
	const { i18n: i18nInstance } = useTranslation()
	const { user } = useAuth()
	const [locale, setLocaleState] = useState<UiLocale>(() => normalize(i18n.language))

	// Sync the chosen locale from the authenticated user's stored preference.
	// Server wins over the local detector once /me resolves.
	useEffect(() => {
		if (!user?.uiLocale) return
		const next = normalize(user.uiLocale)
		if (next !== locale) {
			setLocaleState(next)
			void i18nInstance.changeLanguage(next)
		}
	}, [user?.uiLocale, locale, i18nInstance])

	// Mirror i18next language changes (e.g. from external code) into local state.
	useEffect(() => {
		const onChange = (lng: string) => setLocaleState(normalize(lng))
		i18nInstance.on('languageChanged', onChange)
		return () => i18nInstance.off('languageChanged', onChange)
	}, [i18nInstance])

	const setLocale = useCallback(
		async (next: UiLocale) => {
			await i18nInstance.changeLanguage(next)
			setLocaleState(next)
			// The detector caches into localStorage automatically; persist to the
			// account so other devices/browsers pick up the same choice.
			if (user) {
				try {
					const csrf = getCsrfToken()
					await fetch('/api/v1/auth/profile', {
						method: 'PUT',
						credentials: 'include',
						headers: {
							'Content-Type': 'application/json',
							...(csrf ? { 'X-CSRF-Token': csrf } : {}),
						},
						body: JSON.stringify({ uiLocale: next }),
					})
				} catch {
					/* best effort — local change already applied */
				}
			}
		},
		[i18nInstance, user],
	)

	return <LocaleContext.Provider value={{ locale, setLocale }}>{children}</LocaleContext.Provider>
}

export function useLocale() {
	const ctx = useContext(LocaleContext)
	if (!ctx) throw new Error('useLocale must be used within LocaleProvider')
	return ctx
}
