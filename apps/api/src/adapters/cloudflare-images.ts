import type { MediaAdapter, UploadResult } from '@innolope/types'

interface CloudflareConfig {
	accountId: string
	apiToken: string
	accountHash: string
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
		form.append('file', new Blob([buffer], { type: mimeType }), filename)

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
			throw new Error(`Cloudflare Images upload failed: ${data.errors[0]?.message}`)
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

	getUrl(id: string, variant = 'public'): string {
		return `https://imagedelivery.net/${this.config.accountHash}/${id}/${variant}`
	}
}
