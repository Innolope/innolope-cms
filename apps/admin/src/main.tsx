import { createRouter, RouterProvider } from '@tanstack/react-router'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { initAnalytics, trackPageView } from './lib/analytics'
import './lib/i18n'
import { routeTree } from './routeTree.gen'
import './index.css'

const router = createRouter({ routeTree })

initAnalytics()
router.subscribe('onResolved', ({ toLocation }) => {
	trackPageView(toLocation.pathname)
})

declare module '@tanstack/react-router' {
	interface Register {
		router: typeof router
	}
}

const rootElement = document.getElementById('root')
if (!rootElement) {
	throw new Error('Root element #root not found')
}

createRoot(rootElement).render(
	<StrictMode>
		<RouterProvider router={router} />
	</StrictMode>,
)
