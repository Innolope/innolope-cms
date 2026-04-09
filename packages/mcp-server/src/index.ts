#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { InnolopeClient } from './api-client.js'

const apiUrl = process.env.INNOLOPE_API_URL
const apiKey = process.env.INNOLOPE_API_KEY
const projectId = process.env.INNOLOPE_PROJECT_ID // Optional — API key is already project-scoped

if (!apiUrl || !apiKey) {
	console.error('Missing required environment variables: INNOLOPE_API_URL, INNOLOPE_API_KEY')
	process.exit(1)
}

const client = new InnolopeClient(apiUrl, apiKey, projectId)

const server = new McpServer({
	name: 'innolope-cms',
	version: '0.1.0',
})

// List content
server.tool(
	'list_content',
	'List content items from the CMS with optional filters',
	{
		collectionId: z.string().optional().describe('Filter by collection UUID'),
		status: z.enum(['draft', 'published', 'archived']).optional().describe('Filter by status'),
		locale: z.string().optional().describe('Filter by locale'),
		search: z.string().optional().describe('Full-text search query'),
		page: z.number().optional().describe('Page number (default: 1)'),
		limit: z.number().optional().describe('Items per page (default: 25)'),
	},
	async ({ collectionId, status, locale, search, page, limit }) => {
		const result = await client.listContent({ collectionId, status, locale, search, page, limit })
		const items = result.data.map((item) => {
			const title = (item.metadata as Record<string, unknown>)?.title || item.slug
			return `- [${item.status}] ${title} (${item.slug}) — id: ${item.id}`
		})
		return {
			content: [
				{ type: 'text', text: `Found ${result.pagination.total} items:\n${items.join('\n')}` },
			],
		}
	},
)

// Get content
server.tool(
	'get_content',
	'Get a single content item by ID with full markdown',
	{ id: z.string().describe('Content item UUID') },
	async ({ id }) => {
		const item = await client.getContent(id)
		const title = (item.metadata as Record<string, unknown>)?.title || item.slug
		const text = [
			`# ${title}`,
			``,
			`**Slug:** ${item.slug} | **Status:** ${item.status} | **Version:** ${item.version}`,
			``,
			item.markdown,
		].join('\n')
		return { content: [{ type: 'text', text }] }
	},
)

// Create content
server.tool(
	'create_content',
	'Create new content from markdown. Created as draft by default.',
	{
		slug: z.string().describe('URL-friendly slug'),
		collectionId: z.string().describe('Collection UUID'),
		markdown: z.string().describe('Full markdown content'),
		metadata: z.record(z.unknown()).optional().describe('Metadata (title, tags, etc.)'),
		locale: z.string().optional().describe('Content locale (default: en)'),
		status: z.enum(['draft', 'published']).optional().describe('Initial status'),
	},
	async (args) => {
		const created = await client.createContent(args)
		return {
			content: [
				{
					type: 'text',
					text: `Content created.\nID: ${created.id}\nSlug: ${created.slug}\nStatus: ${created.status}`,
				},
			],
		}
	},
)

// Update content
server.tool(
	'update_content',
	'Update an existing content item. Only provide fields to change.',
	{
		id: z.string().describe('Content item UUID'),
		slug: z.string().optional().describe('New slug'),
		markdown: z.string().optional().describe('Updated markdown'),
		metadata: z.record(z.unknown()).optional().describe('Updated metadata'),
		status: z.enum(['draft', 'published', 'archived']).optional().describe('New status'),
	},
	async ({ id, ...updates }) => {
		const updated = await client.updateContent(id, updates)
		return {
			content: [{ type: 'text', text: `Content updated. Version: ${updated.version}` }],
		}
	},
)

// Publish content
server.tool(
	'publish_content',
	'Publish a content item (changes status to published)',
	{ id: z.string().describe('Content item UUID') },
	async ({ id }) => {
		const published = await client.publishContent(id)
		return {
			content: [
				{ type: 'text', text: `Published. ID: ${published.id} at ${published.publishedAt}` },
			],
		}
	},
)

// Search content
server.tool(
	'search_content',
	'Search content by keyword across markdown and metadata',
	{ query: z.string().describe('Search query') },
	async ({ query }) => {
		const results = await client.searchContent(query)
		if (results.data.length === 0) {
			return { content: [{ type: 'text', text: 'No content found.' }] }
		}
		const items = results.data.map((item) => {
			const title = (item.metadata as Record<string, unknown>)?.title || item.slug
			return `- ${title} (${item.slug}) — ${item.status}`
		})
		return {
			content: [
				{ type: 'text', text: `Found ${results.pagination.total} results:\n${items.join('\n')}` },
			],
		}
	},
)

const transport = new StdioServerTransport()
await server.connect(transport)
