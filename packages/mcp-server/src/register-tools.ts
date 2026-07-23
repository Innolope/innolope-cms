import {
	COLLECTION_TEMPLATES,
	CONTENT_STATUSES,
	CREATABLE_CONTENT_STATUSES,
} from '@innolope/config'
import { InnolopeApiError } from '@innolope/sdk'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import type { InnolopeClient } from './api-client.js'

/**
 * Every tool declares an operation type; annotations (readOnlyHint/destructiveHint),
 * read-only mode, and the disabled-tools list are all derived from it — no
 * per-tool policy code (pattern borrowed from mongodb-mcp-server's ToolBase).
 */
type OperationType = 'read' | 'metadata' | 'create' | 'update' | 'delete'

interface ToolResult {
	[key: string]: unknown
	content: Array<{ type: 'text'; text: string }>
	structuredContent?: Record<string, unknown>
	isError?: boolean
}

export interface RegisterToolsOptions {
	/** Register only read/metadata tools. Defaults to env INNOLOPE_MCP_READ_ONLY. */
	readOnly?: boolean
	/**
	 * Tool names or operation types to skip registering.
	 * Defaults to env INNOLOPE_MCP_DISABLED_TOOLS (comma-separated).
	 */
	disabledTools?: string[]
}

/**
 * Server-side ceiling for a single tool response. A per-call parameter can only
 * lower it (min(toolParam, server) — never raise it past the server config).
 */
const SERVER_MAX_RESPONSE_BYTES = (() => {
	const parsed = Number(process.env.INNOLOPE_MCP_MAX_RESPONSE_BYTES)
	return Number.isFinite(parsed) && parsed > 0 ? parsed : 100_000
})()

/** Default byte budget for a single content body (get_content and friends). */
const DEFAULT_CONTENT_BYTES = 50_000

const NO_PROJECT_MESSAGE =
	'No active project. Call use_project (or create_project) first — list_projects shows what is available.'

/**
 * Truncate `body` to min(toolLimit, server max) bytes, appending which limit
 * applied and how to get the rest — so the model knows the response is partial
 * and what to do about it, instead of silently reasoning over a cut-off text.
 */
function capText(body: string, hint: string, toolLimit?: number): string {
	const limit = Math.min(toolLimit ?? SERVER_MAX_RESPONSE_BYTES, SERVER_MAX_RESPONSE_BYTES)
	const total = Buffer.byteLength(body, 'utf8')
	if (total <= limit) return body
	// Slice on the byte budget, then drop any trailing partial UTF-8 sequence.
	const sliced = Buffer.from(body, 'utf8').subarray(0, limit).toString('utf8').replace(/�+$/, '')
	const which =
		toolLimit !== undefined && toolLimit <= SERVER_MAX_RESPONSE_BYTES
			? 'the maxBytes parameter'
			: "the server's configured maximum response size"
	return `${sliced}\n\n[Truncated: showing ${Buffer.byteLength(sliced, 'utf8')} of ${total} bytes (capped by ${which}). ${hint}]`
}

/**
 * Render a content item's metadata as an explicit fenced-JSON block. Without
 * this, records created via the `metadata` parameter looked like the write had
 * dropped every custom field on read-back (imported records only appeared
 * complete because their frontmatter happens to live inside the markdown).
 */
function renderMetadataBlock(metadata: Record<string, unknown> | undefined): string[] {
	const keys = Object.keys(metadata ?? {})
	if (!metadata || keys.length === 0) return []
	return [
		``,
		`**Metadata** (${keys.length} field${keys.length === 1 ? '' : 's'}):`,
		'```json',
		JSON.stringify(metadata, null, 2),
		'```',
	]
}

interface ItemError {
	index: number
	slug?: string
	id?: string
	errors: Array<{ field: string; message: string }>
}

/** Render bulk per-item validation errors as an indented bullet list. */
function renderItemErrors(items: ItemError[]): string {
	return items
		.map((it) => {
			const label = it.slug ? ` (slug "${it.slug}")` : it.id ? ` (id ${it.id})` : ''
			const details = it.errors.map((e) => `    - ${e.field}: ${e.message}`).join('\n')
			return `- item ${it.index}${label}:\n${details}`
		})
		.join('\n')
}

/**
 * Turn an API error into a message the model can act on. The REST layer already
 * echoes field errors and the collection schema in its 400 body — surface that
 * here instead of dropping it, and add "call this tool next" guidance by status.
 */
function formatApiError(err: InnolopeApiError): string {
	const body = (err.body ?? {}) as Record<string, unknown>
	const parts: string[] = [err.message]

	// Fastify's generic errors carry the real cause in `message`, not `error`
	// (e.g. { error: "Bad Request", message: "body must have ..." }).
	if (typeof body.message === 'string' && body.message !== body.error) {
		parts.push(body.message)
	}

	// Single-item schema validation body: { error, fields, schema }
	const fieldErrors = body.fields as Array<{ field: string; message: string }> | undefined
	if (Array.isArray(fieldErrors) && fieldErrors.length > 0) {
		parts.push('Field errors:')
		for (const f of fieldErrors) parts.push(`- ${f.field}: ${f.message}`)
	}

	// Bulk validation body: { error, items, schemas? }
	const itemErrors = body.items as ItemError[] | undefined
	if (Array.isArray(itemErrors) && itemErrors.length > 0) {
		parts.push('Per-item errors:')
		parts.push(renderItemErrors(itemErrors))
	}

	if (Array.isArray(body.schema) && body.schema.length > 0) {
		parts.push(
			`Collection schema (set these fields via metadata):\n${JSON.stringify(body.schema, null, 2)}`,
		)
	}
	if (body.schemas && typeof body.schemas === 'object' && Object.keys(body.schemas).length > 0) {
		parts.push(`Collection schemas by collectionId:\n${JSON.stringify(body.schemas, null, 2)}`)
	}

	const guidance = guidanceForStatus(err.status, body)
	if (guidance) parts.push(guidance)
	return parts.join('\n')
}

/** Next-step guidance per HTTP status — errors double as navigation for the agent. */
function guidanceForStatus(status: number, body: Record<string, unknown>): string {
	switch (status) {
		case 400:
			return Array.isArray(body.fields) || Array.isArray(body.items)
				? 'Fix the listed fields and retry. Call get_collection_schema(collectionId) to see the full field schema.'
				: 'Check the arguments against the tool description and retry.'
		case 401:
			return 'The credential was rejected. Verify the API key (INNOLOPE_API_KEY) or re-authenticate, then retry.'
		case 403: {
			const upgrade = typeof body.upgradeUrl === 'string' ? ` Upgrade at ${body.upgradeUrl}.` : ''
			return `The current role or license does not allow this operation.${upgrade}`
		}
		case 404:
			return 'Check the id — call list_projects, list_collections, or list_content to discover valid ids.'
		case 409:
			return 'A content item with this slug and locale already exists. Pass a different slug, or update the existing item instead.'
		case 502:
			return 'Syncing to the external database failed. Retry, or verify the connection with test_external_database.'
		default:
			return ''
	}
}

/**
 * Register every Innolope MCP tool on `server`, backed by `client`. Shared by both
 * transports: the stdio entry (`index.ts`) and the HTTP transport hosted in the API.
 * Each transport constructs its own `server` + `client` pair, so the client's
 * "current project" (set by `use_project`/`create_project`) is naturally per-session.
 */
export function registerTools(
	server: McpServer,
	client: InnolopeClient,
	options: RegisterToolsOptions = {},
): void {
	const readOnly =
		options.readOnly ?? ['1', 'true'].includes(process.env.INNOLOPE_MCP_READ_ONLY ?? '')
	const disabled = new Set(
		options.disabledTools ??
			(process.env.INNOLOPE_MCP_DISABLED_TOOLS ?? '')
				.split(',')
				.map((s) => s.trim())
				.filter(Boolean),
	)

	const text = (body: string): ToolResult => ({
		content: [{ type: 'text' as const, text: body }],
	})
	const fail = (body: string): ToolResult => ({
		isError: true,
		content: [{ type: 'text' as const, text: body }],
	})

	/**
	 * Register one tool: derives annotations from its operation type, applies
	 * read-only/disabled gating (unregistered tools are invisible to the client,
	 * not just rejected), reports usage to PostHog, and funnels every failure
	 * through one formatter so all errors come back as isError results with
	 * actionable text — handlers never leak raw throws to the SDK.
	 */
	function defineTool<Shape extends z.ZodRawShape>(def: {
		name: string
		description: string
		operationType: OperationType
		schema: Shape
		outputSchema?: z.ZodRawShape
		handler: (args: z.objectOutputType<Shape, z.ZodTypeAny>) => Promise<ToolResult>
	}): void {
		if (disabled.has(def.name) || disabled.has(def.operationType)) return
		if (readOnly && def.operationType !== 'read' && def.operationType !== 'metadata') return

		const isRead = def.operationType === 'read' || def.operationType === 'metadata'
		const annotations = {
			title: def.name,
			readOnlyHint: isRead,
			destructiveHint: def.operationType === 'delete',
		}

		const handler = async (args: z.objectOutputType<Shape, z.ZodTypeAny>): Promise<ToolResult> => {
			const start = Date.now()
			const params = args as Record<string, unknown>
			try {
				const result = await def.handler(args)
				client.trackToolCall({
					tool: def.name,
					durationMs: Date.now() - start,
					success: result.isError !== true,
					...(result.isError === true && { error: result.content[0]?.text }),
					params,
				})
				return result
			} catch (err) {
				client.trackToolCall({
					tool: def.name,
					durationMs: Date.now() - start,
					success: false,
					error: err instanceof Error ? err.message : String(err),
					params,
				})
				const message =
					err instanceof InnolopeApiError
						? formatApiError(err)
						: err instanceof Error
							? err.message
							: String(err)
				return fail(`Error running ${def.name}: ${message}`)
			}
		}

		server.registerTool(
			def.name,
			{
				description: def.description,
				inputSchema: def.schema,
				...(def.outputSchema && { outputSchema: def.outputSchema }),
				annotations,
			},
			handler as never,
		)
	}

	/** Shared guard: fail (isError) when no project is active, instead of success-shaped text. */
	const requireProject = (): ToolResult | null =>
		client.getProjectId() ? null : fail(NO_PROJECT_MESSAGE)

	/**
	 * Echo the active project in every project-scoped response, so a response
	 * that raced ahead of a use_project switch is visibly for the wrong project
	 * instead of silently plausible. Empty when the credential is project-scoped
	 * and no explicit project was selected (the server resolves it).
	 */
	const projectSuffix = () => {
		const id = client.getProjectId()
		return id ? ` (project: ${id})` : ''
	}

	const contentSummaryShape = {
		id: z.string(),
		slug: z.string().nullable(),
		status: z.string(),
		title: z.string(),
		externalId: z.string().nullable(),
	}
	const listOutputSchema = {
		projectId: z.string().nullable(),
		total: z.number(),
		page: z.number(),
		limit: z.number(),
		items: z.array(z.object(contentSummaryShape)),
	}
	const collectionFieldSchema = z
		.object({
			name: z.string(),
			type: z.string(),
			required: z.boolean().optional(),
			localized: z.boolean().optional(),
			options: z.array(z.string()).optional(),
		})
		.passthrough()

	const summarize = (item: {
		id: string
		slug: string | null
		status: string
		metadata: unknown
		externalId?: string | null
	}) => {
		const title = (item.metadata as Record<string, unknown>)?.title
		return {
			id: item.id,
			slug: item.slug,
			status: item.status,
			title: String(title ?? item.slug ?? item.id),
			externalId: item.externalId ?? null,
		}
	}

	// --- Project lifecycle & provisioning -------------------------------------

	defineTool({
		name: 'list_projects',
		description:
			'List the projects the current credential can access, with id, slug, name, and role. Use this to discover an existing project or confirm one before calling use_project.',
		operationType: 'metadata',
		schema: {},
		handler: async () => {
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
	})

	defineTool({
		name: 'use_project',
		description:
			'Select the active project for subsequent tool calls. Provide either a projectId or a slug. All content/collection tools operate on the active project.',
		operationType: 'metadata',
		schema: {
			projectId: z.string().uuid().optional().describe('Project UUID to activate'),
			slug: z.string().optional().describe('Project slug to activate (resolved via list_projects)'),
		},
		handler: async ({ projectId, slug }) => {
			let id = projectId
			let label: string | undefined
			if (!id && slug) {
				const projects = await client.listProjects()
				const match = projects.find((p) => p.slug === slug)
				if (!match)
					return fail(
						`No project found with slug "${slug}". Call list_projects to see valid slugs.`,
					)
				id = match.id
				label = `${match.name} (slug: ${match.slug})`
			}
			if (!id) return fail('Provide a projectId or slug (see list_projects).')
			if (!label) {
				const match = (await client.listProjects().catch(() => [])).find((p) => p.id === id)
				if (match) label = `${match.name} (slug: ${match.slug})`
			}
			client.setProject(id)
			return text(
				`Active project set to ${id}${label ? ` — ${label}` : ''}. Project-scoped responses echo this project id; if a response shows a different id, it raced ahead of this switch — retry it.`,
			)
		},
	})

	defineTool({
		name: 'create_project',
		description:
			'Create a new, empty project and make it the active project. Returns the new project id. After creating, use create_collection to add content types and get_connection_string to obtain a per-project API key. Note: the Community plan allows only 1 project.',
		operationType: 'create',
		schema: {
			name: z.string().describe('Human-readable project name'),
			slug: z
				.string()
				.describe(
					'URL-friendly slug (lowercase, hyphens). Non-conforming characters are normalized.',
				),
		},
		handler: async ({ name, slug }) => {
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
					return fail(
						`Could not create the project: ${body?.error || err.message}.${upgrade}\nYou can still work in an existing project — call list_projects then use_project.`,
					)
				}
				throw err
			}
		},
	})

	defineTool({
		name: 'create_collection',
		description:
			'Create a content collection (content type) in the active project. Either pass an explicit field schema, or pass a template name from list_templates to use a predefined schema. Requires an active project (call create_project or use_project first).',
		operationType: 'create',
		schema: {
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
		handler: async ({ name, label, description, fields, titleField, template }) => {
			const guard = requireProject()
			if (guard) return guard
			let resolvedLabel = label
			let resolvedDescription = description
			let resolvedFields: unknown[] | undefined = fields
			if (template) {
				const tpl = COLLECTION_TEMPLATES.find((t) => t.name === template)
				if (!tpl) {
					const available = COLLECTION_TEMPLATES.map((t) => t.name).join(', ')
					return fail(`Unknown template "${template}". Available: ${available}.`)
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
	})

	defineTool({
		name: 'get_connection_string',
		description:
			'Mint a project-scoped API key for the active project and return it as a ready-to-use connection string (API URL + key). Use this to wire the project into an app, the SDK, or a per-project MCP config. The key is shown once — save it. Requires an active project.',
		operationType: 'create',
		schema: {
			name: z.string().optional().describe('Label for the key (default: "MCP-generated key")'),
			permissions: z
				.array(z.string())
				.optional()
				.describe('Granular permissions (default: full access ["*"])'),
		},
		handler: async ({ name, permissions }) => {
			const guard = requireProject()
			if (guard) return guard
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
	})

	const bulkItemShape = {
		slug: z
			.string()
			.optional()
			.describe(
				'URL-friendly slug: lowercase letters/digits separated by "-" or "_" (snake_case is preserved as-is; anything else is normalized — spaces/punctuation become "-"). Optional — derived from metadata.title or heading.',
			),
		collectionId: z.string().uuid().describe('Target collection UUID'),
		markdown: z.string().describe('Markdown content'),
		metadata: z.record(z.unknown()).optional().describe('Metadata fields'),
		locale: z.string().optional().describe('Locale (default: en)'),
		status: z
			.enum(CREATABLE_CONTENT_STATUSES)
			.optional()
			.describe('Status (default: draft). Use submit_for_review for the review workflow.'),
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
	}

	/** Shared handler for import_content / bulk_create (same endpoint, same semantics). */
	const bulkCreateHandler = async ({
		items,
		dryRun,
	}: {
		items: Array<z.objectOutputType<typeof bulkItemShape, z.ZodTypeAny>>
		dryRun?: boolean
	}): Promise<ToolResult> => {
		const guard = requireProject()
		if (guard) return guard
		const result = await client.bulkCreateContent(items, { dryRun })
		if (result.dryRun) {
			if (result.errors && result.errors.length > 0) {
				const schemas = result.schemas
					? `\n\nCollection schemas by collectionId:\n${JSON.stringify(result.schemas, null, 2)}`
					: ''
				return text(
					`Dry run: ${result.valid}/${result.total} items valid. Nothing was written. Problems:\n${renderItemErrors(result.errors)}${schemas}\n\nFix the listed items and re-run (with dryRun: false to actually create).`,
				)
			}
			return text(
				`Dry run: all ${result.total} item(s) are valid. Nothing was written — re-call without dryRun to create them.`,
			)
		}
		return text(
			`Created ${result.count} item(s):\n${(result.data ?? []).map((i) => `- ${i.slug} (${i.id})`).join('\n')}`,
		)
	}

	defineTool({
		name: 'import_content',
		description:
			'Import multiple content items into a collection in the active project (author-into-new-project). Accepts up to 50 items per call; call repeatedly for larger sets. Each item needs collectionId and markdown (slug is derived when omitted). The batch is all-or-nothing: if any item is invalid, nothing is written and every problem is reported. Pass dryRun: true first to validate a batch without writing. Requires an active project.',
		operationType: 'create',
		schema: {
			items: z.array(z.object(bulkItemShape)).describe('Content items to import'),
			dryRun: z
				.boolean()
				.optional()
				.describe('Validate the batch and report problems without writing anything.'),
		},
		handler: bulkCreateHandler,
	})

	// --- External database import ----------------------------------------------

	const externalDbTypes = z
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
		.describe('Database type')

	defineTool({
		name: 'test_external_database',
		description:
			'Test a connection to an external database (PostgreSQL, MySQL, MongoDB, Supabase, Neon, Vercel Postgres, CockroachDB, Firebase) for the active project. Use this before configure_external_database. Requires an active project.',
		operationType: 'metadata',
		schema: {
			type: externalDbTypes,
			connectionString: z.string().describe('Connection string (or Firebase service-account JSON)'),
			database: z.string().optional().describe('Database name (MongoDB)'),
		},
		handler: async ({ type, connectionString, database }) => {
			const guard = requireProject()
			if (guard) return guard
			const result = await client.testExternalDatabase({ type, connectionString, database })
			return result.ok
				? text(`Connection OK: ${result.message}`)
				: fail(`Connection failed: ${result.message}`)
		},
	})

	defineTool({
		name: 'scan_external_database',
		description:
			'List the tables/collections in an external database, with columns and row counts, so you can choose what to import. Requires an active project.',
		operationType: 'metadata',
		schema: {
			type: externalDbTypes,
			connectionString: z.string().describe('Connection string (or Firebase service-account JSON)'),
			database: z.string().optional().describe('Database name (MongoDB)'),
		},
		handler: async ({ type, connectionString, database }) => {
			const guard = requireProject()
			if (guard) return guard
			const result = await client.scanExternalDatabase({ type, connectionString, database })
			if (result.tables.length === 0) return text('No tables found.')
			const lines = result.tables.map(
				(t) => `- ${t.name} (${t.count} rows, ${t.columns.length} columns)`,
			)
			return text(`Found ${result.tables.length} table(s):\n${lines.join('\n')}`)
		},
	})

	defineTool({
		name: 'configure_external_database',
		description:
			'Attach an external database to the active project and start importing the selected tables into the CMS as content. Each selected table becomes a collection and a background import job is enqueued — poll get_import_status for progress. Pass the tables from scan_external_database. Requires an active project.',
		operationType: 'update',
		schema: {
			type: externalDbTypes,
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
		handler: async ({ type, connectionString, database, tables, accessMode }) => {
			const guard = requireProject()
			if (guard) return guard
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
	})

	defineTool({
		name: 'get_import_status',
		description:
			'Report progress of external-database import jobs for the active project. Use after configure_external_database to know when the import has finished. Requires an active project.',
		operationType: 'metadata',
		schema: {},
		handler: async () => {
			const guard = requireProject()
			if (guard) return guard
			const { summary, jobs } = await client.getImportStatus()
			if (jobs.length === 0) return text('No import jobs for this project.')
			const lines = jobs.map((j) => {
				const progress = j.total ? `${j.processed}/${j.total}` : `${j.processed}`
				const err = j.error ? ` — error: ${j.error}` : ''
				return `- ${j.collectionName || j.externalTable}: ${j.status} (${progress})${err}`
			})
			return text(
				`Import status${projectSuffix()} — ${summary.completed}/${summary.total} completed, ${summary.running} running, ${summary.pending} pending, ${summary.failed} failed:\n${lines.join('\n')}`,
			)
		},
	})

	// --- Content ---------------------------------------------------------------

	defineTool({
		name: 'list_content',
		description:
			'List content items from the CMS with optional filters. Example: list_content({ collectionId: "abc-123", status: "published" }) returns all published items in that collection. Supports pagination via page/limit (limit is capped at 100 server-side).',
		operationType: 'read',
		schema: {
			collectionId: z.string().uuid().optional().describe('Filter by collection UUID'),
			status: z.enum(CONTENT_STATUSES).optional().describe('Filter by status'),
			locale: z.string().optional().describe('Filter by locale'),
			search: z.string().optional().describe('Full-text search query'),
			page: z.number().optional().describe('Page number (default: 1)'),
			limit: z.number().optional().describe('Items per page (default: 25, max: 100)'),
		},
		outputSchema: listOutputSchema,
		handler: async ({ collectionId, status, locale, search, page, limit }) => {
			const result = await client.listContent({ collectionId, status, locale, search, page, limit })
			const summaries = result.data.map(summarize)
			const lines = summaries.map((s) => `- [${s.status}] ${s.title} (${s.slug}) — id: ${s.id}`)
			return {
				...text(`Found ${result.pagination.total} items${projectSuffix()}:\n${lines.join('\n')}`),
				structuredContent: {
					projectId: client.getProjectId() ?? null,
					total: result.pagination.total,
					page: result.pagination.page,
					limit: result.pagination.limit,
					items: summaries,
				},
			}
		},
	})

	defineTool({
		name: 'get_content',
		description:
			'Get a single content item by ID: title, slug, status, version, external id (for external collections), ALL metadata fields as JSON, and the full markdown body (truncated at maxBytes — the response says when truncation applied). For external collections the id may be the external record id; pass collectionId as well when the record is not cached in the CMS yet.',
		operationType: 'read',
		schema: {
			id: z.string().describe('Content item UUID (or external record id for external collections)'),
			collectionId: z
				.string()
				.uuid()
				.optional()
				.describe('Collection UUID — required to resolve uncached external record ids'),
			maxBytes: z
				.number()
				.int()
				.positive()
				.optional()
				.describe(`Maximum response size in bytes (default: ${DEFAULT_CONTENT_BYTES})`),
		},
		outputSchema: {
			id: z.string(),
			slug: z.string().nullable(),
			status: z.string(),
			version: z.number(),
			title: z.string(),
			externalId: z.string().nullable(),
			metadata: z.record(z.unknown()),
		},
		handler: async ({ id, collectionId, maxBytes }) => {
			const item = await client.getContent(id, collectionId)
			client.trackAnalytics({ contentId: id, event: 'mcp_read', source: 'mcp' })
			const title = (item.metadata as Record<string, unknown>)?.title || item.slug
			const body = [
				`# ${title}`,
				``,
				`**Slug:** ${item.slug} | **Status:** ${item.status} | **Version:** ${item.version}${
					item.externalId ? ` | **External ID:** ${item.externalId}` : ''
				}`,
				...renderMetadataBlock(item.metadata),
				``,
				item.markdown,
			].join('\n')
			return {
				...text(
					capText(
						body,
						'Re-call get_content with a larger maxBytes to see more.',
						maxBytes ?? DEFAULT_CONTENT_BYTES,
					),
				),
				structuredContent: {
					id: item.id,
					slug: item.slug ?? null,
					status: item.status,
					version: item.version,
					title: String(title ?? item.id),
					externalId: item.externalId ?? null,
					metadata: item.metadata ?? {},
				},
			}
		},
	})

	defineTool({
		name: 'create_content',
		description:
			'Create new content from markdown. Created as draft by default. Call get_collection_schema(collectionId) first to see the collection\'s fields (names, types, required) and set them via metadata. slug is optional — when omitted it is derived from metadata.title or the markdown heading. Pass createdAt/updatedAt/publishedAt (ISO 8601) when importing existing content to preserve original timestamps. Example: create_content({ collectionId: "...", markdown: "# Hello", metadata: { title: "My Article" } })',
		operationType: 'create',
		schema: {
			slug: z
				.string()
				.optional()
				.describe(
					'URL-friendly slug: lowercase letters/digits separated by "-" or "_" (snake_case is preserved as-is; anything else is normalized — spaces/punctuation become "-"). Optional — derived from metadata.title or the markdown heading.',
				),
			collectionId: z.string().uuid().describe('Collection UUID'),
			markdown: z.string().describe('Full markdown content'),
			metadata: z.record(z.unknown()).optional().describe('Metadata (title, tags, etc.)'),
			locale: z.string().optional().describe('Content locale (default: en)'),
			status: z
				.enum(CREATABLE_CONTENT_STATUSES)
				.optional()
				.describe(
					'Initial status (default: draft). Use submit_for_review for the review workflow.',
				),
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
		handler: async (args) => {
			const created = await client.createContent(args)
			const slugNote =
				args.slug && created.slug && args.slug !== created.slug
					? `\nNote: the slug was normalized from "${args.slug}" to "${created.slug}" (lowercase letters/digits; separators "-" and "_" are kept, everything else becomes "-").`
					: ''
			return text(
				`Content created${projectSuffix()}.\nID: ${created.id}\nSlug: ${created.slug}\nStatus: ${created.status}${
					created.externalId ? `\nExternal ID: ${created.externalId}` : ''
				}${slugNote}`,
			)
		},
	})

	defineTool({
		name: 'update_content',
		description:
			'Update an existing content item. Only provide fields to change. metadata is validated against the collection schema merged with the current values; required fields are enforced when the result is published.',
		operationType: 'update',
		schema: {
			id: z.string().uuid().describe('Content item UUID'),
			slug: z.string().optional().describe('New slug'),
			markdown: z.string().optional().describe('Updated markdown'),
			metadata: z.record(z.unknown()).optional().describe('Updated metadata'),
			status: z.enum(CONTENT_STATUSES).optional().describe('New status'),
		},
		handler: async ({ id, ...updates }) => {
			const updated = await client.updateContent(id, updates)
			return text(`Content updated. Version: ${updated.version}`)
		},
	})

	defineTool({
		name: 'publish_content',
		description:
			'Publish a content item: sets status to published and stamps publishedAt. Fails with field errors if required collection fields are missing — fill them via update_content first (see get_collection_schema).',
		operationType: 'update',
		schema: { id: z.string().uuid().describe('Content item UUID') },
		handler: async ({ id }) => {
			const published = await client.publishContent(id)
			return text(`Published. ID: ${published.id} at ${published.publishedAt}`)
		},
	})

	defineTool({
		name: 'delete_content',
		description:
			'Permanently delete a content item by ID. For external (MongoDB/SQL) collections this also removes the backing external record — the id may be the external record id, and collectionId should be passed when the record is not cached in the CMS yet. Requires project admin access. This cannot be undone. Two-step: call WITHOUT confirm first to get a summary of what would be deleted, then re-call with confirm: true to actually delete.',
		operationType: 'delete',
		schema: {
			id: z.string().describe('Content item UUID (or external record id for external collections)'),
			collectionId: z
				.string()
				.uuid()
				.optional()
				.describe('Collection UUID — required to resolve uncached external record ids'),
			confirm: z
				.boolean()
				.optional()
				.describe('Must be true to actually delete. Omit to preview what would be deleted.'),
		},
		handler: async ({ id, collectionId, confirm }) => {
			if (confirm !== true) {
				const item = await client.getContent(id, collectionId)
				const title = (item.metadata as Record<string, unknown>)?.title || item.slug
				return text(
					`This will PERMANENTLY delete "${title}" (slug: ${item.slug}, status: ${item.status}, version: ${item.version}, id: ${item.id}), including any backing external database record. This cannot be undone.\n\nNothing was deleted. Re-call delete_content with confirm: true to proceed.`,
				)
			}
			const result = await client.deleteContent(id, collectionId)
			if (result?.externalCleanup === 'failed') {
				return text(
					`Deleted content ${id} from the CMS, but with a warning:\n${result.message ?? 'Removing the backing external database record failed — it needs manual cleanup.'}`,
				)
			}
			return text(`Deleted content ${id}.`)
		},
	})

	defineTool({
		name: 'search_content',
		description:
			'Keyword search across markdown bodies and metadata (case-insensitive substring match). Returns matching items with slug, status, and id — use get_content(id) to read a match. For concept-level matching when exact words differ, use semantic_search; to filter on exact metadata field values, use query_by_fields.',
		operationType: 'read',
		schema: { query: z.string().describe('Search query') },
		handler: async ({ query }) => {
			const results = await client.searchContent(query)
			client.trackAnalytics({
				event: results.data.length > 0 ? 'search_hit' : 'search_miss',
				query,
				source: 'mcp',
			})
			if (results.data.length === 0) return text(`No content found${projectSuffix()}.`)
			const items = results.data.map((item) => {
				const title = (item.metadata as Record<string, unknown>)?.title || item.slug
				return `- ${title} (${item.slug}) — ${item.status}`
			})
			return text(
				`Found ${results.pagination.total} results${projectSuffix()}:\n${items.join('\n')}`,
			)
		},
	})

	defineTool({
		name: 'semantic_search',
		description:
			'Search content using semantic similarity powered by vector embeddings. Unlike keyword search, this finds conceptually related content even when exact words differ. Requires AI features to be enabled. Example: semantic_search({ query: "how to configure authentication" }) finds content about auth setup even if it uses different terminology.',
		operationType: 'read',
		schema: {
			query: z.string().describe('Natural language search query'),
			threshold: z
				.number()
				.optional()
				.describe('Similarity threshold 0-1 (default: 0.7). Lower = more results'),
			limit: z.number().optional().describe('Max results (default: 10)'),
			collectionId: z.string().uuid().optional().describe('Filter to specific collection UUID'),
			hybrid: z.boolean().optional().describe('Combine vector + keyword search (default: false)'),
		},
		handler: async ({ query, threshold, limit, collectionId, hybrid }) => {
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
				return fail(
					`Semantic search error: ${
						err instanceof Error ? err.message : 'Unknown error'
					}. Make sure AI features are enabled and an OpenAI API key is configured. Falling back to search_content (keyword) also works.`,
				)
			}
		},
	})

	// --- Collections -----------------------------------------------------------

	defineTool({
		name: 'list_collections',
		description:
			'List all content collections (content types) with their field schemas. Use this to understand what structured data is available before querying content. Example: list_collections() returns collection names, slugs, and field definitions.',
		operationType: 'metadata',
		schema: {},
		outputSchema: {
			projectId: z.string().nullable(),
			collections: z.array(
				z
					.object({
						id: z.string(),
						name: z.string(),
						label: z.string(),
						description: z.string().nullable().optional(),
						fields: z.array(collectionFieldSchema),
					})
					.passthrough(),
			),
		},
		handler: async () => {
			const collections = await client.listCollections()
			const summary = collections
				.map((c) => {
					const fields = c.fields
						.map((f) => `${f.name} (${f.type}${f.required ? ', required' : ''})`)
						.join(', ')
					return `**${c.label}** (name: ${c.name}, id: ${c.id})\n  ${c.description || 'No description'}\n  Fields: ${fields || 'None'}`
				})
				.join('\n\n')
			return {
				...text(`${collections.length} collections${projectSuffix()}:\n\n${summary}`),
				// Project to the declared output shape — structuredContent is validated
				// strictly against outputSchema (no additional top-level properties).
				structuredContent: {
					projectId: client.getProjectId() ?? null,
					collections: collections.map((c) => ({
						id: c.id,
						name: c.name,
						label: c.label,
						description: c.description ?? null,
						fields: c.fields,
					})),
				},
			}
		},
	})

	defineTool({
		name: 'get_collection_schema',
		description:
			'Get the detailed schema of a specific collection, including all field definitions with types, requirements, and options. Call this before create_content / bulk_create to know which metadata fields to set.',
		operationType: 'metadata',
		schema: { id: z.string().uuid().describe('Collection UUID') },
		outputSchema: {
			id: z.string(),
			name: z.string(),
			label: z.string(),
			description: z.string().nullable().optional(),
			fields: z.array(collectionFieldSchema),
		},
		handler: async ({ id }) => {
			const col = await client.getCollection(id)
			return {
				...text(JSON.stringify(col, null, 2)),
				// Project to the declared output shape — structuredContent is validated
				// strictly against outputSchema; the text channel carries the full JSON.
				structuredContent: {
					id: col.id,
					name: col.name,
					label: col.label,
					description: col.description ?? null,
					fields: col.fields,
				},
			}
		},
	})

	defineTool({
		name: 'query_by_fields',
		description:
			'Filter content by exact metadata field values. More precise than keyword search. Field names must exist in the collection schema (see get_collection_schema); invalid names are rejected. Example: query_by_fields({ collectionId: "abc", filters: { category: "pricing" } }) returns only content where metadata.category equals "pricing".',
		operationType: 'read',
		schema: {
			collectionId: z.string().uuid().describe('Collection UUID to query'),
			filters: z
				.record(z.unknown())
				.describe('Metadata field filters, e.g. { category: "pricing", priority: "high" }'),
			page: z.number().optional().describe('Page number (default: 1)'),
			limit: z.number().optional().describe('Items per page (default: 25)'),
		},
		outputSchema: listOutputSchema,
		handler: async ({ collectionId, filters, page, limit }) => {
			const result = await client.queryByFields(collectionId, filters, page, limit)
			const summaries = result.data.map(summarize)
			const lines = summaries.map((s) => `- [${s.status}] ${s.title} (${s.slug}) — id: ${s.id}`)
			return {
				...text(`Found ${result.pagination.total} items${projectSuffix()}:\n${lines.join('\n')}`),
				structuredContent: {
					projectId: client.getProjectId() ?? null,
					total: result.pagination.total,
					page: result.pagination.page,
					limit: result.pagination.limit,
					items: summaries,
				},
			}
		},
	})

	defineTool({
		name: 'list_templates',
		description:
			'List available collection templates with predefined field schemas. Use these when creating new collections for common content types like Knowledge Base, FAQ, Product Catalog, Documentation, Changelog, or API Reference.',
		operationType: 'metadata',
		schema: {},
		handler: async () => {
			const summary = COLLECTION_TEMPLATES.map((t) => {
				const fields = t.fields
					.map((f) => `${f.name} (${f.type}${f.required ? ', required' : ''})`)
					.join(', ')
				return `**${t.label}** (${t.name})\n  ${t.description}\n  Fields: ${fields}`
			}).join('\n\n')
			return text(summary)
		},
	})

	// --- Bulk ------------------------------------------------------------------

	defineTool({
		name: 'bulk_create',
		description:
			'Create multiple content items in one call. Maximum 50 items. Each item requires collectionId and markdown; slug is optional (derived from metadata.title or the markdown heading when omitted). Call get_collection_schema(collectionId) first to see the fields to set via metadata. The batch is all-or-nothing: if any item is invalid, nothing is created and every problem is reported per item. Pass dryRun: true first to validate the batch without writing. Pass createdAt/updatedAt/publishedAt (ISO 8601) when importing existing content to preserve original timestamps.',
		operationType: 'create',
		schema: {
			items: z.array(z.object(bulkItemShape)).describe('Array of content items to create'),
			dryRun: z
				.boolean()
				.optional()
				.describe('Validate the batch and report problems without writing anything.'),
		},
		handler: bulkCreateHandler,
	})

	defineTool({
		name: 'bulk_update',
		description:
			"Update multiple content items in one call. Maximum 50 items. Each item requires an id; other fields are optional. Metadata is validated merged with each item's current values. The batch is all-or-nothing: if any item is invalid, nothing is updated and every problem is reported per item. Pass dryRun: true first to validate without writing.",
		operationType: 'update',
		schema: {
			items: z
				.array(
					z.object({
						id: z.string().uuid().describe('Content item UUID'),
						slug: z.string().optional().describe('New slug'),
						markdown: z.string().optional().describe('Updated markdown'),
						metadata: z.record(z.unknown()).optional().describe('Updated metadata'),
						status: z.enum(CONTENT_STATUSES).optional().describe('New status'),
					}),
				)
				.describe('Array of content updates'),
			dryRun: z
				.boolean()
				.optional()
				.describe('Validate the batch and report problems without writing anything.'),
		},
		handler: async ({ items, dryRun }) => {
			const result = await client.bulkUpdateContent(items, { dryRun })
			if (result.dryRun) {
				if (result.errors && result.errors.length > 0) {
					return text(
						`Dry run: ${result.valid}/${result.total} items valid. Nothing was written. Problems:\n${renderItemErrors(result.errors)}\n\nFix the listed items and re-run (with dryRun: false to actually update).`,
					)
				}
				return text(
					`Dry run: all ${result.total} item(s) are valid. Nothing was written — re-call without dryRun to update them.`,
				)
			}
			return text(`Updated ${result.count} items.`)
		},
	})

	// --- Relations, changelog, export, review ----------------------------------

	defineTool({
		name: 'get_content_with_relations',
		description:
			'Fetch a content item and resolve any relation fields, returning the linked content inline. Useful for traversing content graphs. The response is truncated at maxBytes (the response says when truncation applied).',
		operationType: 'read',
		schema: {
			id: z.string().describe('Content item UUID (or external record id for external collections)'),
			collectionId: z
				.string()
				.uuid()
				.optional()
				.describe('Collection UUID — required to resolve uncached external record ids'),
			maxBytes: z
				.number()
				.int()
				.positive()
				.optional()
				.describe(`Maximum response size in bytes (default: ${DEFAULT_CONTENT_BYTES})`),
		},
		handler: async ({ id, collectionId, maxBytes }) => {
			const item = await client.getContent(id, collectionId)
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
				`**Slug:** ${item.slug} | **Status:** ${item.status} | **Version:** ${item.version}${
					item.externalId ? ` | **External ID:** ${item.externalId}` : ''
				}`,
			]
			if (Object.keys(relations).length > 0) {
				parts.push(``, `**Relations:**`)
				for (const [field, rel] of Object.entries(relations)) {
					const r = rel as { id: string; slug: string; title: string }
					parts.push(`  - ${field}: ${r.title} (${r.slug}, id: ${r.id})`)
				}
			}
			parts.push(...renderMetadataBlock(item.metadata))
			parts.push(``, item.markdown)
			return text(
				capText(
					parts.join('\n'),
					'Re-call get_content_with_relations with a larger maxBytes to see more.',
					maxBytes ?? DEFAULT_CONTENT_BYTES,
				),
			)
		},
	})

	defineTool({
		name: 'get_changelog',
		description:
			'Get recently updated items for a collection, ordered by last update, with version and updatedAt. Useful for cache invalidation. Note: this lists which items changed and when — not field-level diffs.',
		operationType: 'read',
		schema: {
			collectionId: z.string().uuid().describe('Collection UUID'),
			limit: z.number().optional().describe('Number of recent items (default: 10)'),
		},
		handler: async ({ collectionId, limit }) => {
			const result = await client.listContent({ collectionId, limit: limit || 10 })
			const items = result.data.map((item) => {
				const title = (item.metadata as Record<string, unknown>)?.title || item.slug
				return `- [${item.status}] ${title} — v${item.version}, updated ${item.updatedAt}`
			})
			return text(
				`Recent changes (${result.data.length} items)${projectSuffix()}:\n${items.join('\n')}`,
			)
		},
	})

	const EXPORT_MAX_ROWS = 100

	defineTool({
		name: 'export_collection',
		description: `Export content from a collection as JSONL, windowed by limit/offset (max ${EXPORT_MAX_ROWS} rows per call — page through with offset for larger sets). Pass fields to project only specific metadata fields and keep responses small. For full unbounded dumps use the REST endpoint GET /api/v1/content/export instead.`,
		operationType: 'read',
		schema: {
			collectionId: z
				.string()
				.uuid()
				.optional()
				.describe('Collection UUID to export (omit for all)'),
			status: z.enum(CONTENT_STATUSES).optional().describe('Filter by status'),
			limit: z
				.number()
				.int()
				.min(1)
				.max(EXPORT_MAX_ROWS)
				.optional()
				.describe(`Rows per call (default: 50, max: ${EXPORT_MAX_ROWS})`),
			offset: z.number().int().min(0).optional().describe('Row offset for paging (default: 0)'),
			fields: z
				.string()
				.optional()
				.describe('Comma-separated metadata fields to include (omit for all metadata)'),
		},
		handler: async ({ collectionId, status, limit, offset, fields }) => {
			const rows = limit ?? 50
			const start = offset ?? 0
			const result = await client.exportContent({
				collectionId,
				status,
				fields,
				limit: rows,
				offset: start,
				format: 'jsonl',
			})
			const lineCount = result.split('\n').filter(Boolean).length
			const more =
				lineCount === rows
					? `There may be more — call again with offset: ${start + rows}.`
					: 'End of results.'
			const body = `Exported ${lineCount} item(s) (offset ${start})${projectSuffix()}. ${more}\n\n${result}`
			return text(
				capText(body, 'Reduce limit, pass fields to project fewer columns, or page with offset.'),
			)
		},
	})

	defineTool({
		name: 'submit_for_review',
		description:
			'Submit a draft content item for editorial review: sets status from draft to pending_review so an editor can approve and publish it. Use this instead of setting status directly when the project uses a review workflow. Requires the review-workflows license.',
		operationType: 'update',
		schema: { id: z.string().uuid().describe('Content item UUID') },
		handler: async ({ id }) => {
			const submitted = await client.submitForReview(id)
			return text(`Submitted for review. ID: ${submitted.id}, slug: ${submitted.slug}`)
		},
	})
}
