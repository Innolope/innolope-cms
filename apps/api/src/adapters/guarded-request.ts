/**
 * One HTTP(S) request whose socket may only connect to addresses a screening
 * lookup accepts — the transport under `safeFetch`. Screening the address the
 * socket actually uses (not a separate earlier lookup) is what defeats DNS
 * rebinding: a TTL-0 host cannot pass a preflight and then point at loopback.
 *
 * Built on node:http/https, whose `lookup` option is public API, rather than on
 * the npm `undici` package: importing that package installs its Agent as the
 * process-wide fetch dispatcher, and when its major differs from the undici Node
 * bundles, every built-in `fetch` response in the process comes back without
 * headers.
 */
import { lookup as dnsLookup } from 'node:dns'
import type { IncomingMessage } from 'node:http'
import type { LookupFunction } from 'node:net'
import { pipeline, Readable } from 'node:stream'
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib'

/** A `lookup` that fails the connection when any resolved address is blocked. */
export function screenedLookup(isBlocked: (address: string) => boolean): LookupFunction {
	return (hostname, options, callback) => {
		dnsLookup(hostname, { ...options, all: true }, (err, addresses) => {
			if (err) return callback(err, '', 0)
			if (!addresses.length || addresses.some(({ address }) => isBlocked(address)))
				return callback(
					new Error('Request to private/internal addresses is not allowed at connect time.'),
					'',
					0,
				)
			if (options.all) callback(null, addresses)
			else callback(null, addresses[0].address, addresses[0].family)
		})
	}
}

// The API's tsconfig has no DOM lib, so take fetch's types from RequestInit.
type RequestBody = RequestInit['body']

export interface GuardedRequestInit {
	method?: string
	headers?: RequestInit['headers']
	body?: RequestBody
	signal?: AbortSignal | null
}

/** Statuses whose responses never carry a body (the Response constructor rejects one). */
const NULL_BODY_STATUSES = new Set([204, 205, 304])

function encodeBody(body: RequestBody): Buffer | undefined {
	if (body == null) return undefined
	if (typeof body === 'string' || body instanceof URLSearchParams) return Buffer.from(String(body))
	if (body instanceof ArrayBuffer) return Buffer.from(body)
	if (ArrayBuffer.isView(body)) return Buffer.from(body.buffer, body.byteOffset, body.byteLength)
	throw new TypeError('safeFetch supports string, URLSearchParams and binary request bodies only.')
}

/** Undo Content-Encoding the way fetch does, so callers always read plain bytes. */
function decoded(res: IncomingMessage): Readable {
	const encoding = String(res.headers['content-encoding'] ?? '')
		.trim()
		.toLowerCase()
	const decoder =
		encoding === 'gzip' || encoding === 'x-gzip'
			? createGunzip()
			: encoding === 'deflate'
				? createInflate()
				: encoding === 'br'
					? createBrotliDecompress()
					: null
	return decoder ? pipeline(res, decoder, () => {}) : res
}

// Loaded on first use, not at import: on some Node versions importing node:http
// initializes the bundled undici's process-wide dispatcher, and modules that
// import safeFetch must load without touching it.
let transports: Promise<[typeof import('node:http'), typeof import('node:https')]> | undefined
const loadTransports = () =>
	(transports ??= Promise.all([import('node:http'), import('node:https')]))

export async function guardedRequest(
	url: string,
	init: GuardedRequestInit,
	lookup: LookupFunction,
): Promise<Response> {
	const target = new URL(url)
	const method = (init.method ?? 'GET').toUpperCase()
	const headers = new Headers(init.headers)
	// fetch's defaults, so servers answer the same way they did before.
	if (!headers.has('accept')) headers.set('accept', '*/*')
	if (!headers.has('accept-encoding')) headers.set('accept-encoding', 'gzip, deflate, br')
	if (!headers.has('user-agent')) headers.set('user-agent', 'node')
	if (typeof init.body === 'string' && !headers.has('content-type'))
		headers.set('content-type', 'text/plain;charset=UTF-8')
	if (init.body instanceof URLSearchParams && !headers.has('content-type'))
		headers.set('content-type', 'application/x-www-form-urlencoded;charset=UTF-8')
	const body = encodeBody(init.body)
	if (body) headers.set('content-length', String(body.byteLength))

	const [http, https] = await loadTransports()
	const send = target.protocol === 'https:' ? https.request : http.request
	return new Promise((resolve, reject) => {
		const req = send(
			target,
			{
				method,
				headers: Object.fromEntries(headers),
				lookup,
				// A fresh socket per request: every connection goes through `lookup`.
				agent: false,
				signal: init.signal ?? undefined,
			},
			(res) => {
				const status = res.statusCode ?? 0
				const responseHeaders = new Headers()
				for (const [name, value] of Object.entries(res.headers)) {
					if (value === undefined) continue
					for (const v of Array.isArray(value) ? value : [value]) responseHeaders.append(name, v)
				}
				const noBody = method === 'HEAD' || NULL_BODY_STATUSES.has(status)
				if (noBody) res.resume()
				const response = new Response(
					noBody ? null : (Readable.toWeb(decoded(res)) as ReadableStream<Uint8Array>),
					{ status, statusText: res.statusMessage ?? '', headers: responseHeaders },
				)
				// fetch reports the URL it answered for; callers resolve relative links against it.
				Object.defineProperty(response, 'url', { value: url })
				resolve(response)
			},
		)
		req.on('error', reject)
		req.end(body)
	})
}
