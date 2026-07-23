import { COLLECTION_TEMPLATES } from '@innolope/config'
import { InnolopeApiError } from '@innolope/sdk'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import type { InnolopeClient } from './api-client.js'

/**
 * Register every Innolope MCP tool on `server`, backed by `client`. Shared by both
 * transports: the stdio entry (`index.ts`) and the HTTP transport hosted in the API.
 * Each transport constructs its own `server` + `client` pair, so the client's
 * "current project" (set by `use_project`/`create_project`) is naturally per-session.
 */
export function registerTools(server: McpServer, client: InnolopeClient): void {
	// Instrument all tool calls for PostHog analytics by wrapping server.tool so the
	// handler (always the last arg) reports timing/success back to the API.
	const originalTool = server.tool.bind(server)
	server.tool = ((name: string, ...rest: unknown[]) => {
		const handler = rest[rest.length - 1] as (...args: unknown[]) => Promise<unknown>
		rest[rest.length - 1] = async (...args: unknown[]) => {
			const start = Date.now()
			try {
				const result = await handler(...args)
				client.trackToolCall({
					tool: name,
					durationMs: Date.now() - start,
					success: true,
					params: args[0] as Record<string, unknown>,
				})
				return result
			} catch (err) {
				client.trackToolCall({
					tool: name,
					durationMs: Date.now() - start,
					success: false,
					error: err instanceof Error ? err.message : String(err),
					params: args[0] as Record<string, unknown>,
				})
				throw err
			}
		}
		return (originalTool as (...a: unknown[]) => unknown)(name, ...rest)
	}) as typeof server.tool

	const text = (body: string) => ({ content: [{ type: 'text' as const, text: body }] })

	// --- Project lifecycle & provisioning -------------------------------------

	server.tool(
		'list_projects',
		'List the projects the current credential can access, with id, slug, name, and role. Use this to discover an existing project or confirm one before calling use_project.',
		{},
		async () => {
			const projects = await client.listProjects()
			if (projects.length === 0) {
				return text('No projects yet. Call create_project to make one.')
			}
			const lines = projects.map(
				(p) => `- ${p.name} (slug: ${p.slug}, id: ${p.id})${p.role ? ` — ${p.role}` : ''}`,
			)
			const current = client.getProjectId()
			return text(
				`${projects.length} project(s):\n${lines.join('\n')}${current ? `\n\nActive project: ${current}` : ''}`,
			)
		},
	)

	server.tool(
		'use_project',
		'Select the active project for subsequent tool calls. Provide either a projectId or a slug. All content/collection tools operate on the active project.',
		{
			projectId: z.string().optional().describe('Project UUID to activate'),
			slug: z.string().optional().describe('Project slug to activate (resolved via list_projects)'),
		},
		async ({ projectId, slug }) => {
			let id = projectId
			if (!id && slug) {
				const projects = await client.listProjects()
				const match = projects.find((p) => p.slug === slug)
				if (!match) return text(`No project found with slug "${slug}". Try list_projects.`)
				id = match.id
			}
			if (!id) return text('Provide a projectId or slug.')
			client.setProject(id)
			return text(`Active project set to ${id}.`)
		},
	)

	server.tool(
		'create_project',
		'Create a new, empty project and make it the active project. Returns the new project id. After creating, use create_collection to add content types and get_connection_string to obtain a per-project API key. Note: the Community plan allows only 1 project.',
		{
			name: z.string().describe('Human-readable project name'),
			slug: z
				.string()
				.describe(
					'URL-friendly slug (lowercase, hyphens). Non-conforming characters are normalized.',
				),
		},
		async ({ name, slug }) => {
			try {
				const project = await client.createProject({ name, slug })
				client.setProject(project.id)
				return text(
					`Project created and activated.\nName: ${project.name}\nSlug: ${project.slug}\nID: ${project.id}\n\nNext: create_collection to add content types, then get_connection_string for a per-project API key.`,
				)
			} catch (err) {
				if (err instanceof InnolopeApiError && err.status === 403) {
					const body = err.body as { error?: string; upgradeUrl?: string } | undefined
					const upgrade = body?.upgradeUrl ? ` Upgrade at ${body.upgradeUrl}.` : ''
					return text(
						`Could not create the project: ${body?.error || err.message}.${upgrade}\nYou can still work in an existing project — call list_projects then use_project.`,
					)
				}
				throw err
			}
		},
	)

	server.tool(
		'create_collection',
		'Create a content collection (content type) in the active project. Either pass an explicit field schema, or pass a template name from list_templates to use a predefined schema. Requires an active project (call create_project or use_project first).',
		{
			name: z.string().describe('Collection name (unique per project, e.g. "articles")'),
			label: z.string().optional().describe('Display label (defaults to name)'),
			description: z.string().optional().describe('Collection description'),
			fields: z
				.array(z.record(z.unknown()))
				.optional()
				.describe('Explicit field definitions (see get_collection_schema for the shape)'),
			titleField: z.string().optional().describe('Name of the field used as the display title'),
			template: z
				.string()
				.optional()
				.describe(
					'Template name from list_templates (e.g. "knowledge-base"). Fills label/description/fields.',
				),
		},
		async ({ name, label, description, fields, titleField, template }) => {
			if (!client.getProjectId()) {
				return text('No active project. Call create_project or use_project first.')
			}
			let resolvedLabel = label
			let resolvedDescription = description
			let resolvedFields: unknown[] | undefined = fields
			if (template) {
				const tpl = COLLECTION_TEMPLATES.find((t) => t.name === template)
				if (!tpl) {
					const available = COLLECTION_TEMPLATES.map((t) => t.name).join(', ')
					return text(`Unknown template "${template}". Available: ${available}.`)
				}
				resolvedLabel = resolvedLabel ?? tpl.label
				resolvedDescription = resolvedDescription ?? tpl.description
				resolvedFields = resolvedFields ?? (tpl.fields as unknown[])
			}
			const created = await client.createCollection({
				name,
				label: resolvedLabel ?? name,
				description: resolvedDescription,
				fields: resolvedFields,
				titleField: titleField ?? null,
			})
			return text(
				`Collection created.\nName: ${created.name}\nID: ${created.id}\nFields: ${
					created.fields.map((f) => f.name).join(', ') || 'none'
				}`,
			)
		},
	)

	server.tool(
		'get_connection_string',
		'Mint a project-scoped API key for the active project and return it as a ready-to-use connection string (API URL + key). Use this to wire the project into an app, the SDK, or a per-project MCP config. The key is shown once — save it. Requires an active project.',
		{
			name: z.string().optional().describe('Label for the key (default: "MCP-generated key")'),
			permissions: z
				.array(z.string())
				.optional()
				.describe('Granular permissions (default: full access ["*"])'),
		},
		async ({ name, permissions }) => {
			const projectId = client.getProjectId()
			if (!projectId) {
				return text('No active project. Call create_project or use_project first.')
			}
			const key = await client.createProjectApiKey({
				name: name ?? 'MCP-generated key',
				permissions,
			})
			return text(
				[
					'Connection string minted (save the key now — it will not be shown again):',
					'',
					`API URL:   ${client.apiUrl}`,
					`API Key:   ${key.key}`,
					`Project:   ${key.projectId}`,
					'',
					'MCP config env:',
					`  INNOLOPE_API_URL=${client.apiUrl}`,
					`  INNOLOPE_API_KEY=${key.key}`,
				].join('\n'),
			)
		},
	)

	server.tool(
		'import_content',
		'Import multiple content items into a collection in the active project (author-into-new-project). Accepts up to 50 items per call; call repeatedly for larger sets. Each item needs slug, collectionId, and markdown. Requires an active project.',
		{
			items: z
				.array(
					z.object({
						slug: z
							.string()
							.optional()
							.describe('URL-friendly slug. Optional — derived from metadata.title or heading.'),
						collectionId: z.string().describe('Target collection UUID'),
						markdown: z.string().describe('Markdown content'),
						metadata: z.record(z.unknown()).optional().describe('Metadata fields'),
						locale: z.string().optional().describe('Locale (default: en)'),
						status: z.enum(['draft', 'published']).optional().describe('Status (default: draft)'),
						createdAt: z
							.string()
							.datetime()
							.optional()
							.describe('Original creation timestamp (ISO 8601)'),
						updatedAt: z
							.string()
							.datetime()
							.optional()
							.describe('Original last-edit timestamp (ISO 8601)'),
						publishedAt: z
							.string()
							.datetime()
							.optional()
							.describe('Original publish timestamp (ISO 8601)'),
					}),
				)
				.describe('Content items to import'),
		},
		async ({ items }) => {
			if (!client.getProjectId()) {
				return text('No active project. Call create_project or use_project first.')
			}
			const result = await client.bulkCreateContent(items)
			return text(
				`Imported ${result.count} item(s):\n${result.data.map((i) => `- ${i.slug} (${i.id})`).join('\n')}`,
			)
		},
	)

	// --- External database import ----------------------------------------------

	server.tool(
		'test_external_database',
		'Test a connection to an external database (PostgreSQL, MySQL, MongoDB, Supabase, Neon, Vercel Postgres, CockroachDB, Firebase) for the active project. Use this before configure_external_database. Requires an active project.',
		{
			type: z
				.enum([
					'postgresql',
					'mysql',
					'mongodb',
					'supabase',
					'neon',
					'vercel-postgres',
					'cockroachdb',
					'firebase',
				])
				.describe('Database type'),
			connectionString: z.string().describe('Connection string (or Firebase service-account JSON)'),
			database: z.string().optional().describe('Database name (MongoDB)'),
		},
		async ({ type, connectionString, database }) => {
			if (!client.getProjectId()) {
				return text('No active project. Call create_project or use_project first.')
			}
			const result = await client.testExternalDatabase({ type, connectionString, database })
			return text(
				result.ok ? `Connection OK: ${result.message}` : `Connection failed: ${result.message}`,
			)
		},
	)

	server.tool(
		'scan_external_database',
		'List the tables/collections in an external database, with columns and row counts, so you can choose what to import. Requires an active project.',
		{
			type: z
				.enum([
					'postgresql',
					'mysql',
					'mongodb',
					'supabase',
					'neon',
					'vercel-postgres',
					'cockroachdb',
					'firebase',
				])
				.describe('Database type'),
			connectionString: z.string().describe('Connection string (or Firebase service-account JSON)'),
			database: z.string().optional().describe('Database name (MongoDB)'),
		},
		async ({ type, connectionString, database }) => {
			if (!client.getProjectId()) {
				return text('No active project. Call create_project or use_project first.')
			}
			const result = await client.scanExternalDatabase({ type, connectionString, database })
			if (result.tables.length === 0) return text('No tables found.')
			const lines = result.tables.map(
				(t) => `- ${t.name} (${t.count} rows, ${t.columns.length} columns)`,
			)
			return text(`Found ${result.tables.length} table(s):\n${lines.join('\n')}`)
		},
	)

	server.tool(
		'configure_external_database',
		'Attach an external database to the active project and start importing the selected tables into the CMS as content. Each selected table becomes a collection and a background import job is enqueued — poll get_import_status for progress. Pass the tables from scan_external_database. Requires an active project.',
		{
			type: z
				.enum([
					'postgresql',
					'mysql',
					'mongodb',
					'supabase',
					'neon',
					'vercel-postgres',
					'cockroachdb',
					'firebase',
				])
				.describe('Database type'),
			connectionString: z.string().describe('Connection string (or Firebase service-account JSON)'),
			database: z.string().optional().describe('Database name (MongoDB)'),
			tables: z
				.array(
					z.object({
						name: z.string().describe('Table/collection name'),
						columns: z
							.array(z.object({ name: z.string(), type: z.string() }))
							.describe('Columns from scan_external_database'),
						count: z.number().optional().describe('Row count (from scan)'),
					}),
				)
				.describe('Tables to import (subset of scan_external_database results)'),
			accessMode: z
				.enum(['read-write', 'read-only'])
				.optional()
				.describe('Whether edits sync back to the source (default: read-write)'),
		},
		async ({ type, connectionString, database, tables, accessMode }) => {
			if (!client.getProjectId()) {
				return text('No active project. Call create_project or use_project first.')
			}
			await client.configureExternalDatabase({
				type,
				connectionString,
				database,
				tables,
				accessMode,
				visibleTables: tables.map((t) => t.name),
			})
			return text(
				`External database attached. Import started for ${tables.length} table(s): ${tables
					.map((t) => t.name)
					.join(', ')}.\nPoll get_import_status to track progress.`,
			)
		},
	)

	server.tool(
		'get_import_status',
		'Report progress of external-database import jobs for the active project. Use after configure_external_database to know when the import has finished. Requires an active project.',
		{},
		async () => {
			if (!client.getProjectId()) {
				return text('No active project. Call create_project or use_project first.')
			}
			const { summary, jobs } = await client.getImportStatus()
			if (jobs.length === 0) return text('No import jobs for this project.')
			const lines = jobs.map((j) => {
				const progress = j.total ? `${j.processed}/${j.total}` : `${j.processed}`
				const err = j.error ? ` — error: ${j.error}` : ''
				return `- ${j.collectionName || j.externalTable}: ${j.status} (${progress})${err}`
			})
			return text(
				`Import status — ${summary.completed}/${summary.total} completed, ${summary.running} running, ${summary.pending} pending, ${summary.failed} failed:\n${lines.join('\n')}`,
			)
		},
	)

	// --- Content ---------------------------------------------------------------

	server.tool(
		'list_content',
		'List content items from the CMS with optional filters. Example: list_content({ collectionId: "abc-123", status: "published" }) returns all published items in that collection. Supports pagination via page/limit.',
		{
			collectionId: z.string().optional().describe('Filter by collection UUID'),
			status: z
				.enum(['draft', 'pending_review', 'published', 'archived'])
				.optional()
				.describe('Filter by status'),
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
			return text(`Found ${result.pagination.total} items:\n${items.join('\n')}`)
		},
	)

	server.tool(
		'get_content',
		'Get a single content item by ID with full markdown body. Returns title, slug, status, version, and the complete markdown content.',
		{ id: z.string().describe('Content item UUID') },
		async ({ id }) => {
			const item = await client.getContent(id)
			client.trackAnalytics({ contentId: id, event: 'mcp_read', source: 'mcp' })
			const title = (item.metadata as Record<string, unknown>)?.title || item.slug
			return text(
				[
					`# ${title}`,
					``,
					`**Slug:** ${item.slug} | **Status:** ${item.status} | **Version:** ${item.version}`,
					``,
					item.markdown,
				].join('\n'),
			)
		},
	)

	server.tool(
		'create_content',
		'Create new content from markdown. Created as draft by default. Call get_collection_schema(collectionId) first to see the collection\'s fields (names, types, required) and set them via metadata. slug is optional — when omitted it is derived from metadata.title or the markdown heading. Pass createdAt/updatedAt/publishedAt (ISO 8601) when importing existing content to preserve original timestamps. Example: create_content({ collectionId: "...", markdown: "# Hello", metadata: { title: "My Article" } })',
		{
			slug: z
				.string()
				.optional()
				.describe(
					'URL-friendly slug. Optional — derived from metadata.title or the markdown heading.',
				),
			collectionId: z.string().describe('Collection UUID'),
			markdown: z.string().describe('Full markdown content'),
			metadata: z.record(z.unknown()).optional().describe('Metadata (title, tags, etc.)'),
			locale: z.string().optional().describe('Content locale (default: en)'),
			status: z.enum(['draft', 'published']).optional().describe('Initial status'),
			createdAt: z
				.string()
				.datetime()
				.optional()
				.describe('Original creation timestamp (ISO 8601). Defaults to now.'),
			updatedAt: z
				.string()
				.datetime()
				.optional()
				.describe('Original last-edit timestamp (ISO 8601). Defaults to now.'),
			publishedAt: z
				.string()
				.datetime()
				.optional()
				.describe('Original publish timestamp (ISO 8601).'),
		},
		async (args) => {
			const created = await client.createContent(args)
			return text(
				`Content created.\nID: ${created.id}\nSlug: ${created.slug}\nStatus: ${created.status}`,
			)
		},
	)

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
			return text(`Content updated. Version: ${updated.version}`)
		},
	)

	server.tool(
		'publish_content',
		'Publish a content item (changes status to published)',
		{ id: z.string().describe('Content item UUID') },
		async ({ id }) => {
			const published = await client.publishContent(id)
			return text(`Published. ID: ${published.id} at ${published.publishedAt}`)
		},
	)

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
			if (results.data.length === 0) return text('No content found.')
			const items = results.data.map((item) => {
				const title = (item.metadata as Record<string, unknown>)?.title || item.slug
				return `- ${title} (${item.slug}) — ${item.status}`
			})
			return text(`Found ${results.pagination.total} results:\n${items.join('\n')}`)
		},
	)

	server.tool(
		'semantic_search',
		'Search content using semantic similarity powered by vector embeddings. Unlike keyword search, this finds conceptually related content even when exact words differ. Requires AI features to be enabled. Example: semantic_search({ query: "how to configure authentication" }) finds content about auth setup even if it uses different terminology.',
		{
			query: z.string().describe('Natural language search query'),
			threshold: z
				.number()
				.optional()
				.describe('Similarity threshold 0-1 (default: 0.7). Lower = more results'),
			limit: z.number().optional().describe('Max results (default: 10)'),
			collectionId: z.string().optional().describe('Filter to specific collection UUID'),
			hybrid: z.boolean().optional().describe('Combine vector + keyword search (default: false)'),
		},
		async ({ query, threshold, limit, collectionId, hybrid }) => {
			try {
				const result = await client.semanticSearch({
					query,
					threshold,
					limit,
					collectionId,
					hybrid,
				})
				if (result.data.length === 0) return text('No semantically similar content found.')
				const items = result.data.map(
					(r) =>
						`- **${r.title}** (${r.slug}) — similarity: ${(r.similarity * 100).toFixed(1)}%${
							r.matchedChunk ? `\n  Match: "${r.matchedChunk.slice(0, 150)}..."` : ''
						}`,
				)
				return text(`Found ${result.data.length} results:\n\n${items.join('\n\n')}`)
			} catch (err) {
				return text(
					`Semantic search error: ${
						err instanceof Error ? err.message : 'Unknown error'
					}. Make sure AI features are enabled and OpenAI API key is configured.`,
				)
			}
		},
	)

	// --- Collections -----------------------------------------------------------

	server.tool(
		'list_collections',
		'List all content collections (content types) with their field schemas. Use this to understand what structured data is available before querying content. Example: list_collections() returns collection names, slugs, and field definitions.',
		{},
		async () => {
			const collections = await client.listCollections()
			const summary = collections
				.map((c) => {
					const fields = c.fields
						.map((f) => `${f.name} (${f.type}${f.required ? ', required' : ''})`)
						.join(', ')
					return `**${c.label}** (name: ${c.name}, id: ${c.id})\n  ${c.description || 'No description'}\n  Fields: ${fields || 'None'}`
				})
				.join('\n\n')
			return text(`${collections.length} collections:\n\n${summary}`)
		},
	)

	server.tool(
		'get_collection_schema',
		'Get the detailed schema of a specific collection, including all field definitions with types, requirements, and options.',
		{ id: z.string().describe('Collection UUID') },
		async ({ id }) => {
			const col = await client.getCollection(id)
			return text(JSON.stringify(col, null, 2))
		},
	)

	server.tool(
		'query_by_fields',
		'Filter content by specific metadata field values. More precise than keyword search. Example: query_by_fields({ collectionId: "abc", filters: { category: "pricing" } }) returns only content where metadata.category equals "pricing".',
		{
			collectionId: z.string().describe('Collection UUID to query'),
			filters: z
				.record(z.unknown())
				.describe('Metadata field filters, e.g. { category: "pricing", priority: "high" }'),
			page: z.number().optional().describe('Page number (default: 1)'),
			limit: z.number().optional().describe('Items per page (default: 25)'),
		},
		async ({ collectionId, filters, page, limit }) => {
			const result = await client.queryByFields(collectionId, filters, page, limit)
			const items = result.data.map((item) => {
				const title = (item.metadata as Record<string, unknown>)?.title || item.slug
				return `- [${item.status}] ${title} (${item.slug}) — id: ${item.id}`
			})
			return text(`Found ${result.pagination.total} items:\n${items.join('\n')}`)
		},
	)

	server.tool(
		'list_templates',
		'List available collection templates with predefined field schemas. Use these when creating new collections for common content types like Knowledge Base, FAQ, Product Catalog, Documentation, Changelog, or API Reference.',
		{},
		async () => {
			const summary = COLLECTION_TEMPLATES.map((t) => {
				const fields = t.fields
					.map((f) => `${f.name} (${f.type}${f.required ? ', required' : ''})`)
					.join(', ')
				return `**${t.label}** (${t.name})\n  ${t.description}\n  Fields: ${fields}`
			}).join('\n\n')
			return text(summary)
		},
	)

	// --- Bulk ------------------------------------------------------------------

	server.tool(
		'bulk_create',
		'Create multiple content items in one call. Maximum 50 items. Each item requires collectionId and markdown; slug is optional (derived from metadata.title or the markdown heading when omitted). Call get_collection_schema(collectionId) first to see the fields to set via metadata. Pass createdAt/updatedAt/publishedAt (ISO 8601) when importing existing content to preserve original timestamps.',
		{
			items: z
				.array(
					z.object({
						slug: z
							.string()
							.optional()
							.describe('URL-friendly slug. Optional — derived from metadata.title or heading.'),
						collectionId: z.string().describe('Collection UUID'),
						markdown: z.string().describe('Markdown content'),
						metadata: z.record(z.unknown()).optional().describe('Metadata fields'),
						locale: z.string().optional().describe('Locale (default: en)'),
						status: z.enum(['draft', 'published']).optional().describe('Status (default: draft)'),
						createdAt: z
							.string()
							.datetime()
							.optional()
							.describe('Original creation timestamp (ISO 8601). Defaults to now.'),
						updatedAt: z
							.string()
							.datetime()
							.optional()
							.describe('Original last-edit timestamp (ISO 8601). Defaults to now.'),
						publishedAt: z
							.string()
							.datetime()
							.optional()
							.describe('Original publish timestamp (ISO 8601).'),
					}),
				)
				.describe('Array of content items to create'),
		},
		async ({ items }) => {
			const result = await client.bulkCreateContent(items)
			return text(
				`Created ${result.count} items:\n${result.data.map((i) => `- ${i.slug} (${i.id})`).join('\n')}`,
			)
		},
	)

	server.tool(
		'bulk_update',
		'Update multiple content items in one call. Maximum 50 items. Each item requires an id; other fields are optional.',
		{
			items: z
				.array(
					z.object({
						id: z.string().describe('Content item UUID'),
						slug: z.string().optional().describe('New slug'),
						markdown: z.string().optional().describe('Updated markdown'),
						metadata: z.record(z.unknown()).optional().describe('Updated metadata'),
						status: z
							.enum(['draft', 'pending_review', 'published', 'archived'])
							.optional()
							.describe('New status'),
					}),
				)
				.describe('Array of content updates'),
		},
		async ({ items }) => {
			const result = await client.bulkUpdateContent(items)
			return text(`Updated ${result.count} items.`)
		},
	)

	// --- Relations, changelog, export, review ----------------------------------

	server.tool(
		'get_content_with_relations',
		'Fetch a content item and resolve any relation fields, returning the linked content inline. Useful for traversing content graphs.',
		{ id: z.string().describe('Content item UUID') },
		async ({ id }) => {
			const item = await client.getContent(id)
			client.trackAnalytics({ contentId: id, event: 'mcp_read', source: 'mcp' })

			const relations: Record<string, unknown> = {}
			try {
				const col = await client.getCollection(item.collectionId)
				const relationFields = col.fields.filter((f) => f.type === 'relation')
				for (const field of relationFields) {
					const relatedId = (item.metadata as Record<string, unknown>)?.[field.name]
					if (typeof relatedId === 'string') {
						try {
							const related = await client.getContent(relatedId)
							relations[field.name] = {
								id: related.id,
								slug: related.slug,
								title: (related.metadata as Record<string, unknown>)?.title || related.slug,
							}
						} catch {
							/* relation target may not exist */
						}
					}
				}
			} catch {
				/* collection not found */
			}

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
			return text(parts.join('\n'))
		},
	)

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
			return text(`Recent changes (${result.data.length} items):\n${items.join('\n')}`)
		},
	)

	server.tool(
		'export_collection',
		'Export all content from a collection as JSONL. Useful for backup, migration, or processing content in bulk.',
		{
			collectionId: z.string().optional().describe('Collection UUID to export (omit for all)'),
			status: z
				.enum(['draft', 'pending_review', 'published', 'archived'])
				.optional()
				.describe('Filter by status'),
		},
		async ({ collectionId, status }) => {
			const result = await client.exportContent({ collectionId, status, format: 'jsonl' })
			const lineCount = result.split('\n').filter(Boolean).length
			return text(`Exported ${lineCount} items:\n\n${result}`)
		},
	)

	server.tool(
		'submit_for_review',
		'Submit a draft content item for editorial review. Changes status from draft to pending_review. Requires review-workflows license.',
		{ id: z.string().describe('Content item UUID') },
		async ({ id }) => {
			const submitted = await client.submitForReview(id)
			return text(`Submitted for review. ID: ${submitted.id}, slug: ${submitted.slug}`)
		},
	)
}
