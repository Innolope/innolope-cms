import { createContext, type ReactNode, useCallback, useContext, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
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
	const { t } = useTranslation()
	return (
		<span className="ml-1.5 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide bg-gradient-to-r from-violet-500 to-purple-500 text-white rounded">
			{t('licenseGate.proBadge')}
		</span>
	)
}

export function UpgradePrompt({ feature, plan = 'Pro' }: { feature: string; plan?: string }) {
	const { t } = useTranslation()
	return (
		// `pt-32` pushes the block down so it doesn't crowd the Save button above.
		<div className="flex flex-col items-center justify-center pt-32 pb-12 px-6 text-center">
			{/* Outlined "sparkles" icon (Lucide), violet to tie in with the Pro accent.
			    No background container — the icon sits directly on the panel. */}
			<svg
				width="26"
				height="26"
				viewBox="0 0 24 24"
				fill="none"
				stroke="currentColor"
				strokeWidth="1.75"
				strokeLinecap="round"
				strokeLinejoin="round"
				className="text-violet-500 mb-4"
				aria-hidden="true"
			>
				<path d="M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z" />
				<path d="M20 3v4" />
				<path d="M22 5h-4" />
				<path d="M4 17v2" />
				<path d="M5 18H3" />
			</svg>
			<h3 className="text-lg font-semibold mb-2">{feature}</h3>
			<p className="text-sm text-text-secondary max-w-sm mb-6">
				{t('licenseGate.requiresLicense', { plan })}
				{plan === 'Pro' ? ` ${t('licenseGate.proUnlocks')}` : ` ${t('licenseGate.enterpriseUnlocks')}`}
			</p>
			{/* Violet gradient (matches ProBadge); `px-4 py-2 rounded` matches the Save button. */}
			<a
				href="https://innolope.com/apps/cms#pricing"
				target="_blank"
				rel="noopener noreferrer"
				className="px-4 py-2 bg-gradient-to-r from-violet-500 to-purple-500 text-white rounded text-sm font-medium hover:opacity-90 transition-opacity"
			>
				{t('licenseGate.viewPlans')}
			</a>
		</div>
	)
}
