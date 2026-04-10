import { createContext, useContext, useState, useEffect, type ReactNode } from 'react'

type Theme = 'light' | 'dark' | 'system'

interface ThemeState {
	theme: Theme
	setTheme: (theme: Theme) => void
}

const ThemeContext = createContext<ThemeState | null>(null)

function getSystemTheme(): 'light' | 'dark' {
	return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

function applyTheme(theme: Theme) {
	const resolved = theme === 'system' ? getSystemTheme() : theme
	document.documentElement.classList.toggle('dark', resolved === 'dark')
}

export function ThemeProvider({ children }: { children: ReactNode }) {
	const [theme, setTheme] = useState<Theme>(() => {
		return (localStorage.getItem('innolope_theme') as Theme) || 'system'
	})

	useEffect(() => {
		localStorage.setItem('innolope_theme', theme)
		applyTheme(theme)

		if (theme === 'system') {
			const mq = window.matchMedia('(prefers-color-scheme: dark)')
			const handler = () => applyTheme('system')
			mq.addEventListener('change', handler)
			return () => mq.removeEventListener('change', handler)
		}
	}, [theme])

	return (
		<ThemeContext.Provider value={{ theme, setTheme }}>
			{children}
		</ThemeContext.Provider>
	)
}

export function useTheme() {
	const ctx = useContext(ThemeContext)
	if (!ctx) throw new Error('useTheme must be used within ThemeProvider')
	return ctx
}
