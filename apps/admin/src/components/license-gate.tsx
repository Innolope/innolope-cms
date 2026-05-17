import { createContext, type ReactNode, useCallback, useContext, useEffect, useState } from 'react'
import { api } from '../lib/api-client'

interface LicenseInfo {
	valid: boolean
	plan: 'community' | 'pro' | 'enterprise'
	org: string | null
	features: string[]
	maxProjects: number
	expiresAt: string | null
	cloudMode: boolean
}

type LicenseContextValue = LicenseInfo & {
	// Re-fetches license info — call after activating/removing a key so gating updates live.
	refreshLicense: () => Promise<void>
}

const COMMUNITY_LICENSE: LicenseInfo = {
	valid: false,
	plan: 'community',
	org: null,
	features: [],
	maxProjects: 1,
	expiresAt: null,
	cloudMode: false,
}

// Features that belong to the Pro tier; everything else gated is Enterprise.
const PRO_FEATURES = new Set(['ai-assistant', 'media-integrations'])

const LicenseContext = createContext<LicenseContextValue>({
	...COMMUNITY_LICENSE,
	refreshLicense: async () => {},
})

export function LicenseProvider({ children }: { children: ReactNode }) {
	const [license, setLicense] = useState<LicenseInfo>(COMMUNITY_LICENSE)

	const refreshLicense = useCallback(async () => {
		// Intentional swallow: on failure we keep the safe community defaults already in
		// state. Paid features stay gated, so a failed check never grants extra access.
		try {
			setLicense(await api.get<LicenseInfo>('/api/v1/license'))
		} catch {
			// keep current state
		}
	}, [])

	useEffect(() => {
		refreshLicense()
	}, [refreshLicense])

	return (
		<LicenseContext.Provider value={{ ...license, refreshLicense }}>
			{children}
		</LicenseContext.Provider>
	)
}

export function useLicense() {
	return useContext(LicenseContext)
}

export function hasFeature(license: { features: string[] }, feature: string): boolean {
	return license.features.includes(feature)
}

export function planForFeature(feature: string): 'Pro' | 'Enterprise' {
	return PRO_FEATURES.has(feature) ? 'Pro' : 'Enterprise'
}

// Gate component — shows children if licensed, upgrade prompt if not
export function LicenseGate({
	feature,
	featureLabel,
	children,
}: {
	feature: string
	featureLabel: string
	children: ReactNode
}) {
	const license = useLicense()

	if (hasFeature(license, feature)) {
		return <>{children}</>
	}

	return <UpgradePrompt feature={featureLabel} plan={planForFeature(feature)} />
}

export function ProBadge() {
	return (
		<span className="ml-1.5 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide bg-gradient-to-r from-violet-500 to-purple-500 text-white rounded">
			Pro
		</span>
	)
}

export function UpgradePrompt({ feature, plan = 'Pro' }: { feature: string; plan?: string }) {
	return (
		<div className="flex flex-col items-center justify-center py-12 px-6 text-center">
			<div className="w-12 h-12 bg-surface-alt rounded-xl flex items-center justify-center mb-4">
				<span className="text-2xl">✨</span>
			</div>
			<h3 className="text-lg font-semibold mb-2">{feature}</h3>
			<p className="text-sm text-text-secondary max-w-sm mb-6">
				This feature requires an Innolope CMS {plan} license.
				{plan === 'Pro'
					? ' Unlock AI writing, the media library, webhooks, and multiple projects support.'
					: ' Unlock SSO, audit logs, custom roles, and more.'}
			</p>
			<a
				href="https://innolope.com/apps/cms#pricing"
				target="_blank"
				rel="noopener noreferrer"
				className="px-6 py-2.5 bg-btn-primary text-btn-primary-text rounded-lg text-sm font-medium hover:bg-btn-primary-hover transition-colors"
			>
				View Plans
			</a>
		</div>
	)
}
