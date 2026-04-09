import { useState, useEffect, createContext, useContext, type ReactNode } from 'react'
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

const LicenseContext = createContext<LicenseInfo>({
	valid: false,
	plan: 'community',
	org: null,
	features: [],
	maxProjects: 1,
	expiresAt: null,
	cloudMode: false,
})

export function LicenseProvider({ children }: { children: ReactNode }) {
	const [license, setLicense] = useState<LicenseInfo>({
		valid: false,
		plan: 'community',
		org: null,
		features: [],
		maxProjects: 1,
		expiresAt: null,
		cloudMode: false,
	})

	useEffect(() => {
		api.get<LicenseInfo>('/api/v1/license')
			.then(setLicense)
			.catch(() => {})
	}, [])

	return <LicenseContext.Provider value={license}>{children}</LicenseContext.Provider>
}

export function useLicense() {
	return useContext(LicenseContext)
}

export function hasFeature(license: LicenseInfo, feature: string): boolean {
	return license.features.includes(feature)
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

	return <UpgradePrompt feature={featureLabel} plan={feature === 'ai-assistant' ? 'Pro' : 'Enterprise'} />
}

export function UpgradePrompt({ feature, plan = 'Pro' }: { feature: string; plan?: string }) {
	return (
		<div className="flex flex-col items-center justify-center py-12 px-6 text-center">
			<div className="w-12 h-12 bg-zinc-100 rounded-xl flex items-center justify-center mb-4">
				<span className="text-2xl">✨</span>
			</div>
			<h3 className="text-lg font-semibold mb-2">{feature}</h3>
			<p className="text-sm text-zinc-500 max-w-sm mb-6">
				This feature requires an Innolope CMS {plan} license.
				{plan === 'Pro'
					? ' Unlock AI writing, webhooks, and content scheduling.'
					: ' Unlock SSO, audit logs, custom roles, and more.'}
			</p>
			<a
				href="https://innolope.dev/pricing"
				target="_blank"
				rel="noopener noreferrer"
				className="px-6 py-2.5 bg-zinc-900 text-white rounded-lg text-sm font-medium hover:bg-zinc-200 transition-colors"
			>
				View Plans
			</a>
		</div>
	)
}
