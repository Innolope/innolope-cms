import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AuthProvider, useAuth } from './auth'

function Harness() {
	const { user, loading, logout } = useAuth()
	return (
		<div>
			<span>{loading ? 'loading' : user?.email || 'signed-out'}</span>
			<button type="button" onClick={() => void logout()}>
				logout
			</button>
		</div>
	)
}

afterEach(() => {
	vi.unstubAllGlobals()
})

describe('AuthProvider logout', () => {
	it('waits for cookie revocation, clears the user, and never refreshes while logging out', async () => {
		const values = new Map<string, string>()
		vi.stubGlobal('localStorage', {
			getItem: (key: string) => values.get(key) ?? null,
			setItem: (key: string, value: string) => values.set(key, value),
			removeItem: (key: string) => values.delete(key),
			clear: () => values.clear(),
		})
		let finishLogout: ((response: Response) => void) | undefined
		const logoutResponse = new Promise<Response>((resolve) => {
			finishLogout = resolve
		})
		const fetchMock = vi.fn((input: RequestInfo | URL) => {
			const path = String(input)
			if (path.endsWith('/api/v1/auth/domain-context')) {
				return Promise.resolve(new Response('{}', { status: 404 }))
			}
			if (path.endsWith('/api/v1/auth/me')) {
				return Promise.resolve(
					Response.json({ id: 'u1', email: 'member@example.com', name: 'Member', role: 'editor' }),
				)
			}
			if (path.endsWith('/api/v1/projects')) return Promise.resolve(Response.json([]))
			if (path.endsWith('/api/v1/auth/logout')) return logoutResponse
			throw new Error(`Unexpected request: ${path}`)
		})
		vi.stubGlobal('fetch', fetchMock)

		render(
			<AuthProvider>
				<Harness />
			</AuthProvider>,
		)

		expect(await screen.findByText('member@example.com')).toBeInTheDocument()
		fireEvent.click(screen.getByRole('button', { name: 'logout' }))
		expect(await screen.findByText('loading')).toBeInTheDocument()

		finishLogout?.(Response.json({ message: 'Logged out' }))
		await waitFor(() => expect(screen.getByText('signed-out')).toBeInTheDocument())
		expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/auth/refresh'))).toBe(false)
	})
})
