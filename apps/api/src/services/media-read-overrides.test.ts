import { collections } from '@innolope/db'
import { describe, expect, it } from 'vitest'
import { applyExternalMediaStorage } from './external-content.js'

const col = {
	id: '11111111-1111-4111-8111-111111111111',
	projectId: 'project',
	name: 'images',
	label: 'Images',
	source: 'external',
	externalTable: 'images',
	accessMode: 'read-write',
	fields: [
		{ name: 'original', type: 'text' },
		{ name: 'assetPath', type: 'text' },
	],
}
describe('agent path override read compatibility', () => {
	it('resolves overridden stored keys through the existing content read path', async () => {
		const project = {
			settings: {
				mediaUploads: { target: 'collection', collectionId: col.id, fields: { path: 'assetPath' } },
				externalDb: {
					mediaStorage: {
						images: { adapter: 'r2', pathColumn: 'original', baseUrl: 'https://cdn.test/assets' },
					},
				},
			},
		}
		const app = {
			db: {
				select: () => ({
					from: (table: unknown) => ({
						where: () =>
							Object.assign(Promise.resolve(table === collections ? [col] : []), {
								limit: async () => [project],
							}),
					}),
				}),
			},
		}
		const items = [{ metadata: { assetPath: 'new.png' } }]
		await applyExternalMediaStorage(app as never, 'project', col as never, items)
		expect(items[0].metadata.assetPath).toBe('https://cdn.test/assets/new.png')
		expect(project.settings.externalDb.mediaStorage.images.pathColumn).toBe('original')
	})
})
