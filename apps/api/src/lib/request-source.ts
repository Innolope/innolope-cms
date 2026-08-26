import { CLIENT_HEADER, CONTENT_SOURCES, type ContentSource } from '@innolope/config'
import type { FastifyRequest } from 'fastify'

const KNOWN = new Set<string>(CONTENT_SOURCES)

/**
 * Which client is behind this write, for attribution on content rows and version
 * history.
 *
 * Credentials alone cannot separate the first-party clients: the MCP layer
 * re-mints an ordinary session JWT for its loopback REST calls, so an agent's
 * write and a human's write in the admin UI arrive with the same kind of token.
 * The clients therefore declare themselves via `X-Innolope-Client`, and we fall
 * back to the credential type for everyone else.
 *
 * The header is attribution metadata, never authorization — it can be forged by
 * any caller holding a valid credential, and grants nothing. Unrecognized values
 * are discarded rather than stored, so the column only ever holds known sources.
 */
export function requestSource(request: FastifyRequest): ContentSource {
	const declared = request.headers[CLIENT_HEADER]
	const value = Array.isArray(declared) ? declared[0] : declared
	if (value && KNOWN.has(value)) return value as ContentSource
	return request.apiKeyAuth ? 'api' : 'admin'
}
