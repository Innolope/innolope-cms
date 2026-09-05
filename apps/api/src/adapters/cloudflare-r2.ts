import { createHash, createHmac, randomUUID } from 'node:crypto'
import type { MediaAdapter, UploadResult } from '@innolope/types'
import { EXTENSION_FOR_MIME } from '../lib/image.js'

interface R2Config {
	bucket: string
	accessKeyId: string
	secretAccessKey: string
	/** S3 API endpoint, e.g. https://<account>.r2.cloudflarestorage.com */
	endpoint: string
	/** Public bucket URL (custom domain or r2.dev); falls back to the endpoint. */
	publicUrl?: string
}

const sha256 = (data: Buffer | string) => createHash('sha256').update(data).digest('hex')
const hmac = (key: Buffer | string, data: string) => createHmac('sha256', key).update(data).digest()

/**
 * Cloudflare R2 through its S3-compatible API. Requests are signed with AWS
 * SigV4 (region `auto`, service `s3`) — R2 rejects unsigned writes on any
 * bucket that is not public-write. The object key (with extension) is the
 * adapter id, so delete/getUrl address exactly what upload wrote.
 */
export class CloudflareR2Adapter implements MediaAdapter {
	private config: R2Config

	constructor(config: R2Config) {
		this.config = config
	}

	private objectUrl(key: string): URL {
		return new URL(`${this.config.endpoint.replace(/\/$/, '')}/${this.config.bucket}/${key}`)
	}

	/** Build SigV4 headers for one request. */
	private sign(
		method: string,
		url: URL,
		body: Buffer,
		contentType?: string,
	): Record<string, string> {
		const now = new Date()
		const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '')
		const dateStamp = amzDate.slice(0, 8)
		const payloadHash = sha256(body)
		const headers: Record<string, string> = {
			host: url.host,
			'x-amz-content-sha256': payloadHash,
			'x-amz-date': amzDate,
			...(contentType ? { 'content-type': contentType } : {}),
		}
		const signedHeaderNames = Object.keys(headers).sort()
		const canonicalHeaders = signedHeaderNames.map((h) => `${h}:${headers[h].trim()}\n`).join('')
		const signedHeaders = signedHeaderNames.join(';')
		const canonicalUri = url.pathname
			.split('/')
			.map((seg) => encodeURIComponent(seg))
			.join('/')
		const canonicalRequest = [
			method,
			canonicalUri,
			'',
			canonicalHeaders,
			signedHeaders,
			payloadHash,
		].join('\n')
		const scope = `${dateStamp}/auto/s3/aws4_request`
		const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256(canonicalRequest)].join('\n')
		const kDate = hmac(`AWS4${this.config.secretAccessKey}`, dateStamp)
		const kRegion = hmac(kDate, 'auto')
		const kService = hmac(kRegion, 's3')
		const kSigning = hmac(kService, 'aws4_request')
		const signature = createHmac('sha256', kSigning).update(stringToSign).digest('hex')
		const authorization = `AWS4-HMAC-SHA256 Credential=${this.config.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`
		const { host: _host, ...rest } = headers
		return { ...rest, authorization }
	}

	async upload(
		file: Buffer | ReadableStream,
		_filename: string,
		mimeType: string,
	): Promise<UploadResult> {
		const buffer =
			file instanceof Buffer ? file : Buffer.from(await new Response(file).arrayBuffer())

		const key = `${randomUUID()}.${EXTENSION_FOR_MIME[mimeType] ?? 'bin'}`
		const url = this.objectUrl(key)
		const response = await fetch(url, {
			method: 'PUT',
			headers: this.sign('PUT', url, buffer, mimeType),
			body: buffer,
		})

		if (!response.ok) {
			throw new Error(`R2 upload failed: ${response.status} ${response.statusText}`)
		}

		return {
			id: key,
			url: this.getUrl(key),
			filename: key,
			mimeType,
			size: buffer.length,
		}
	}

	async delete(id: string): Promise<void> {
		const url = this.objectUrl(id)
		const response = await fetch(url, {
			method: 'DELETE',
			headers: this.sign('DELETE', url, Buffer.alloc(0)),
		})
		if (!response.ok && response.status !== 404) {
			throw new Error(`R2 delete failed: ${response.status} ${response.statusText}`)
		}
	}

	getUrl(id: string): string {
		const base = (this.config.publicUrl || `${this.config.endpoint}/${this.config.bucket}`).replace(
			/\/$/,
			'',
		)
		return `${base}/${id}`
	}
}
