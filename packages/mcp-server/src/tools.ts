import type { InnolopeClient } from './api-client.js'

export function getToolDefinitions() {
	return [
		{
			name: 'list_content',
			description:
				'List content items from the CMS. Supports filtering by collection, status, locale, and search query.',
			inputSchema: {
				type: 'object' as const,
				properties: {
					collectionId: { type: 'string', description: 'Filter by collection UUID' },
					status: {
						type: 'string',
						enum: ['draft', 'published', 'archived'],
						description: 'Filter by status',
					},
					locale: { type: 'string', description: 'Filter by locale (e.g. "en", "es")' },
					search: { type: 'string', description: 'Full-text search query' },
					page: { type: 'number', description: 'Page number (default: 1)' },
					limit: { type: 'number', description: 'Items per page (default: 25, max: 100)' },
				},
			},
		},
		{
			name: 'get_content',
			description:
				'Get a single content item by ID. Returns full markdown content and metadata.',
			inputSchema: {
				type: 'object' as const,
				properties: {
					id: { type: 'string', description: 'Content item UUID' },
				},
				required: ['id'],
			},
		},
		{
			name: 'create_content',
			description:
				'Create a new content item. Provide markdown content and metadata. Content is created as draft by default.',
			inputSchema: {
				type: 'object' as const,
				properties: {
					slug: {
						type: 'string',
						description: 'URL-friendly slug (lowercase, hyphens only)',
					},
					collectionId: { type: 'string', description: 'Collection UUID to add content to' },
					markdown: { type: 'string', description: 'Full markdown content of the article' },
					metadata: {
						type: 'object',
						description:
							'Metadata object (title, excerpt, tags, etc.). Structure depends on collection fields.',
					},
					locale: { type: 'string', description: 'Content locale (default: "en")' },
					status: {
						type: 'string',
						enum: ['draft', 'published'],
						description: 'Initial status (default: "draft")',
					},
				},
				required: ['slug', 'collectionId', 'markdown'],
			},
		},
		{
			name: 'update_content',
			description: 'Update an existing content item. Only provide fields you want to change.',
			inputSchema: {
				type: 'object' as const,
				properties: {
					id: { type: 'string', description: 'Content item UUID to update' },
					slug: { type: 'string', description: 'New slug' },
					markdown: { type: 'string', description: 'Updated markdown content' },
					metadata: { type: 'object', description: 'Updated metadata fields' },
					status: {
						type: 'string',
						enum: ['draft', 'published', 'archived'],
						description: 'New status',
					},
				},
				required: ['id'],
			},
		},
		{
			name: 'publish_content',
			description: 'Publish a content item (changes status from draft to published).',
			inputSchema: {
				type: 'object' as const,
				properties: {
					id: { type: 'string', description: 'Content item UUID to publish' },
				},
				required: ['id'],
			},
		},
		{
			name: 'search_content',
			description:
				'Search content by keyword across all markdown content and metadata.',
			inputSchema: {
				type: 'object' as const,
				properties: {
					query: { type: 'string', description: 'Search query' },
				},
				required: ['query'],
			},
		},
	]
}

export async function handleToolCall(
	client: InnolopeClient,
	name: string,
	args: Record<string, unknown>,
): Promise<string> {
	switch (name) {
		case 'list_content': {
			const result = await client.listContent(args as Parameters<typeof client.listContent>[0])
			const items = result.data.map((item) => {
				const title = (item.metadata as Record<string, unknown>)?.title || item.slug
				return `- [${item.status}] ${title} (${item.slug}) — id: ${item.id}`
			})
			return `Found ${result.pagination.total} items (page ${result.pagination.page}):\n${items.join('\n')}`
		}

		case 'get_content': {
			const item = await client.getContent(args.id as string)
			return [
				`# ${(item.metadata as Record<string, unknown>)?.title || item.slug}`,
				``,
				`**Slug:** ${item.slug}`,
				`**Status:** ${item.status}`,
				`**Locale:** ${item.locale}`,
				`**Version:** ${item.version}`,
				`**Updated:** ${item.updatedAt}`,
				``,
				`## Content`,
				``,
				item.markdown,
			].join('\n')
		}

		case 'create_content': {
			const created = await client.createContent(
				args as Parameters<typeof client.createContent>[0],
			)
			return `Content created successfully.\nID: ${created.id}\nSlug: ${created.slug}\nStatus: ${created.status}`
		}

		case 'update_content': {
			const { id, ...updates } = args
			const updated = await client.updateContent(id as string, updates)
			return `Content updated.\nID: ${updated.id}\nVersion: ${updated.version}`
		}

		case 'publish_content': {
			const published = await client.publishContent(args.id as string)
			return `Content published.\nID: ${published.id}\nPublished at: ${published.publishedAt}`
		}

		case 'search_content': {
			const results = await client.searchContent(args.query as string)
			if (results.data.length === 0) return 'No content found matching your query.'
			const items = results.data.map((item) => {
				const title = (item.metadata as Record<string, unknown>)?.title || item.slug
				return `- ${title} (${item.slug}) — ${item.status}`
			})
			return `Found ${results.pagination.total} results:\n${items.join('\n')}`
		}

		default:
			throw new Error(`Unknown tool: ${name}`)
	}
}
