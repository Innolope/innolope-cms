import { jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core'
import { projects } from './projects.js'

export const collections = pgTable(
	'collections',
	{
		id: uuid().defaultRandom().primaryKey(),
		projectId: uuid()
			.notNull()
			.references(() => projects.id, { onDelete: 'cascade' }),
		label: text().notNull(),
		name: text().notNull(),
		description: text(),
		fields: jsonb().$type<CollectionField[]>().notNull().default([]),
		// Name of the schema field whose value is used as the record's display
		// label in list views and reference pickers. Null means use the smart
		// heuristic in `apps/admin/src/lib/display-title.ts`.
		titleField: text(),
		source: text().notNull().default('internal'),
		externalTable: text(),
		accessMode: text().default('read-write'),
		// Controls whether this collection appears in the admin sidebar.
		// `auto` = hide if referenced as a `relationTo` target from another collection in this project.
		// `show` / `hide` are explicit overrides.
		sidebarMode: text({ enum: ['auto', 'show', 'hide'] })
			.notNull()
			.default('auto'),
		// Wall-clock time the local cache was last refreshed from the source.
		lastSyncedAt: timestamp({ withTimezone: true }),
		// High-watermark of the source's cursor column at the end of the last sync;
		// the next incremental sync pulls only rows with cursorColumn > this value.
		lastSyncedCursor: timestamp({ withTimezone: true }),
		// Source-table column used as the incremental cursor (e.g. updated_at).
		// Null means incremental mode is unavailable for this collection.
		cursorColumn: text(),
		// What the source table actually is — columns with their constraints, or a
		// MongoDB type histogram — as opposed to the editor-facing `fields`. The write
		// path restores native types and refuses impossible writes from it.
		sourceSchema: jsonb().$type<SourceSchema>(),
		// `sourceSchema.hash`, kept beside it for a cheap drift comparison.
		sourceSchemaHash: text(),
		// Per-collection options that are not part of the field schema.
		settings: jsonb().$type<CollectionSettings>().notNull().default({}),
		createdAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
		updatedAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
	},
	(table) => [uniqueIndex('collections_name_project_idx').on(table.name, table.projectId)],
)

export interface CollectionSettings {
	/**
	 * Where a record of this collection lives on the public site, e.g.
	 * `https://example.com/blog/{slug}/`. Placeholders: `{slug}`, `{locale}`,
	 * `{id}`. Unset means the collection has no public pages, so nothing of it is
	 * submitted to search engines.
	 */
	publicUrlTemplate?: string
}

export interface CollectionField {
	name: string
	/** Optional human-readable label shown by the form instead of `name`. */
	label?: string
	type: 'text' | 'number' | 'boolean' | 'date' | 'enum' | 'relation' | 'object' | 'array'
	required?: boolean
	localized?: boolean
	options?: string[]
	defaultValue?: unknown
	/** For `relation` fields on external collections: the external table this field references. */
	relationTo?: string
	/** Whether the relation field holds an array of references. */
	relationIsArray?: boolean
	/**
	 * Optional UI hints that override the default widget chosen from `type`.
	 * Stored alongside the field definition in the same JSONB blob so no
	 * separate migration is needed when adding new hints.
	 */
	ui?: CollectionFieldUi
}

export interface CollectionFieldUi {
	/**
	 * Widget identifier. Filtered by `type` at render time — see
	 * `apps/admin/src/components/editor/field-renderer.tsx` for the catalog
	 * and `defaultWidgetFor(field)` for the fallback.
	 */
	widget?: string
	placeholder?: string
	helpText?: string
	/** Number of visible rows when `widget === 'textarea'`. */
	rows?: number
	/** Chip-input separator. Defaults to 'enter'. */
	separator?: 'enter' | 'comma' | 'both'
	/** Render the field disabled — useful for system-managed values. */
	readOnly?: boolean
	/** Hide the field from edit forms entirely. */
	hidden?: boolean
	/** Structured sub-fields, used when `widget === 'subform'` on an object/array. */
	subFields?: CollectionField[]
	/**
	 * Shape preset this field renders as (`image`, `link`, `seo`, `money`, …, or
	 * `custom:<id>` for a project preset). Detected at scan time; see
	 * `apps/admin/src/lib/field-presets.ts` for the catalogue.
	 */
	preset?: string
	/**
	 * For `preset: 'rich-text'`: the editor-state format the source stores
	 * (`lexical`, `editorjs`, `portable-text`, `slate`), so a markdown write is
	 * converted back into it.
	 */
	richTextFormat?: 'lexical' | 'editorjs' | 'portable-text' | 'slate'
	/** Role → the key this field's documents use for it (`{ url: 'src' }`). */
	presetKeys?: Record<string, string>
	/** A human confirmed `preset` in the field designer; detection never sets this. */
	presetConfirmed?: boolean
	/** Sub-key whose value titles a collapsed row or card. */
	summaryKey?: string
	/** Whether editors may add keys the preset or sub-fields do not list. */
	allowExtraKeys?: boolean
	/**
	 * A value the CMS cannot model (mixed types, unknown structure). It round-trips
	 * untouched, renders read-only under Technical fields, and is written only when
	 * an admin edits it as JSON.
	 */
	opaque?: boolean
	/** Where the editor renders the field. `technical` collapses it at the bottom. */
	section?: 'main' | 'technical'
}

/**
 * What a connected source table actually is, as opposed to what the editor shows
 * (`fields`). Filled by a scan and refreshed when the source changes; the write
 * path uses it to restore native types and to refuse writes that cannot succeed.
 */
export interface SourceSchema {
	dialect: 'postgresql' | 'mysql' | 'mongodb'
	table: string
	/** SQL schema the table lives in (`public` on Postgres). */
	schema?: string
	/** Primary-key columns in key order. Empty when the table has none. */
	primaryKey: string[]
	/** SQL targets: one entry per column. */
	columns?: SourceColumn[]
	/** MongoDB: a type histogram per path, nested paths included (`items[].productId`). */
	paths?: SourcePath[]
	/** Documents sampled for `paths`. */
	sampled?: number
	/** Hash of the shape (not the sample counts), for cheap drift checks. */
	hash: string
	scannedAt: string
}

export interface SourceColumn {
	name: string
	/** `information_schema.columns.data_type`, e.g. `integer`, `USER-DEFINED`, `tinyint`. */
	nativeType: string
	/** Postgres `udt_name` (`int4`, `_text`, an enum's type name) or MySQL `column_type` (`tinyint(1)`). */
	udtName?: string
	nullable: boolean
	hasDefault: boolean
	isIdentity: boolean
	isGenerated: boolean
	maxLength?: number
	enumValues?: string[]
	isPrimaryKey: boolean
}

export interface SourcePath {
	/** Dotted path; `[]` marks array elements (`items[].productId`). */
	path: string
	/** BSON type name → number of sampled documents holding it at this path. */
	types: Record<string, number>
	/** Seen as null, or missing from some sampled documents. */
	nullable?: boolean
	/** More than one non-null type was seen. */
	mixed?: boolean
}
