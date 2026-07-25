/**
 * The WHERE clause behind the content list.
 *
 * Shared by `GET /content` and the bulk-action endpoint so that "select all N
 * matching" acts on exactly the rows the list showed. If the two built their own
 * conditions, a filter the list understood but the bulk resolver didn't would
 * silently widen the selection — the worst possible bug in a feature whose main
 * action is delete.
 */

import { content } from '@innolope/db'
import { and, eq, inArray, type SQL, sql } from 'drizzle-orm'

/** The filter half of `contentListSchema` — paging and sorting play no part here. */
export interface ContentFilterParams {
	collectionId?: string
	status?: 'draft' | 'pending_review' | 'published' | 'archived' | 'scheduled'
	locale?: string
	search?: string
	updatedFrom?: string
	updatedTo?: string
	createdFrom?: string
	createdTo?: string
	publishedFrom?: string
	publishedTo?: string
	/** JSON-encoded object of metadata equality filters: `{"author":"x"}`. */
	metadata?: string
}

/**
 * Build the list's conditions for one project.
 *
 * `scopedCollectionIds` narrows the result to the collections a restricted
 * member may read; pass it only when the caller did not name a collection (the
 * same rule the list endpoint applies). Passing an empty array means "no
 * readable collections", which callers should treat as an empty result rather
 * than running the query.
 */
export function buildContentConditions(
	params: ContentFilterParams,
	opts: { projectId: string; scopedCollectionIds?: string[] },
): SQL[] {
	const conditions: SQL[] = [eq(content.projectId, opts.projectId) as SQL]

	if (params.status) conditions.push(eq(content.status, params.status) as SQL)
	if (params.collectionId) conditions.push(eq(content.collectionId, params.collectionId) as SQL)
	if (!params.collectionId && opts.scopedCollectionIds) {
		conditions.push(inArray(content.collectionId, opts.scopedCollectionIds) as SQL)
	}
	if (params.locale) conditions.push(eq(content.locale, params.locale) as SQL)
	if (params.search) {
		conditions.push(
			sql`(${content.markdown} ILIKE ${`%${params.search}%`} OR ${content.metadata}::text ILIKE ${`%${params.search}%`})`,
		)
	}

	// Date range filters — strings are passed through to Postgres, which parses them.
	if (params.updatedFrom) conditions.push(sql`${content.updatedAt} >= ${params.updatedFrom}`)
	if (params.updatedTo) conditions.push(sql`${content.updatedAt} <= ${params.updatedTo}`)
	if (params.createdFrom) conditions.push(sql`${content.createdAt} >= ${params.createdFrom}`)
	if (params.createdTo) conditions.push(sql`${content.createdAt} <= ${params.createdTo}`)
	if (params.publishedFrom) conditions.push(sql`${content.publishedAt} >= ${params.publishedFrom}`)
	if (params.publishedTo) conditions.push(sql`${content.publishedAt} <= ${params.publishedTo}`)

	// Metadata equality filters. Keys are checked against an identifier regex to
	// keep injection out of `sql.raw`; anything else is dropped rather than 400ing.
	if (params.metadata) {
		try {
			const parsed = JSON.parse(params.metadata) as Record<string, unknown>
			if (parsed && typeof parsed === 'object') {
				for (const [field, value] of Object.entries(parsed)) {
					if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(field)) continue
					if (value === null || value === undefined || value === '') continue
					conditions.push(sql`${content.metadata}->>${sql.raw(`'${field}'`)} = ${String(value)}`)
				}
			}
		} catch {
			// Ignore a malformed metadata param rather than 500ing.
		}
	}

	return conditions
}

/** Convenience wrapper: the conditions as a single `AND` expression. */
export function contentFilterWhere(
	params: ContentFilterParams,
	opts: { projectId: string; scopedCollectionIds?: string[] },
) {
	return and(...buildContentConditions(params, opts))
}
