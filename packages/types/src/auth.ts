export type UserRole = 'admin' | 'editor' | 'viewer'

export interface User {
	id: string
	email: string
	name: string
	role: UserRole
	createdAt: string
}

export interface ApiKey {
	id: string
	name: string
	keyPrefix: string
	userId: string
	permissions: string[]
	expiresAt: string | null
	createdAt: string
	lastUsedAt: string | null
}

export interface AuthSession {
	user: User
	token: string
	expiresAt: string
}
