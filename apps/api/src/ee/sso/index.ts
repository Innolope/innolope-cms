import type { FastifyInstance } from 'fastify'
import { ssoDiscoverRoutes } from './discover.js'
import { ssoOidcRoutes } from './oidc.js'
import { ssoSamlRoutes } from './saml.js'
import { ssoInitiateRoutes } from './initiate.js'
import { ssoAdminRoutes } from './admin.js'
import { meIdentitiesRoutes } from './me-identities.js'

/**
 * Mounted at /api/v1/auth/sso. Routes:
 *   GET  /discover
 *   GET  /:slug/initiate       (dispatches to OIDC or SAML)
 *   GET  /:slug/oidc/callback
 *   POST /:slug/saml/acs
 *   GET  /:slug/saml/metadata
 */
export async function ssoRoutes(app: FastifyInstance) {
	await app.register(ssoDiscoverRoutes)
	await app.register(ssoInitiateRoutes)
	await app.register(ssoOidcRoutes)
	await app.register(ssoSamlRoutes)
}

export { ssoAdminRoutes, meIdentitiesRoutes }
