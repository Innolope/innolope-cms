import { mkdir, writeFile, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { MediaAdapter, UploadResult } from '@innolope/types'

const UPLOAD_DIR = process.env.UPLOAD_DIR || './uploads'

export class LocalFsAdapter implements MediaAdapter {
	async upload(
		file: Buffer | ReadableStream,
		filename: string,
		mimeType: string,
	): Promise<UploadResult> {
		await mkdir(UPLOAD_DIR, { recursive: true })

		const id = randomUUID()
		const ext = filename.split('.').pop() || 'bin'
		const storedName = `${id}.${ext}`
		const filePath = join(UPLOAD_DIR, storedName)

		const buffer = file instanceof Buffer ? file : Buffer.from(await new Response(file).arrayBuffer())
		await writeFile(filePath, buffer)

		return {
			id,
			url: `/uploads/${storedName}`,
			filename,
			mimeType,
			size: buffer.length,
		}
	}

	async delete(id: string): Promise<void> {
		const files = await import('node:fs/promises')
		const dir = await files.readdir(UPLOAD_DIR)
		const match = dir.find((f) => f.startsWith(id))
		if (match) {
			await unlink(join(UPLOAD_DIR, match))
		}
	}

	getUrl(id: string, _variant?: string): string {
		return `/uploads/${id}`
	}
}
