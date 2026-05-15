import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { RouterProvider, createRouter } from '@tanstack/react-router'
import { routeTree } from './routeTree.gen'
import { initAnalytics, trackPageView } from './lib/analytics'
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

createRoot(document.getElementById('root')!).render(
	<StrictMode>
		<RouterProvider router={router} />
	</StrictMode>,
)
