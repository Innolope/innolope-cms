import type { FastifyRequest } from 'fastify'

/**
 * Absolute origin this server is reached at, used to build OAuth/MCP discovery
 * URLs. Prefers `PUBLIC_URL` (set it behind a proxy/CDN), then standard
 * forwarded headers, then the request's own protocol + host. No trailing slash.
 */
export function publicBaseUrl(request: FastifyRequest): string {
	const configured = process.env.PUBLIC_URL?.trim()
	if (configured) return configured.replace(/\/$/, '')

	const forwardedProto = (request.headers['x-forwarded-proto'] as string | undefined)
		?.split(',')[0]
		?.trim()
	const forwardedHost = (request.headers['x-forwarded-host'] as string | undefined)
		?.split(',')[0]
		?.trim()
	const proto = forwardedProto || request.protocol || 'http'
	const host = forwardedHost || request.headers.host || `localhost:${process.env.API_PORT || 3001}`
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
