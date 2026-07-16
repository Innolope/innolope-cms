import { randomUUID } from 'node:crypto'
import { InnolopeClient, registerTools } from '@innolope/mcp-server/lib'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { type AuthUser, createJwt, verifyOAuthAccessToken } from '../plugins/auth.js'
import { mcpResourceUrl, publicBaseUrl } from '../services/oauth-metadata.js'

declare module 'fastify' {
	interface FastifyRequest {
		/** User resolved from the `/mcp` OAuth access token. */
		mcpUser?: AuthUser
	}
}

interface McpSession {
	transport: StreamableHTTPServerTransport
	server: McpServer
}

/**
 * Streamable-HTTP MCP transport hosted inside the API. MCP clients (Claude,
 * Cursor, MCP Inspector) connect here with an OAuth access token; the same tool
 * set as the stdio server (`@innolope/mcp-server`) is registered per session.
 *
 * Each session gets its own `McpServer` + `InnolopeClient`. The client calls the
 * REST API back over loopback carrying the caller's bearer token, so all existing
 * authorization (membership, roles, license limits) applies unchanged and the
 * per-session "active project" (set by `use_project`/`create_project`) is isolated.
 */
export async function mcpRoutes(app: FastifyInstance) {
	const sessions = new Map<string, McpSession>()

	// The tools proxy to the API over loopback. Kept internal so we never depend on
	// an externally-resolvable hostname for self-calls.
	const internalApiUrl =
		process.env.INTERNAL_API_URL || `http://127.0.0.1:${Number(process.env.API_PORT) || 3001}`

	app.addHook('onClose', async () => {
		for (const { transport } of sessions.values()) {
			await transport.close().catch(() => {})
		}
		sessions.clear()
	})

	// Bearer auth for every /mcp method. Only accepts a genuine MCP OAuth access
	// token: right signing key, audience pinned to this server's `/mcp` resource,
	// and `token_use: "access"` — a web-login JWT does not qualify. On failure,
	// point clients at the protected-resource metadata per RFC 9728 to start OAuth.
	const authenticateMcp = async (request: FastifyRequest, reply: FastifyReply) => {
		const header = request.headers.authorization
		const token = header?.startsWith('Bearer ') ? header.slice(7) : undefined
		const audience = mcpResourceUrl(publicBaseUrl(request))
		const user = token ? await verifyOAuthAccessToken(token, { audience }) : null
		if (!user) {
			reply.header(
				'WWW-Authenticate',
				`Bearer resource_metadata="${publicBaseUrl(request)}/.well-known/oauth-protected-resource"`,
			)
			return reply
				.status(401)
				.send({ error: 'invalid_token', error_description: 'Missing or invalid access token' })
		}
		request.mcpUser = user
	}

	// Reflect CORS on the actual (hijacked) responses. Preflight OPTIONS is handled
	// by the global @fastify/cors delegate; the streaming responses below bypass
	// Fastify's reply serialization, so set the header on the raw socket directly.
	const applyCors = (request: FastifyRequest, reply: FastifyReply) => {
		const origin = request.headers.origin
		if (origin) {
			reply.raw.setHeader('Access-Control-Allow-Origin', origin)
			reply.raw.setHeader('Access-Control-Expose-Headers', 'Mcp-Session-Id, WWW-Authenticate')
			reply.raw.setHeader('Vary', 'Origin')
		}
	}

	const badRequest = (reply: FastifyReply, message: string) =>
		reply.status(400).send({
			jsonrpc: '2.0',
			error: { code: -32000, message },
			id: null,
		})

	// POST: client → server messages (including `initialize`, which opens a session).
	app.post('/', { preHandler: [authenticateMcp] }, async (request, reply) => {
		const sessionId = request.headers['mcp-session-id'] as string | undefined
		let session = sessionId ? sessions.get(sessionId) : undefined

		if (!session) {
			if (sessionId) return badRequest(reply, 'Unknown or expired session ID')
			if (!isInitializeRequest(request.body)) {
				return badRequest(reply, 'No session ID provided and body is not an initialize request')
			}
			// New session: build an isolated server + client. The client calls the REST
			// API over loopback with a freshly minted INTERNAL token (AUTH_SECRET), not
			// the external MCP token — keeping the two credentials fully separate.
			const internalToken = await createJwt(request.mcpUser as AuthUser)
			const client = new InnolopeClient(internalApiUrl, internalToken)
			const server = new McpServer({ name: 'innolope-cms', version: '0.1.0' })
			registerTools(server, client)
			const transport = new StreamableHTTPServerTransport({
				sessionIdGenerator: () => randomUUID(),
				onsessioninitialized: (sid) => {
					sessions.set(sid, { transport, server })
				},
			})
			transport.onclose = () => {
				const sid = transport.sessionId
				if (sid) sessions.delete(sid)
			}
			await server.connect(transport)
			session = { transport, server }
		}

		applyCors(request, reply)
		reply.hijack()
		try {
			await session.transport.handleRequest(request.raw, reply.raw, request.body)
		} catch (err) {
			request.log.error({ err }, 'MCP request handling failed')
			if (!reply.raw.headersSent) {
				reply.raw.writeHead(500).end('Internal error')
			}
		}
	})

	// GET: opens the server → client SSE stream for an existing session.
	// DELETE: explicit session teardown.
	const streamOrDelete = async (request: FastifyRequest, reply: FastifyReply) => {
		const sessionId = request.headers['mcp-session-id'] as string | undefined
		const session = sessionId ? sessions.get(sessionId) : undefined
		if (!session) return badRequest(reply, 'Missing or unknown session ID')
		applyCors(request, reply)
		reply.hijack()
		try {
			await session.transport.handleRequest(request.raw, reply.raw)
		} catch (err) {
			request.log.error({ err }, 'MCP stream handling failed')
			if (!reply.raw.headersSent) reply.raw.writeHead(500).end('Internal error')
		}
	}

	app.get('/', { preHandler: [authenticateMcp] }, streamOrDelete)
	app.delete('/', { preHandler: [authenticateMcp] }, streamOrDelete)
}
