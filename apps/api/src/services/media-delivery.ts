import { safeFetch } from '../adapters/connection-guard.js'
import { parseCloudflareImageValue } from '../lib/media-sign.js'
import { resolveMediaValue } from '../lib/media-storage.js'
import type { IngestTarget } from './media-ingest-policy.js'

export async function probeDelivery(url: string, fetcher = safeFetch): Promise<boolean> {
	const controller = new AbortController()
	let timer: ReturnType<typeof setTimeout> | undefined
	const timeout = new Promise<never>((_resolve, reject) => {
		timer = setTimeout(() => {
			controller.abort()
			reject(new Error('Delivery probe timed out'))
		}, 5_000)
	})
	try {
		let response = await Promise.race([
			fetcher(url, { method: 'HEAD', signal: controller.signal }),
			timeout,
		])
		if (response.status === 405 || response.status === 501) {
			void response.body?.cancel().catch(() => {})
			response = await Promise.race([
				fetcher(url, {
					method: 'GET',
					headers: { Range: 'bytes=0-0' },
					signal: controller.signal,
				}),
				timeout,
			])
		}
		void response.body?.cancel().catch(() => {})
		return response.ok
	} catch {
		return false
	} finally {
		clearTimeout(timer)
	}
}
export async function mediaDelivery(fullPath: string, target: IngestTarget, probe = probeDelivery) {
	const privateCf =
		target.kind === 'collection' &&
		target.entry.adapter === 'cloudflare-images' &&
		target.entry.access === 'private'
	const privateDelivery = async (variant: string) => {
		if (target.kind !== 'collection') return fullPath
		const { imageId } = parseCloudflareImageValue(fullPath)
		return String(await resolveMediaValue(imageId, { ...target.entry, pathVariant: variant }))
	}
	let deliveryUrl = String(
		privateCf
			? await privateDelivery(target.variant)
			: target.kind === 'collection'
				? await resolveMediaValue(fullPath, target.entry)
				: fullPath,
	)
	const base = /^(https:\/\/imagedelivery\.net\/[^/]+\/[^/?#]+)(?:\/|$)/.exec(deliveryUrl)?.[1]
	if (target.kind === 'library' && deliveryUrl.startsWith('/') && target.baseUrl)
		deliveryUrl = `${target.baseUrl}${deliveryUrl}`
	if (base && !(target.kind === 'collection' && target.entry.access === 'private'))
		deliveryUrl = `${base}/${target.variant}`
	let deliveryVerified = await probe(deliveryUrl)
	const warnings: string[] = []
	if (
		!deliveryVerified &&
		base &&
		target.variant.includes('=') &&
		target.variant !== target.fallbackVariant
	) {
		deliveryUrl = privateCf
			? await privateDelivery(target.fallbackVariant)
			: `${base}/${target.fallbackVariant}`
		deliveryVerified = await probe(deliveryUrl)
		warnings.push(
			`Configured delivery transform failed; using named variant ${target.fallbackVariant}.`,
		)
	}
	if (!deliveryVerified)
		warnings.push(
			'Delivery URL probe failed. Call check_media before publishing; verify storage delivery settings.',
		)
	return { deliveryUrl, deliveryVerified, ...(warnings.length ? { warnings } : {}) }
}
