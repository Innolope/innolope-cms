import { applicationDefault, cert, getApps, initializeApp } from 'firebase-admin/app'
import { getAuth } from 'firebase-admin/auth'

export interface FirebaseWebConfig {
	apiKey: string
	authDomain: string
	projectId: string
	appId: string
	messagingSenderId?: string
	storageBucket?: string
}

let cachedWebConfig: FirebaseWebConfig | null | undefined

/**
 * Firebase's web configuration is public by design, but keeping it in one
 * runtime environment variable lets the same pre-built admin image run in
 * multiple installations. Google login stays hidden when it is not configured.
 */
export function firebaseWebConfig(): FirebaseWebConfig | null {
	if (cachedWebConfig !== undefined) return cachedWebConfig
	const raw = process.env.FIREBASE_WEB_CONFIG
	if (!raw?.trim()) {
		cachedWebConfig = null
		return null
	}

	try {
		const value = JSON.parse(raw) as Partial<FirebaseWebConfig>
		if (
			typeof value.apiKey !== 'string' ||
			!value.apiKey ||
			typeof value.authDomain !== 'string' ||
			!value.authDomain ||
			typeof value.projectId !== 'string' ||
			!value.projectId ||
			typeof value.appId !== 'string' ||
			!value.appId
		) {
			cachedWebConfig = null
			return null
		}
		new URL(value.authDomain.startsWith('http') ? value.authDomain : `https://${value.authDomain}`)
		cachedWebConfig = {
			apiKey: value.apiKey,
			authDomain: value.authDomain,
			projectId: value.projectId,
			appId: value.appId,
			...(typeof value.messagingSenderId === 'string'
				? { messagingSenderId: value.messagingSenderId }
				: {}),
			...(typeof value.storageBucket === 'string' ? { storageBucket: value.storageBucket } : {}),
		}
		return cachedWebConfig
	} catch {
		cachedWebConfig = null
		return null
	}
}

function firebaseServerApp() {
	const existing = getApps().find((app) => app.name === '[DEFAULT]')
	if (existing) return existing

	const webConfig = firebaseWebConfig()
	const rawServiceAccount = process.env.FIREBASE_SERVICE_ACCOUNT_JSON
	if (rawServiceAccount?.trim()) {
		let serviceAccount: Record<string, unknown>
		try {
			serviceAccount = JSON.parse(rawServiceAccount) as Record<string, unknown>
		} catch {
			throw new Error('FIREBASE_SERVICE_ACCOUNT_JSON is not valid JSON')
		}
		return initializeApp({
			credential: cert(serviceAccount),
			projectId: webConfig?.projectId,
		})
	}

	// Application Default Credentials covers Cloud Run/GCP and the standard
	// GOOGLE_APPLICATION_CREDENTIALS development setup.
	return initializeApp({
		credential: applicationDefault(),
		projectId: webConfig?.projectId ?? process.env.FIREBASE_PROJECT_ID,
	})
}

export async function verifyFirebaseGoogleToken(idToken: string): Promise<{
	email: string
	name: string
}> {
	if (!firebaseWebConfig()) throw new Error('Google sign-in is not configured')
	const decoded = await getAuth(firebaseServerApp()).verifyIdToken(idToken, true)
	if (!decoded.email || decoded.email_verified !== true) {
		throw new Error('Google account email is not verified')
	}
	if (decoded.firebase?.sign_in_provider !== 'google.com') {
		throw new Error('Expected a Google sign-in token')
	}
	return {
		email: decoded.email,
		name: decoded.name?.trim() || decoded.email.split('@')[0],
	}
}
