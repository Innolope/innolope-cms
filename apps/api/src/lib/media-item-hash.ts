import { createHash } from 'node:crypto'

export function mediaItemHash(item: {
	id: string
	projectId: string
	filename: string
	alt: string | null
	url: string
}): string {
	return `sha256:${createHash('sha256')
		.update(JSON.stringify([item.id, item.projectId, item.filename, item.alt, item.url]))
		.digest('hex')}`
}
