import type { FirebaseOptions } from 'firebase/app'

export interface FirebaseGoogleConfig extends FirebaseOptions {
	apiKey: string
	authDomain: string
	projectId: string
	appId: string
}

let initialized = false

export async function firebaseGoogleIdToken(config: FirebaseGoogleConfig): Promise<string> {
	// Keep Firebase out of the main admin bundle; most self-hosted instances do
	// not enable Google auth, and even configured users only need it on click.
	const [{ getApp, getApps, initializeApp }, { getAuth, GoogleAuthProvider, signInWithPopup }] =
		await Promise.all([import('firebase/app'), import('firebase/auth')])
	const app = getApps().length > 0 ? getApp() : initializeApp(config)
	initialized = true
	const auth = getAuth(app)
	const provider = new GoogleAuthProvider()
	provider.setCustomParameters({ prompt: 'select_account' })
	const result = await signInWithPopup(auth, provider)
	return result.user.getIdToken()
}

export async function signOutFirebaseIfInitialized(): Promise<void> {
	if (!initialized) return
	const [{ getApp }, { getAuth, signOut }] = await Promise.all([
		import('firebase/app'),
		import('firebase/auth'),
	])
	await signOut(getAuth(getApp()))
}
