import { createContext, useContext, useState, useEffect, type ReactNode } from 'react'

type Theme = 'light' | 'dark'

interface ThemeState {
	theme: Theme
	setTheme: (theme: Theme) => void
}

const ThemeContext = createContext<ThemeState | null>(null)

export function ThemeProvider({ children }: { children: ReactNode }) {
	const [theme, setTheme] = useState<Theme>(() => {
		return (localStorage.getItem('innolope_theme') as Theme) || 'light'
	})

	useEffect(() => {
		localStorage.setItem('innolope_theme', theme)
		document.documentElement.classList.toggle('dark', theme === 'dark')
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
