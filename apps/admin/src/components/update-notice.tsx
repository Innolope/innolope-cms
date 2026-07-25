import { useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { BUILD_ID, fetchDeployedBuildId, startUpdateWatcher } from '../lib/build-version'
import { useToast } from '../lib/toast'

/**
 * Watches for a newer deployed build and offers a reload.
 *
 * Renders nothing; mounted once inside ToastProvider. Without it a long-lived
 * tab keeps running the bundle it loaded — after a redeploy the user works in
 * old UI with no signal, and missing features read as regressions. The toast
 * is sticky (a 4-second flash would vanish while the editor is typing) and the
 * action is a plain location.reload(), which picks up the new index.html.
 */
export function UpdateNotice() {
	const toast = useToast()
	const { t } = useTranslation()

	useEffect(() => {
		// The dev server has no /version.json and hot-reloads on its own.
		if (import.meta.env.DEV || BUILD_ID === 'dev') return
		return startUpdateWatcher({
			currentId: BUILD_ID,
			fetchId: fetchDeployedBuildId,
			onUpdate: () =>
				toast(t('appUpdate.available'), 'info', {
					sticky: true,
					action: { label: t('appUpdate.reload'), onClick: () => window.location.reload() },
				}),
		})
	}, [toast, t])

	return null
}
