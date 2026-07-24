import { createHmac } from 'node:crypto'
import { AwsClient } from 'aws4fetch'

/** Default lifetime of a generated presigned/signed media URL. */
export const SIGNED_URL_TTL_SECONDS = 3600

export interface R2Credentials {
	accountId: string
	accessKeyId: string
	secretAccessKey: string
	bucket: string
}

export interface ImagesCredentials {
	accountHash: string
	signingKey: string
}

/** Strip a scheme+host (and optional bucket segment) from a stored value, leaving the object key. */
export function toObjectKey(value: string, bucket?: string): string {
	let key = value
	try {
		if (/^https?:\/\//i.test(value)) key = new URL(value).pathname
	} catch {
		// keep as-is
	}
	key = key.replace(/^\/+/, '')
	if (bucket && key.startsWith(`${bucket}/`)) key = key.slice(bucket.length + 1)
	return key
}

/** Generate a short-lived presigned GET URL for a private Cloudflare R2 object. */
export async function presignR2(
	creds: R2Credentials,
	value: string,
	ttl = SIGNED_URL_TTL_SECONDS,
): Promise<string> {
	const aws = new AwsClient({
		accessKeyId: creds.accessKeyId,
		secretAccessKey: creds.secretAccessKey,
		service: 's3',
		region: 'auto',
	})
	const key = toObjectKey(value, creds.bucket)
	const encodedKey = key.split('/').map(encodeURIComponent).join('/')
	const url = new URL(
		`https://${creds.accountId}.r2.cloudflarestorage.com/${creds.bucket}/${encodedKey}`,
	)
	url.searchParams.set('X-Amz-Expires', String(ttl))
	const signed = await aws.sign(url.toString(), { method: 'GET', aws: { signQuery: true } })
	return signed.url
}

/** Generate a short-lived presigned PUT URL for uploading an object to Cloudflare R2. */
export async function presignR2Put(
	creds: R2Credentials,
	key: string,
	ttl = SIGNED_URL_TTL_SECONDS,
): Promise<string> {
	const aws = new AwsClient({
		accessKeyId: creds.accessKeyId,
		secretAccessKey: creds.secretAccessKey,
		service: 's3',
		region: 'auto',
	})
	const encodedKey = key.split('/').map(encodeURIComponent).join('/')
	const url = new URL(
		`https://${creds.accountId}.r2.cloudflarestorage.com/${creds.bucket}/${encodedKey}`,
	)
	url.searchParams.set('X-Amz-Expires', String(ttl))
	const signed = await aws.sign(url.toString(), { method: 'PUT', aws: { signQuery: true } })
	return signed.url
}

/**
 * Split a stored Cloudflare Images value into its image id and variant.
 *
 * A delivery URL is `/<accountHash>/<imageId>/<variant>` and the variant is
 * mandatory — `imagedelivery.net/<hash>/<id>` alone 404s. Sources that store the
 * bare id (or a URL without the trailing variant) are very common, so anything
 * missing one is given `defaultVariant` — the library's configured variant name,
 * falling back to Cloudflare's out-of-the-box `public`. Accounts can rename that
 * variant, so callers that know the library should always pass theirs.
 */
export function parseCloudflareImageValue(
	value: string,
	defaultVariant = 'public',
): { imageId: string; variant: string } {
	let imageId = value
	let variant = defaultVariant
	if (/^https?:\/\//i.test(value)) {
		const parts = new URL(value).pathname.split('/').filter(Boolean)
		// /<accountHash>/<imageId>/<variant>
		if (parts.length >= 3) {
			imageId = parts[parts.length - 2]
			variant = parts[parts.length - 1]
		} else if (parts.length >= 1) {
			imageId = parts[parts.length - 1]
		}
	}
	return { imageId, variant }
}

/**
 * Build a complete, servable delivery URL from whatever shape the source stored —
 * a bare image id, a variant-less URL, or an already-complete URL.
 */
export function cloudflareImageUrl(
	accountHash: string,
	value: string,
	defaultVariant?: string,
): string {
	const { imageId, variant } = parseCloudflareImageValue(value, defaultVariant)
	return `https://imagedelivery.net/${accountHash}/${imageId}/${variant}`
}

/** Generate a short-lived signed delivery URL for a private Cloudflare Images asset. */
export function signCloudflareImage(
	creds: ImagesCredentials,
	value: string,
	ttl = SIGNED_URL_TTL_SECONDS,
	defaultVariant?: string,
): string {
	// `value` may be a full delivery URL or a bare image id.
	const { imageId, variant } = parseCloudflareImageValue(value, defaultVariant)
	const url = new URL(`https://imagedelivery.net/${creds.accountHash}/${imageId}/${variant}`)
	url.searchParams.set('exp', String(Math.floor(Date.now() / 1000) + ttl))
	const sig = createHmac('sha256', creds.signingKey)
		.update(url.pathname + url.search)
		.digest('hex')
	url.searchParams.set('sig', sig)
	return url.toString()
}
