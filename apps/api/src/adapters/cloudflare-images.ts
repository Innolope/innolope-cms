import type { MediaAdapter, UploadResult } from '@innolope/types'

interface CloudflareConfig {
	accountId: string
	apiToken: string
	accountHash: string
	/** Variant used in delivery URLs; accounts can rename the default `public`. */
	defaultVariant?: string
	/**
	 * Metadata attached to every upload (Cloudflare stores it on the image).
	 * Used to tag uploads into the shared platform account with their project.
	 */
	uploadMetadata?: Record<string, string>
}

export class CloudflareImagesAdapter implements MediaAdapter {
	private config: CloudflareConfig

	constructor(config: CloudflareConfig) {
		this.config = config
	}

	async upload(
		file: Buffer | ReadableStream,
		filename: string,
		mimeType: string,
	): Promise<UploadResult> {
		const buffer =
			file instanceof Buffer ? file : Buffer.from(await new Response(file).arrayBuffer())

		const form = new FormData()
		form.append('file', new Blob([new Uint8Array(buffer)], { type: mimeType }), filename)
		if (this.config.uploadMetadata) {
			form.append('metadata', JSON.stringify(this.config.uploadMetadata))
		}

		const response = await fetch(
			`https://api.cloudflare.com/client/v4/accounts/${this.config.accountId}/images/v1`,
			{
				method: 'POST',
				headers: { Authorization: `Bearer ${this.config.apiToken}` },
				body: form,
			},
		)

		const data = (await response.json()) as {
			success: boolean
			result: { id: string; filename: string }
			errors: { message: string }[]
		}

		if (!data.success) {
			// A 4xx from Cloudflare means the request/file was bad (e.g. a corrupt or
			// incomplete image) — that's a client error, so surface it as 400 and keep
			// it out of Sentry. Anything else (auth, quota, 5xx) is an upstream failure.
			const clientError = response.status >= 400 && response.status < 500
			throw Object.assign(
				new Error(`Cloudflare Images upload failed: ${data.errors[0]?.message}`),
				{ statusCode: clientError ? 400 : 502 },
			)
		}

		return {
			id: data.result.id,
			url: this.getUrl(data.result.id),
			filename: data.result.filename,
			mimeType,
			size: buffer.length,
		}
	}

	async delete(id: string): Promise<void> {
		await fetch(
			`https://api.cloudflare.com/client/v4/accounts/${this.config.accountId}/images/v1/${id}`,
			{
				method: 'DELETE',
				headers: { Authorization: `Bearer ${this.config.apiToken}` },
			},
		)
	}

	getUrl(id: string, variant = this.config.defaultVariant ?? 'public'): string {
		return `https://imagedelivery.net/${this.config.accountHash}/${id}/${variant}`
	}
}
