#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { InnolopeClient } from './api-client.js'
import { COLLECTION_TEMPLATES } from '@innolope/config'

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

// Instrument all tool calls for PostHog analytics
const originalTool = server.tool.bind(server)
server.tool = ((name: string, ...rest: unknown[]) => {
	// server.tool(name, description, schema, handler) — handler is always last
	const handler = rest[rest.length - 1] as (...args: unknown[]) => Promise<unknown>
	rest[rest.length - 1] = async (...args: unknown[]) => {
		const start = Date.now()
		try {
			const result = await handler(...args)
			client.trackToolCall({ tool: name, durationMs: Date.now() - start, success: true, params: args[0] as Record<string, unknown> })
			return result
		} catch (err) {
			client.trackToolCall({ tool: name, durationMs: Date.now() - start, success: false, error: err instanceof Error ? err.message : String(err), params: args[0] as Record<string, unknown> })
			throw err
		}
	}
	return (originalTool as (...a: unknown[]) => unknown)(name, ...rest)
}) as typeof server.tool

// List content
server.tool(
	'list_content',
	'List content items from the CMS with optional filters. Example: list_content({ collectionId: "abc-123", status: "published" }) returns all published items in that collection. Supports pagination via page/limit.',
	{
		collectionId: z.string().optional().describe('Filter by collection UUID'),
		status: z.enum(['draft', 'pending_review', 'published', 'archived']).optional().describe('Filter by status'),
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
	'Get a single content item by ID with full markdown body. Returns title, slug, status, version, and the complete markdown content.',
	{ id: z.string().describe('Content item UUID') },
	async ({ id }) => {
		const item = await client.getContent(id)
		client.trackAnalytics({ contentId: id, event: 'mcp_read', source: 'mcp' })
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
	'Create new content from markdown. Created as draft by default. Use metadata to set structured fields like title, tags, category. Pass createdAt/updatedAt/publishedAt (ISO 8601) when importing existing content to preserve original timestamps. Example: create_content({ slug: "my-article", collectionId: "...", markdown: "# Hello", metadata: { title: "My Article" } })',
	{
		slug: z.string().describe('URL-friendly slug'),
		collectionId: z.string().describe('Collection UUID'),
		markdown: z.string().describe('Full markdown content'),
		metadata: z.record(z.unknown()).optional().describe('Metadata (title, tags, etc.)'),
		locale: z.string().optional().describe('Content locale (default: en)'),
		status: z.enum(['draft', 'published']).optional().describe('Initial status'),
		createdAt: z.string().datetime().optional().describe('Original creation timestamp (ISO 8601). Defaults to now.'),
		updatedAt: z.string().datetime().optional().describe('Original last-edit timestamp (ISO 8601). Defaults to now.'),
		publishedAt: z.string().datetime().optional().describe('Original publish timestamp (ISO 8601).'),
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
		client.trackAnalytics({
			event: results.data.length > 0 ? 'search_hit' : 'search_miss',
			query,
			source: 'mcp',
		})
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

// Semantic search
server.tool(
	'semantic_search',
	'Search content using semantic similarity powered by vector embeddings. Unlike keyword search, this finds conceptually related content even when exact words differ. Requires AI features to be enabled. Example: semantic_search({ query: "how to configure authentication" }) finds content about auth setup even if it uses different terminology.',
	{
		query: z.string().describe('Natural language search query'),
		threshold: z.number().optional().describe('Similarity threshold 0-1 (default: 0.7). Lower = more results'),
		limit: z.number().optional().describe('Max results (default: 10)'),
		collectionId: z.string().optional().describe('Filter to specific collection UUID'),
		hybrid: z.boolean().optional().describe('Combine vector + keyword search (default: false)'),
	},
	async ({ query, threshold, limit, collectionId, hybrid }) => {
		try {
			const result = await client.semanticSearch({ query, threshold, limit, collectionId, hybrid })
			if (result.data.length === 0) {
				return { content: [{ type: 'text', text: 'No semantically similar content found.' }] }
			}
			const items = result.data.map((r) =>
				`- **${r.title}** (${r.slug}) — similarity: ${(r.similarity * 100).toFixed(1)}%${r.matchedChunk ? `\n  Match: "${r.matchedChunk.slice(0, 150)}..."` : ''}`,
			)
			return {
				content: [{ type: 'text', text: `Found ${result.data.length} results:\n\n${items.join('\n\n')}` }],
			}
		} catch (err) {
			return {
				content: [{ type: 'text', text: `Semantic search error: ${err instanceof Error ? err.message : 'Unknown error'}. Make sure AI features are enabled and OpenAI API key is configured.` }],
			}
		}
	},
)

// List collections with field schemas
server.tool(
	'list_collections',
	'List all content collections (content types) with their field schemas. Use this to understand what structured data is available before querying content. Example: list_collections() returns collection names, slugs, and field definitions.',
	{},
	async () => {
		const collections = await client.listCollections()
		const summary = collections.map((c) => {
			const fields = c.fields.map((f) => `${f.name} (${f.type}${f.required ? ', required' : ''})`).join(', ')
			return `**${c.label}** (name: ${c.name}, id: ${c.id})\n  ${c.description || 'No description'}\n  Fields: ${fields || 'None'}`
		}).join('\n\n')
		return { content: [{ type: 'text', text: `${collections.length} collections:\n\n${summary}` }] }
	},
)

// Get collection schema
server.tool(
	'get_collection_schema',
	'Get the detailed schema of a specific collection, including all field definitions with types, requirements, and options.',
	{ id: z.string().describe('Collection UUID') },
	async ({ id }) => {
		const col = await client.getCollection(id)
		return { content: [{ type: 'text', text: JSON.stringify(col, null, 2) }] }
	},
)

// Query content by metadata fields
server.tool(
	'query_by_fields',
	'Filter content by specific metadata field values. More precise than keyword search. Example: query_by_fields({ collectionId: "abc", filters: { category: "pricing" } }) returns only content where metadata.category equals "pricing".',
	{
		collectionId: z.string().describe('Collection UUID to query'),
		filters: z.record(z.unknown()).describe('Metadata field filters, e.g. { category: "pricing", priority: "high" }'),
		page: z.number().optional().describe('Page number (default: 1)'),
		limit: z.number().optional().describe('Items per page (default: 25)'),
	},
	async ({ collectionId, filters, page, limit }) => {
		const result = await client.queryByFields(collectionId, filters, page, limit)
		const items = result.data.map((item) => {
			const title = (item.metadata as Record<string, unknown>)?.title || item.slug
			return `- [${item.status}] ${title} (${item.slug}) — id: ${item.id}`
		})
		return {
			content: [{ type: 'text', text: `Found ${result.pagination.total} items:\n${items.join('\n')}` }],
		}
	},
)

// Bulk create content
server.tool(
	'bulk_create',
	'Create multiple content items in one call. Maximum 50 items. Each item requires slug, collectionId, and markdown. Pass createdAt/updatedAt/publishedAt (ISO 8601) when importing existing content to preserve original timestamps.',
	{
		items: z.array(z.object({
			slug: z.string().describe('URL-friendly slug'),
			collectionId: z.string().describe('Collection UUID'),
			markdown: z.string().describe('Markdown content'),
			metadata: z.record(z.unknown()).optional().describe('Metadata fields'),
			locale: z.string().optional().describe('Locale (default: en)'),
			status: z.enum(['draft', 'published']).optional().describe('Status (default: draft)'),
			createdAt: z.string().datetime().optional().describe('Original creation timestamp (ISO 8601). Defaults to now.'),
			updatedAt: z.string().datetime().optional().describe('Original last-edit timestamp (ISO 8601). Defaults to now.'),
			publishedAt: z.string().datetime().optional().describe('Original publish timestamp (ISO 8601).'),
		})).describe('Array of content items to create'),
	},
	async ({ items }) => {
		const result = await client.bulkCreateContent(items)
		return {
			content: [{ type: 'text', text: `Created ${result.count} items:\n${result.data.map((i) => `- ${i.slug} (${i.id})`).join('\n')}` }],
		}
	},
)

// Bulk update content
server.tool(
	'bulk_update',
	'Update multiple content items in one call. Maximum 50 items. Each item requires an id; other fields are optional.',
	{
		items: z.array(z.object({
			id: z.string().describe('Content item UUID'),
			slug: z.string().optional().describe('New slug'),
			markdown: z.string().optional().describe('Updated markdown'),
			metadata: z.record(z.unknown()).optional().describe('Updated metadata'),
			status: z.enum(['draft', 'pending_review', 'published', 'archived']).optional().describe('New status'),
		})).describe('Array of content updates'),
	},
	async ({ items }) => {
		const result = await client.bulkUpdateContent(items)
		return {
			content: [{ type: 'text', text: `Updated ${result.count} items.` }],
		}
	},
)

// Get content with relations
server.tool(
	'get_content_with_relations',
	'Fetch a content item and resolve any relation fields, returning the linked content inline. Useful for traversing content graphs.',
	{
		id: z.string().describe('Content item UUID'),
	},
	async ({ id }) => {
		const item = await client.getContent(id)
		client.trackAnalytics({ contentId: id, event: 'mcp_read', source: 'mcp' })

		// Fetch collection schema to identify relation fields
		let relations: Record<string, unknown> = {}
		try {
			const col = await client.getCollection(item.collectionId)
			const relationFields = col.fields.filter((f) => f.type === 'relation')

			for (const field of relationFields) {
				const relatedId = (item.metadata as Record<string, unknown>)?.[field.name]
				if (typeof relatedId === 'string') {
					try {
						const related = await client.getContent(relatedId)
						relations[field.name] = { id: related.id, slug: related.slug, title: (related.metadata as Record<string, unknown>)?.title || related.slug }
					} catch { /* relation target may not exist */ }
				}
			}
		} catch { /* collection not found */ }

		const title = (item.metadata as Record<string, unknown>)?.title || item.slug
		const parts = [
			`# ${title}`,
			``,
			`**Slug:** ${item.slug} | **Status:** ${item.status} | **Version:** ${item.version}`,
		]
		if (Object.keys(relations).length > 0) {
			parts.push(``, `**Relations:**`)
			for (const [field, rel] of Object.entries(relations)) {
				const r = rel as { id: string; slug: string; title: string }
				parts.push(`  - ${field}: ${r.title} (${r.slug}, id: ${r.id})`)
			}
		}
		parts.push(``, item.markdown)

		return { content: [{ type: 'text', text: parts.join('\n') }] }
	},
)

// Get changelog for a collection
server.tool(
	'get_changelog',
	'Get recent changes for a collection, ordered by last update. Useful for tracking what has changed recently for cache invalidation.',
	{
		collectionId: z.string().describe('Collection UUID'),
		limit: z.number().optional().describe('Number of recent items (default: 10)'),
	},
	async ({ collectionId, limit }) => {
		const result = await client.listContent({ collectionId, limit: limit || 10 })
		const items = result.data.map((item) => {
			const title = (item.metadata as Record<string, unknown>)?.title || item.slug
			return `- [${item.status}] ${title} — v${item.version}, updated ${item.updatedAt}`
		})
		return {
			content: [{ type: 'text', text: `Recent changes (${result.data.length} items):\n${items.join('\n')}` }],
		}
	},
)

// Export collection content
server.tool(
	'export_collection',
	'Export all content from a collection as JSONL. Useful for backup, migration, or processing content in bulk.',
	{
		collectionId: z.string().optional().describe('Collection UUID to export (omit for all)'),
		status: z.enum(['draft', 'pending_review', 'published', 'archived']).optional().describe('Filter by status'),
	},
	async ({ collectionId, status }) => {
		const result = await client.exportContent({ collectionId, status, format: 'jsonl' })
		const lineCount = result.split('\n').filter(Boolean).length
		return {
			content: [{ type: 'text', text: `Exported ${lineCount} items:\n\n${result}` }],
		}
	},
)

// Submit for review
server.tool(
	'submit_for_review',
	'Submit a draft content item for editorial review. Changes status from draft to pending_review. Requires review-workflows license.',
	{ id: z.string().describe('Content item UUID') },
	async ({ id }) => {
		const submitted = await client.submitForReview(id)
		return {
			content: [
				{ type: 'text', text: `Submitted for review. ID: ${submitted.id}, slug: ${submitted.slug}` },
			],
		}
	},
)

// List collection templates
server.tool(
	'list_templates',
	'List available collection templates with predefined field schemas. Use these when creating new collections for common content types like Knowledge Base, FAQ, Product Catalog, Documentation, Changelog, or API Reference.',
	{},
	async () => {
		const summary = COLLECTION_TEMPLATES.map((t) => {
			const fields = t.fields.map((f) => `${f.name} (${f.type}${f.required ? ', required' : ''})`).join(', ')
			return `**${t.label}** (${t.name})\n  ${t.description}\n  Fields: ${fields}`
		}).join('\n\n')
		return { content: [{ type: 'text', text: summary }] }
	},
)

const transport = new StdioServerTransport()
await server.connect(transport)
