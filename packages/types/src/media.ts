export type MediaType = 'image' | 'video' | 'file'

export interface MediaItem {
	id: string
	type: MediaType
	filename: string
	mimeType: string
	size: number
	url: string
	alt: string | null
	metadata: Record<string, unknown>
	createdAt: string
	createdBy: string
}

export interface UploadResult {
	id: string
	url: string
	filename: string
	mimeType: string
	size: number
}

export interface MediaListParams {
	type?: MediaType
	search?: string
	page?: number
	limit?: number
}

export interface MediaAdapter {
	upload(
		file: Uint8Array | ReadableStream,
		filename: string,
		mimeType: string,
	): Promise<UploadResult>
	delete(id: string): Promise<void>
	getUrl(id: string, variant?: string): string
}
