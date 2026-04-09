import type { MediaAdapter, UploadResult } from '@innolope/types'
import { randomUUID } from 'node:crypto'

interface R2Config {
	bucket: string
	accessKeyId: string
	secretAccessKey: string
	endpoint: string
	publicUrl?: string
}

export class CloudflareR2Adapter implements MediaAdapter {
	private config: R2Config

	constructor(config: R2Config) {
		this.config = config
	}

	async upload(
		file: Buffer | ReadableStream,
		filename: string,
		mimeType: string,
	): Promise<UploadResult> {
		const buffer =
			file instanceof Buffer ? file : Buffer.from(await new Response(file).arrayBuffer())

		const id = randomUUID()
		const ext = filename.split('.').pop() || 'bin'
		const key = `${id}.${ext}`

		const response = await fetch(`${this.config.endpoint}/${this.config.bucket}/${key}`, {
			method: 'PUT',
			headers: {
				'Content-Type': mimeType,
				'x-amz-content-sha256': 'UNSIGNED-PAYLOAD',
			},
			body: buffer,
		})

		if (!response.ok) {
			throw new Error(`R2 upload failed: ${response.statusText}`)
		}

		return {
			id,
			url: this.getUrl(id),
			filename,
			mimeType,
			size: buffer.length,
		}
	}

	async delete(id: string): Promise<void> {
		await fetch(`${this.config.endpoint}/${this.config.bucket}/${id}`, {
			method: 'DELETE',
		})
	}

	getUrl(id: string): string {
		const base = this.config.publicUrl || this.config.endpoint
		return `${base}/${this.config.bucket}/${id}`
	}
}
