import { describe, expect, it } from 'vitest'
import {
	type DetectedTable,
	formatBytes,
	isMediaCollectionLike,
	isMediaTable,
	pickPathColumn,
	pickPathField,
	relationTargets,
} from './table-detection'

describe('formatBytes', () => {
	it('formats bytes, KB, and MB', () => {
		expect(formatBytes(512)).toBe('512 B')
		expect(formatBytes(2048)).toBe('2 KB')
		expect(formatBytes(5 * 1024 * 1024)).toBe('5 MB')
	})
})

describe('relationTargets', () => {
	const posts: DetectedTable = {
		name: 'posts',
		columns: [
			{ name: 'authorId', type: 'uuid', relationTo: 'authors' },
			{ name: 'parentId', type: 'uuid', relationTo: 'posts' },
			{ name: 'ghostId', type: 'uuid', relationTo: 'missing' },
		],
	}
	const authors: DetectedTable = { name: 'authors', columns: [] }

	it('returns known referenced tables, excluding self and unknown targets', () => {
		expect(relationTargets(posts, [posts, authors])).toEqual(['authors'])
	})
})

describe('isMediaTable', () => {
	it('matches by media-ish name', () => {
		expect(isMediaTable({ name: 'images', columns: [] })).toBe(true)
		expect(isMediaTable({ name: 'uploads', columns: [] })).toBe(true)
	})

	it('matches by having both a file reference and file metadata column (camelCase aware)', () => {
		expect(
			isMediaTable({
				name: 'assets_blob',
				columns: [
					{ name: 'imageUrl', type: 'text' },
					{ name: 'mimeType', type: 'text' },
				],
			}),
		).toBe(true)
	})

	it('does not match a plain content table', () => {
		expect(isMediaTable({ name: 'articles', columns: [{ name: 'title', type: 'text' }] })).toBe(
			false,
		)
	})
})

describe('pickPathColumn / pickPathField', () => {
	it('prefers a file-reference column, falling back to the first', () => {
		expect(
			pickPathColumn({
				name: 't',
				columns: [
					{ name: 'id', type: 'uuid' },
					{ name: 'filePath', type: 'text' },
				],
			}),
		).toBe('filePath')
		expect(pickPathField([{ name: 'id' }, { name: 'thumbnail' }])).toBe('thumbnail')
		expect(pickPathField([{ name: 'id' }])).toBe('id')
	})
})

describe('isMediaCollectionLike', () => {
	it('detects an imported media-like collection from its fields', () => {
		expect(
			isMediaCollectionLike({
				name: 'gallery',
				fields: [{ name: 'caption' }],
			}),
		).toBe(true)
		expect(
			isMediaCollectionLike({
				name: 'docs',
				fields: [{ name: 'src' }, { name: 'width' }],
			}),
		).toBe(true)
	})
})
