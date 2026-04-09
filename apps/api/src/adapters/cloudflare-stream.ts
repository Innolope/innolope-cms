import type { MediaAdapter, UploadResult } from '@innolope/types'

interface StreamConfig {
	accountId: string
	apiToken: string
}

export class CloudflareStreamAdapter implements MediaAdapter {
	private config: StreamConfig

	constructor(config: StreamConfig) {
		this.config = config
	}

	async upload(
		file: Buffer | ReadableStream,
		filename: string,
		mimeType: string,
	): Promise<UploadResult> {
		const buffer =
			file instanceof Buffer ? file : Buffer.from(await new Response(file).arrayBuffer())

		// Use direct upload for videos
		// Step 1: Create a direct upload URL
		const createRes = await fetch(
			`https://api.cloudflare.com/client/v4/accounts/${this.config.accountId}/stream/direct_upload`,
			{
				method: 'POST',
				headers: {
					Authorization: `Bearer ${this.config.apiToken}`,
					'Content-Type': 'application/json',
				},
				body: JSON.stringify({
					maxDurationSeconds: 3600,
					meta: { name: filename },
				}),
			},
		)

		const createData = (await createRes.json()) as {
			success: boolean
			result: { uid: string; uploadURL: string }
			errors: { message: string }[]
		}

		if (!createData.success) {
			throw new Error(`Stream upload init failed: ${createData.errors[0]?.message}`)
		}

		const { uid, uploadURL } = createData.result

		// Step 2: Upload the video to the direct upload URL
		const form = new FormData()
		form.append('file', new Blob([buffer], { type: mimeType }), filename)

		const uploadRes = await fetch(uploadURL, { method: 'POST', body: form })

		if (!uploadRes.ok) {
			throw new Error(`Stream upload failed: ${uploadRes.statusText}`)
		}

		return {
			id: uid,
			url: this.getUrl(uid),
			filename,
			mimeType,
			size: buffer.length,
		}
	}

	async delete(id: string): Promise<void> {
		await fetch(
			`https://api.cloudflare.com/client/v4/accounts/${this.config.accountId}/stream/${id}`,
			{
				method: 'DELETE',
				headers: { Authorization: `Bearer ${this.config.apiToken}` },
			},
		)
	}

	getUrl(id: string): string {
		return `https://customer-${this.config.accountId}.cloudflarestream.com/${id}/manifest/video.m3u8`
	}

	async getStatus(id: string): Promise<{ ready: boolean; duration: number | null; thumbnail: string | null }> {
		const res = await fetch(
			`https://api.cloudflare.com/client/v4/accounts/${this.config.accountId}/stream/${id}`,
			{
				headers: { Authorization: `Bearer ${this.config.apiToken}` },
			},
		)

		const data = (await res.json()) as {
			result: {
				readyToStream: boolean
				duration: number
				thumbnail: string
			}
		}

		return {
			ready: data.result.readyToStream,
			duration: data.result.duration || null,
			thumbnail: data.result.thumbnail || null,
		}
	}
}
