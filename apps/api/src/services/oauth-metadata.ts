import type { FastifyRequest } from 'fastify'

let warnedAboutHeaderFallback = false

/**
 * Absolute origin this server is reached at, used to build OAuth/MCP discovery
 * URLs and as the audience baked into access tokens. Prefers `PUBLIC_URL` (set
 * it behind a proxy/CDN), then `ADMIN_URL` when the admin is served from this
 * origin, and only as a last resort the request's forwarded headers / host —
 * which a client controls, so that fallback is logged once. `X-Forwarded-*` is
 * honoured only when `TRUST_PROXY` is set. No trailing slash.
 */
export function publicBaseUrl(request: FastifyRequest): string {
	const configured = process.env.PUBLIC_URL?.trim()
	if (configured) return configured.replace(/\/$/, '')

	const adminUrl = process.env.ADMIN_URL?.trim()
	if (adminUrl && process.env.NODE_ENV === 'production') return adminUrl.replace(/\/$/, '')

	const trustProxy = ['1', 'true', 'yes', 'on'].includes(
		(process.env.TRUST_PROXY ?? '').trim().toLowerCase(),
	)
	const forwardedProto = trustProxy
		? (request.headers['x-forwarded-proto'] as string | undefined)?.split(',')[0]?.trim()
		: undefined
	const forwardedHost = trustProxy
		? (request.headers['x-forwarded-host'] as string | undefined)?.split(',')[0]?.trim()
		: undefined
	const proto = forwardedProto || request.protocol || 'http'
	const host = forwardedHost || request.headers.host || `localhost:${process.env.API_PORT || 3001}`
	if (!warnedAboutHeaderFallback && request.log) {
		warnedAboutHeaderFallback = true
		request.log.warn(
			'PUBLIC_URL is not set — OAuth/MCP discovery URLs are derived from request headers. Set PUBLIC_URL in production.',
		)
	}
	return `${proto}://${host}`.replace(/\/$/, '')
}

/** The MCP resource identifier (the endpoint OAuth access tokens are audience-bound to). */
export function mcpResourceUrl(baseUrl: string): string {
	return `${baseUrl}/mcp`
}

/** RFC 9728 protected-resource metadata for the `/mcp` resource. */
export function protectedResourceMetadata(baseUrl: string) {
	return {
		resource: mcpResourceUrl(baseUrl),
		authorization_servers: [baseUrl],
		bearer_methods_supported: ['header'],
		resource_documentation: `${baseUrl}/`,
	}
}

/** RFC 8414 authorization-server metadata for the built-in OAuth 2.1 AS. */
export function authorizationServerMetadata(baseUrl: string) {
	return {
		issuer: baseUrl,
		authorization_endpoint: `${baseUrl}/oauth/authorize`,
		token_endpoint: `${baseUrl}/oauth/token`,
		registration_endpoint: `${baseUrl}/oauth/register`,
		response_types_supported: ['code'],
		grant_types_supported: ['authorization_code', 'refresh_token'],
		code_challenge_methods_supported: ['S256'],
		token_endpoint_auth_methods_supported: ['none'],
		scopes_supported: ['mcp'],
	}
}
