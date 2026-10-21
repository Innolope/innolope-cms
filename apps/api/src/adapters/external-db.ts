import { randomUUID } from 'node:crypto'
import { type SourceColumn, type SourceSchema, sslModeFor } from '@innolope/db'
import type { Sql } from 'postgres'
import { decodeMongoValue, encodeMongoPatch, encodeSqlValues } from './codec.js'
import { histogramPaths, parseMysqlEnumValues, sealSourceSchema } from './source-schema.js'

export interface ExternalDocument {
	_id: string
	[key: string]: unknown
}

export interface FindAllOpts {
	limit?: number
	offset?: number
	/** Source column to filter on for incremental sync (e.g. `updated_at`). */
	cursorColumn?: string
	/** Only return rows where `cursorColumn > cursorAfter`. */
	cursorAfter?: Date | string | number
}

export interface StreamAllOpts {
	/** How many rows to materialize per yielded batch. */
	batchSize?: number
	/** Resume keyset: only yield rows with primary key > startAfterId. */
	startAfterId?: string
}

export interface WriteOpts {
	/**
	 * The table's recorded shape. With it, values are written in their native
	 * types (see `codec.ts`); without it they are written as given.
	 */
	schema?: SourceSchema | null
	/** Top-level keys written exactly as given — opaque values edited as JSON. */
	raw?: string[]
}

export interface UpdateOpts extends WriteOpts {
	unset?: string[]
}

/** SQL has no "remove a column from one row": a removed value is a NULL. */
function withUnsetAsNull(data: Record<string, unknown>, opts?: UpdateOpts) {
	const out = { ...data }
	for (const key of opts?.unset ?? []) out[key] = null
	return out
}

/** Encode SQL values when the recorded schema is for this dialect. */
function encodeForSql(
	data: Record<string, unknown>,
	opts: WriteOpts | undefined,
	dialect: 'postgresql' | 'mysql',
): Record<string, unknown> {
	const schema = opts?.schema
	if (!schema || schema.dialect !== dialect) return data
	const raw = new Set(opts?.raw ?? [])
	const encoded = encodeSqlValues(data, schema)
	for (const key of raw) if (key in data) encoded[key] = data[key]
	return encoded
}

/**
 * A row's external id. A single-column key is its value as a string; a
 * composite key is the JSON array of its values in key order, so it survives
 * the round trip through `content.externalId` and back into a WHERE clause.
 */
export function externalIdFromRow(row: Record<string, unknown>, primaryKey: string[]): string {
	if (primaryKey.length === 1) return String(row[primaryKey[0]])
	return JSON.stringify(
		primaryKey.map((column) => {
			const value = row[column]
			return value instanceof Date ? value.toISOString() : value
		}),
	)
}

/** The key values an external id stands for, in key order. */
export function keyValuesFromId(id: string, primaryKey: string[]): unknown[] {
	if (primaryKey.length === 1) return [id]
	let parsed: unknown
	try {
		parsed = JSON.parse(id)
	} catch {
		throw new Error(`Not a composite key: ${id}`)
	}
	if (!Array.isArray(parsed) || parsed.length !== primaryKey.length) {
		throw new Error(`Composite key needs ${primaryKey.length} values: ${id}`)
	}
	return parsed
}

export interface ExternalDbAdapter {
	connect(): Promise<void>
	disconnect(): Promise<void>
	estimateTableSizeBytes(table: string): Promise<number>
	findAll(table: string, opts?: FindAllOpts): Promise<ExternalDocument[]>
	/**
	 * Stream every row in `table` in batches, ordered by primary key. Uses a
	 * server-side cursor (PG `DECLARE CURSOR`, Mongo native cursor, MySQL row
	 * stream) so memory stays bounded regardless of table size, and OFFSET drift
	 * — where rows inserted mid-scan get skipped — can't happen.
	 */
	streamAll(table: string, opts?: StreamAllOpts): AsyncIterable<ExternalDocument[]>
	findById(table: string, id: string): Promise<ExternalDocument | null>
	insert(table: string, data: Record<string, unknown>, opts?: WriteOpts): Promise<ExternalDocument>
	/**
	 * Write `data` to one row. On MongoDB a key may be a dotted path into a
	 * sub-document. `opts.unset` names keys to remove: `$unset` on MongoDB, NULL
	 * on SQL targets.
	 */
	update(
		table: string,
		id: string,
		data: Record<string, unknown>,
		opts?: UpdateOpts,
	): Promise<ExternalDocument>
	delete(table: string, id: string): Promise<void>
	count(table: string): Promise<number>
	testWritePermission(table: string): Promise<boolean>
	/**
	 * The table's real shape: SQL columns with their constraints, or a MongoDB
	 * type histogram over a document sample. See `SourceSchema`.
	 */
	describeTable(table: string): Promise<SourceSchema>
}

/** Documents sampled to describe a MongoDB collection. */
const DESCRIBE_SAMPLE_SIZE = 50

function quoteMysqlIdentifier(identifier: string): string {
	return `\`${identifier.replace(/`/g, '``')}\``
}

// ─── MongoDB Adapter ─────────────────────────────────────────────────────────

export class MongoDbAdapter implements ExternalDbAdapter {
	private client: import('mongodb').MongoClient | null = null
	private dbInstance: import('mongodb').Db | null = null

	constructor(
		private connectionString: string,
		private database?: string,
	) {}

	async connect() {
		const { MongoClient } = await import('mongodb')
		this.client = new MongoClient(this.connectionString, { serverSelectionTimeoutMS: 10000 })
		await this.client.connect()
		this.dbInstance = this.database ? this.client.db(this.database) : this.client.db()
	}

	async disconnect() {
		await this.client?.close()
		this.client = null
		this.dbInstance = null
	}

	private db() {
		if (!this.dbInstance) throw new Error('Not connected')
		return this.dbInstance
	}

	/**
	 * Read options shared by every query that feeds the cache: Longs come back as
	 * Long objects so one beyond 2^53 is not silently rounded to a float, and the
	 * decoder turns them into exact JSON values.
	 */
	private readonly readOptions = { promoteLongs: false } as const

	/** A driver document in the cache's JSON-exact form, `_id` as a string. */
	private toExternal(doc: Record<string, unknown>): ExternalDocument {
		const decoded = decodeMongoValue(doc) as Record<string, unknown>
		return { ...decoded, _id: String(doc._id) }
	}

	/**
	 * Match a document by `_id` regardless of how it is stored. Imported collections
	 * vary: some keep `_id` as an ObjectId, others (migrated/seeded data) as a plain
	 * string. When `id` is ObjectId-shaped we query both forms so a hex string never
	 * misses a string-typed `_id`.
	 */
	private async buildIdFilter(id: string): Promise<Record<string, unknown>> {
		const { ObjectId } = await import('mongodb')
		try {
			return { $or: [{ _id: new ObjectId(id) }, { _id: id }] }
		} catch {
			return { _id: id }
		}
	}

	async estimateTableSizeBytes(table: string): Promise<number> {
		const stats = await this.db().command({ collStats: table })
		return Number(stats.size) || 0
	}

	async findAll(table: string, opts?: FindAllOpts): Promise<ExternalDocument[]> {
		const filter: Record<string, unknown> =
			opts?.cursorColumn && opts.cursorAfter !== undefined
				? { [opts.cursorColumn]: { $gt: opts.cursorAfter } }
				: {}
		let cursor = this.db().collection(table).find(filter, this.readOptions)
		if (opts?.cursorColumn) cursor = cursor.sort({ [opts.cursorColumn]: 1 })
		cursor = cursor.skip(opts?.offset ?? 0).limit(opts?.limit ?? 100)
		const docs = await cursor.toArray()
		return docs.map((d) => this.toExternal(d))
	}

	async *streamAll(table: string, opts?: StreamAllOpts): AsyncIterable<ExternalDocument[]> {
		const batchSize = opts?.batchSize ?? 1000
		const filter: Record<string, unknown> = {}
		if (opts?.startAfterId !== undefined) {
			const { ObjectId } = await import('mongodb')
			let gt: unknown = opts.startAfterId
			try {
				gt = new ObjectId(opts.startAfterId)
			} catch {
				// Not an ObjectId — keep the string form so collections with string
				// `_id` (migrated/seeded data) still get a working keyset filter.
			}
			filter._id = { $gt: gt }
		}
		const cursor = this.db()
			.collection(table)
			.find(filter, this.readOptions)
			.sort({ _id: 1 })
			.batchSize(batchSize)
		let buffer: ExternalDocument[] = []
		for await (const doc of cursor) {
			buffer.push(this.toExternal(doc))
			if (buffer.length >= batchSize) {
				yield buffer
				buffer = []
			}
		}
		if (buffer.length > 0) yield buffer
	}

	async findById(table: string, id: string): Promise<ExternalDocument | null> {
		const doc = await this.db()
			.collection(table)
			.findOne(await this.buildIdFilter(id), this.readOptions)
		if (!doc) return null
		return this.toExternal(doc)
	}

	async insert(
		table: string,
		data: Record<string, unknown>,
		opts?: WriteOpts,
	): Promise<ExternalDocument> {
		const bson = await import('mongodb')
		const document = opts?.schema
			? encodeMongoPatch(bson, data, { schema: opts.schema, raw: new Set(opts.raw ?? []) })
			: data
		const result = await this.db().collection(table).insertOne(document)
		return { ...data, _id: String(result.insertedId) }
	}

	async update(
		table: string,
		id: string,
		data: Record<string, unknown>,
		opts?: UpdateOpts,
	): Promise<ExternalDocument> {
		const bson = await import('mongodb')
		const filter = await this.buildIdFilter(id)
		const collection = this.db().collection(table)
		let set = data
		if (Object.keys(data).length > 0) {
			// The row's own document is the type template: a path keeps the BSON type
			// it already holds (a nested ObjectId, a Date, a Decimal128) even when the
			// cache only had its string copy.
			const existing = await collection.findOne(filter, this.readOptions)
			set = encodeMongoPatch(bson, data, {
				existing,
				schema: opts?.schema,
				raw: new Set(opts?.raw ?? []),
			})
		}
		const update: Record<string, Record<string, unknown>> = {}
		if (Object.keys(set).length > 0) update.$set = set
		if (opts?.unset?.length) update.$unset = Object.fromEntries(opts.unset.map((key) => [key, '']))
		const result = await collection.updateOne(filter, update)
		if (result.matchedCount === 0) throw new Error(`External row not found: ${id}`)
		return { ...data, _id: id }
	}

	async delete(table: string, id: string): Promise<void> {
		await this.db()
			.collection(table)
			.deleteOne(await this.buildIdFilter(id))
	}

	async count(table: string): Promise<number> {
		return this.db().collection(table).estimatedDocumentCount()
	}

	async describeTable(table: string): Promise<SourceSchema> {
		// Newest documents first: drift shows up in what is being written now.
		const docs = await this.db()
			.collection(table)
			.find({}, this.readOptions)
			.sort({ _id: -1 })
			.limit(DESCRIBE_SAMPLE_SIZE)
			.toArray()
		return sealSourceSchema({
			dialect: 'mongodb',
			table,
			primaryKey: ['_id'],
			paths: histogramPaths(docs as Array<Record<string, unknown>>),
			sampled: docs.length,
		})
	}

	async testWritePermission(_table: string): Promise<boolean> {
		try {
			const testCol = this.db().collection(`__innolope_permission_test_${Date.now()}`)
			await testCol.insertOne({ _test: true })
			await testCol.drop()
			return true
		} catch {
			return false
		}
	}
}

// ─── PostgreSQL Adapter ──────────────────────────────────────────────────────

export class PostgreSqlAdapter implements ExternalDbAdapter {
	private client: Sql | null = null
	/** Primary keys per table, read once per connection. */
	private keys = new Map<string, string[]>()

	constructor(private connectionString: string) {}

	async connect() {
		const postgresModule = await import('postgres')
		const postgres = postgresModule.default
		this.client = postgres(this.connectionString, {
			ssl: sslModeFor(this.connectionString),
			connect_timeout: 10,
		})
		await this.client`SELECT 1`
	}

	async disconnect() {
		await this.client?.end()
		this.client = null
		this.keys.clear()
	}

	private sql(): Sql {
		if (!this.client) throw new Error('Not connected')
		return this.client
	}

	async estimateTableSizeBytes(table: string): Promise<number> {
		const [row] = await this.sql()`SELECT pg_total_relation_size(${table}::regclass) as size`
		return Number(row?.size) || 0
	}

	/**
	 * Every primary-key column, in key order. A table with none falls back to a
	 * column named `id`, which is what the adapter has always assumed.
	 */
	private async getPrimaryKey(table: string): Promise<string[]> {
		const cached = this.keys.get(table)
		if (cached) return cached
		const rows = await this.sql()`
			SELECT kcu.column_name FROM information_schema.table_constraints tc
			JOIN information_schema.key_column_usage kcu
				ON tc.constraint_name = kcu.constraint_name
				AND tc.table_schema = kcu.table_schema
				AND tc.table_name = kcu.table_name
			WHERE tc.table_schema = 'public' AND tc.table_name = ${table}
				AND tc.constraint_type = 'PRIMARY KEY'
			ORDER BY kcu.ordinal_position
		`
		const key = rows.length > 0 ? rows.map((row) => String(row.column_name)) : ['id']
		this.keys.set(table, key)
		return key
	}

	/** `a = $1 AND b = $2` for an external id. */
	private matchId(pk: string[], id: string) {
		const sql = this.sql()
		const values = keyValuesFromId(id, pk)
		return pk
			.map((column, index) => sql`${sql(column)} = ${values[index] as string}`)
			.reduce((acc, part) => sql`${acc} AND ${part}`)
	}

	private toExternal(row: Record<string, unknown>, pk: string[]): ExternalDocument {
		return { ...row, _id: externalIdFromRow(row, pk) }
	}

	async findAll(table: string, opts?: FindAllOpts): Promise<ExternalDocument[]> {
		const pk = await this.getPrimaryKey(table)
		const sql = this.sql()
		const order = opts?.cursorColumn ? [opts.cursorColumn, ...pk] : pk
		const whereClause =
			opts?.cursorColumn && opts.cursorAfter !== undefined
				? sql`WHERE ${sql(opts.cursorColumn)} > ${opts.cursorAfter as Date | string | number}`
				: sql``
		const rows = await sql`
			SELECT * FROM ${sql(table)} ${whereClause}
			ORDER BY ${sql(order)} LIMIT ${opts?.limit ?? 100} OFFSET ${opts?.offset ?? 0}
		`
		return rows.map((r: Record<string, unknown>) => this.toExternal(r, pk))
	}

	async *streamAll(table: string, opts?: StreamAllOpts): AsyncIterable<ExternalDocument[]> {
		const pk = await this.getPrimaryKey(table)
		const batchSize = opts?.batchSize ?? 1000
		const sql = this.sql()
		let whereClause = sql``
		if (opts?.startAfterId !== undefined) {
			const values = keyValuesFromId(opts.startAfterId, pk)
			const list = values
				.map((value) => sql`${value as string}`)
				.reduce((acc, part) => sql`${acc}, ${part}`)
			whereClause = sql`WHERE (${sql(pk)}) > (${list})`
		}
		// postgres-js `.cursor(n)` opens a server-side cursor in its own
		// transaction and yields rows in chunks of n — no full materialization.
		const stream = sql`SELECT * FROM ${sql(table)} ${whereClause} ORDER BY ${sql(pk)}`.cursor(
			batchSize,
		)
		for await (const rows of stream) {
			yield (rows as Array<Record<string, unknown>>).map((r) => this.toExternal(r, pk))
		}
	}

	async findById(table: string, id: string): Promise<ExternalDocument | null> {
		const pk = await this.getPrimaryKey(table)
		const [row] =
			await this.sql()`SELECT * FROM ${this.sql()(table)} WHERE ${this.matchId(pk, id)} LIMIT 1`
		if (!row) return null
		return this.toExternal(row, pk)
	}

	async insert(
		table: string,
		data: Record<string, unknown>,
		opts?: WriteOpts,
	): Promise<ExternalDocument> {
		const pk = await this.getPrimaryKey(table)
		const values = encodeForSql(data, opts, 'postgresql')
		const [row] =
			await this.sql()`INSERT INTO ${this.sql()(table)} ${this.sql()(values)} RETURNING *`
		return this.toExternal(row, pk)
	}

	async update(
		table: string,
		id: string,
		data: Record<string, unknown>,
		opts?: UpdateOpts,
	): Promise<ExternalDocument> {
		const pk = await this.getPrimaryKey(table)
		const values = encodeForSql(withUnsetAsNull(data, opts), opts, 'postgresql')
		const [row] =
			await this.sql()`UPDATE ${this.sql()(table)} SET ${this.sql()(values)} WHERE ${this.matchId(pk, id)} RETURNING *`
		if (!row) throw new Error(`External row not found: ${id}`)
		return this.toExternal(row, pk)
	}

	async delete(table: string, id: string): Promise<void> {
		const pk = await this.getPrimaryKey(table)
		await this.sql()`DELETE FROM ${this.sql()(table)} WHERE ${this.matchId(pk, id)}`
	}

	async count(table: string): Promise<number> {
		const [row] = await this.sql()`SELECT count(*)::int as count FROM ${this.sql()(table)}`
		return Number(row.count)
	}

	async describeTable(table: string): Promise<SourceSchema> {
		const sql = this.sql()
		const rows = await sql`
			SELECT column_name, data_type, udt_name, is_nullable, column_default,
				is_identity, is_generated, character_maximum_length
			FROM information_schema.columns
			WHERE table_schema = 'public' AND table_name = ${table}
			ORDER BY ordinal_position
		`
		const keyRows = await sql`
			SELECT kcu.column_name FROM information_schema.table_constraints tc
			JOIN information_schema.key_column_usage kcu
				ON tc.constraint_name = kcu.constraint_name
				AND tc.table_schema = kcu.table_schema
				AND tc.table_name = kcu.table_name
			WHERE tc.table_schema = 'public' AND tc.table_name = ${table}
				AND tc.constraint_type = 'PRIMARY KEY'
			ORDER BY kcu.ordinal_position
		`
		const primaryKey = keyRows.map((row) => String(row.column_name))
		// User-defined enum types list their labels in pg_enum. Hosts without it
		// (or without permission to read it) just get no enumValues.
		const enumTypes = [
			...new Set(
				rows.filter((row) => row.data_type === 'USER-DEFINED').map((row) => String(row.udt_name)),
			),
		]
		const enumValues = new Map<string, string[]>()
		if (enumTypes.length > 0) {
			try {
				const labels = await sql`
					SELECT t.typname, e.enumlabel FROM pg_type t
					JOIN pg_enum e ON e.enumtypid = t.oid
					WHERE t.typname IN ${sql(enumTypes)}
					ORDER BY t.typname, e.enumsortorder
				`
				for (const label of labels) {
					const list = enumValues.get(String(label.typname)) ?? []
					list.push(String(label.enumlabel))
					enumValues.set(String(label.typname), list)
				}
			} catch {
				// Not fatal: the column stays a free-text column to the editor.
			}
		}
		const columns: SourceColumn[] = rows.map((row) => {
			const name = String(row.column_name)
			const udtName = String(row.udt_name)
			const values = enumValues.get(udtName)
			return {
				name,
				nativeType: String(row.data_type),
				udtName,
				nullable: row.is_nullable === 'YES',
				hasDefault: row.column_default !== null || row.is_identity === 'YES',
				isIdentity:
					row.is_identity === 'YES' || /^nextval\(/i.test(String(row.column_default ?? '')),
				isGenerated: row.is_generated === 'ALWAYS',
				...(row.character_maximum_length != null && {
					maxLength: Number(row.character_maximum_length),
				}),
				...(values && { enumValues: values }),
				isPrimaryKey: primaryKey.includes(name),
			}
		})
		return sealSourceSchema({ dialect: 'postgresql', table, schema: 'public', primaryKey, columns })
	}

	async testWritePermission(table: string): Promise<boolean> {
		try {
			const [row] =
				await this.sql()`SELECT has_table_privilege(current_user, ${table}, 'INSERT') as can_insert`
			return row.can_insert === true
		} catch {
			return false
		}
	}
}

// ─── MySQL Adapter ───────────────────────────────────────────────────────────

/** A MySQL table's key: its columns in order, and whether the server numbers it. */
interface MysqlKey {
	columns: string[]
	autoIncrement: boolean
	/** Key columns that hold a UUID-length string the CMS can generate. */
	uuidColumns: string[]
}

export class MySqlAdapter implements ExternalDbAdapter {
	private conn: import('mysql2/promise').Connection | null = null
	private keys = new Map<string, MysqlKey>()

	constructor(private connectionString: string) {}

	async connect() {
		const mysql = await import('mysql2/promise')
		this.conn = await mysql.createConnection({
			uri: this.connectionString,
			// BIGINT beyond 2^53 arrives as its exact digit string instead of a
			// rounded float; smaller values stay numbers. DECIMAL is a string already.
			supportBigNumbers: true,
			bigNumberStrings: false,
		})
	}

	async disconnect() {
		await this.conn?.end()
		this.conn = null
		this.keys.clear()
	}

	private db() {
		if (!this.conn) throw new Error('Not connected')
		return this.conn
	}

	async estimateTableSizeBytes(table: string): Promise<number> {
		const [rows] = await this.db().execute(
			`SELECT data_length + index_length as size FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = ?`,
			[table],
		)
		return Number((rows as Array<{ size: number }>)[0]?.size || 0)
	}

	private async getKey(table: string): Promise<MysqlKey> {
		const cached = this.keys.get(table)
		if (cached) return cached
		const [rows] = await this.db().execute(
			`SELECT k.COLUMN_NAME AS name, c.EXTRA AS extra, c.DATA_TYPE AS dataType,
				c.CHARACTER_MAXIMUM_LENGTH AS maxLength
			FROM information_schema.KEY_COLUMN_USAGE k
			JOIN information_schema.COLUMNS c
				ON c.TABLE_SCHEMA = k.TABLE_SCHEMA AND c.TABLE_NAME = k.TABLE_NAME
				AND c.COLUMN_NAME = k.COLUMN_NAME
			WHERE k.TABLE_SCHEMA = DATABASE() AND k.TABLE_NAME = ? AND k.CONSTRAINT_NAME = 'PRIMARY'
			ORDER BY k.ORDINAL_POSITION`,
			[table],
		)
		const list = rows as Array<{
			name: string
			extra: string | null
			dataType: string
			maxLength: number | null
		}>
		const key: MysqlKey =
			list.length > 0
				? {
						columns: list.map((row) => row.name),
						autoIncrement: list.some((row) =>
							(row.extra ?? '').toLowerCase().includes('auto_increment'),
						),
						uuidColumns: list
							.filter((row) => /char/i.test(row.dataType) && Number(row.maxLength) >= 36)
							.map((row) => row.name),
					}
				: { columns: ['id'], autoIncrement: true, uuidColumns: [] }
		this.keys.set(table, key)
		return key
	}

	private matchId(pk: string[], id: string): { where: string; params: unknown[] } {
		const values = keyValuesFromId(id, pk)
		return {
			where: pk.map((column) => `${quoteMysqlIdentifier(column)} = ?`).join(' AND '),
			params: values,
		}
	}

	private toExternal(row: Record<string, unknown>, pk: string[]): ExternalDocument {
		return { ...row, _id: externalIdFromRow(row, pk) }
	}

	async findAll(table: string, opts?: FindAllOpts): Promise<ExternalDocument[]> {
		const { columns: pk } = await this.getKey(table)
		const limit = opts?.limit ?? 100
		const offset = opts?.offset ?? 0
		const order = (opts?.cursorColumn ? [opts.cursorColumn, ...pk] : pk)
			.map(quoteMysqlIdentifier)
			.join(', ')
		const filterArgs: { col: string; after: Date | string | number } | null =
			opts?.cursorColumn && opts.cursorAfter !== undefined
				? { col: opts.cursorColumn, after: opts.cursorAfter }
				: null
		const where = filterArgs ? `WHERE ${quoteMysqlIdentifier(filterArgs.col)} > ?` : ''
		const params: (string | number | Date)[] = filterArgs
			? [filterArgs.after, limit, offset]
			: [limit, offset]
		const [rows] = await this.db().execute(
			`SELECT * FROM ${quoteMysqlIdentifier(table)} ${where} ORDER BY ${order} LIMIT ? OFFSET ?`,
			params,
		)
		return (rows as Array<Record<string, unknown>>).map((r) => this.toExternal(r, pk))
	}

	async *streamAll(table: string, opts?: StreamAllOpts): AsyncIterable<ExternalDocument[]> {
		const { columns: pk } = await this.getKey(table)
		const batchSize = opts?.batchSize ?? 1000
		const keyList = pk.map(quoteMysqlIdentifier).join(', ')
		const where =
			opts?.startAfterId !== undefined
				? `WHERE (${keyList}) > (${pk.map(() => '?').join(', ')})`
				: ''
		const params = opts?.startAfterId !== undefined ? keyValuesFromId(opts.startAfterId, pk) : []
		// mysql2's connection.query({...}).stream() returns a Node Readable that
		// emits one row per tick — bounded memory regardless of row count.
		const stream = (
			this.db() as unknown as {
				query: (config: { sql: string; values?: unknown[] }) => {
					stream: (opts?: { highWaterMark?: number }) => AsyncIterable<Record<string, unknown>>
				}
			}
		)
			.query({
				sql: `SELECT * FROM ${quoteMysqlIdentifier(table)} ${where} ORDER BY ${keyList}`,
				values: params,
			})
			.stream({ highWaterMark: batchSize })
		let buffer: ExternalDocument[] = []
		for await (const row of stream) {
			buffer.push(this.toExternal(row, pk))
			if (buffer.length >= batchSize) {
				yield buffer
				buffer = []
			}
		}
		if (buffer.length > 0) yield buffer
	}

	async findById(table: string, id: string): Promise<ExternalDocument | null> {
		const { columns: pk } = await this.getKey(table)
		const { where, params } = this.matchId(pk, id)
		const [rows] = await this.db().execute(
			`SELECT * FROM ${quoteMysqlIdentifier(table)} WHERE ${where} LIMIT 1`,
			params as (string | number)[],
		)
		const arr = rows as Array<Record<string, unknown>>
		if (arr.length === 0) return null
		return this.toExternal(arr[0], pk)
	}

	/**
	 * Insert a row and return its key. MySQL has no RETURNING, so the key comes
	 * from `LAST_INSERT_ID()` only when the server numbers it; a natural or UUID
	 * key comes from the values written, and a missing UUID key is generated
	 * here rather than left for a default the CMS could never read back.
	 */
	async insert(
		table: string,
		data: Record<string, unknown>,
		opts?: WriteOpts,
	): Promise<ExternalDocument> {
		const key = await this.getKey(table)
		const row = { ...data }
		for (const column of key.uuidColumns) {
			if (row[column] === undefined || row[column] === null || row[column] === '') {
				row[column] = randomUUID()
			}
		}
		const values = encodeForSql(row, opts, 'mysql')
		const cols = Object.keys(values).map(quoteMysqlIdentifier).join(', ')
		const placeholders = Object.keys(values)
			.map(() => '?')
			.join(', ')
		const [result] = await this.db().execute(
			`INSERT INTO ${quoteMysqlIdentifier(table)} (${cols}) VALUES (${placeholders})`,
			Object.values(values) as (string | number | boolean | Date | null)[],
		)
		const insertId = (result as { insertId: number | string }).insertId
		const keyed = { ...row }
		if (key.autoIncrement && key.columns.length === 1 && insertId) {
			keyed[key.columns[0]] = insertId
		}
		if (key.columns.some((column) => keyed[column] === undefined || keyed[column] === null)) {
			throw new Error(
				`The source table needs a value for its key (${key.columns.join(', ')}) that the CMS cannot read back`,
			)
		}
		return { ...data, ...keyed, _id: externalIdFromRow(keyed, key.columns) }
	}

	async update(
		table: string,
		id: string,
		data: Record<string, unknown>,
		opts?: UpdateOpts,
	): Promise<ExternalDocument> {
		const { columns: pk } = await this.getKey(table)
		const values = encodeForSql(withUnsetAsNull(data, opts), opts, 'mysql')
		const sets = Object.keys(values)
			.map((c) => `${quoteMysqlIdentifier(c)} = ?`)
			.join(', ')
		const match = this.matchId(pk, id)
		const [result] = await this.db().execute(
			`UPDATE ${quoteMysqlIdentifier(table)} SET ${sets} WHERE ${match.where}`,
			[...Object.values(values), ...match.params] as (string | number | boolean | Date | null)[],
		)
		if ((result as { affectedRows?: number }).affectedRows === 0)
			throw new Error(`External row not found: ${id}`)
		return { ...data, _id: id }
	}

	async delete(table: string, id: string): Promise<void> {
		const { columns: pk } = await this.getKey(table)
		const { where, params } = this.matchId(pk, id)
		await this.db().execute(
			`DELETE FROM ${quoteMysqlIdentifier(table)} WHERE ${where}`,
			params as (string | number)[],
		)
	}

	async count(table: string): Promise<number> {
		const [rows] = await this.db().execute(
			`SELECT COUNT(*) as count FROM ${quoteMysqlIdentifier(table)}`,
		)
		return Number((rows as Array<{ count: number }>)[0].count)
	}

	async describeTable(table: string): Promise<SourceSchema> {
		const [rows] = await this.db().execute(
			`SELECT COLUMN_NAME AS name, DATA_TYPE AS dataType, COLUMN_TYPE AS columnType,
				IS_NULLABLE AS isNullable, COLUMN_DEFAULT AS columnDefault, EXTRA AS extra,
				CHARACTER_MAXIMUM_LENGTH AS maxLength
			FROM information_schema.columns
			WHERE table_schema = DATABASE() AND table_name = ?
			ORDER BY ORDINAL_POSITION`,
			[table],
		)
		const [keyRows] = await this.db().execute(
			`SELECT COLUMN_NAME AS name FROM information_schema.KEY_COLUMN_USAGE
			WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND CONSTRAINT_NAME = 'PRIMARY'
			ORDER BY ORDINAL_POSITION`,
			[table],
		)
		const primaryKey = (keyRows as Array<{ name: string }>).map((row) => row.name)
		const columns: SourceColumn[] = (
			rows as Array<{
				name: string
				dataType: string
				columnType: string
				isNullable: string
				columnDefault: unknown
				extra: string | null
				maxLength: number | null
			}>
		).map((row) => {
			const extra = (row.extra ?? '').toLowerCase()
			const enumValues = parseMysqlEnumValues(row.columnType)
			const isIdentity = extra.includes('auto_increment')
			return {
				name: row.name,
				nativeType: row.dataType,
				udtName: row.columnType,
				nullable: row.isNullable === 'YES',
				hasDefault: row.columnDefault !== null || isIdentity || extra.includes('default_generated'),
				isIdentity,
				isGenerated: extra.includes('virtual generated') || extra.includes('stored generated'),
				...(row.maxLength != null && { maxLength: Number(row.maxLength) }),
				...(enumValues && { enumValues }),
				isPrimaryKey: primaryKey.includes(row.name),
			}
		})
		return sealSourceSchema({ dialect: 'mysql', table, primaryKey, columns })
	}

	async testWritePermission(_table: string): Promise<boolean> {
		try {
			const [rows] = await this.db().execute(`SHOW GRANTS FOR CURRENT_USER()`)
			const grants = (rows as Array<Record<string, string>>)
				.map((r) => Object.values(r)[0])
				.join(' ')
			return grants.includes('ALL PRIVILEGES') || grants.includes('INSERT')
		} catch {
			return false
		}
	}
}

// ─── Factory ─────────────────────────────────────────────────────────────────

/**
 * Database types the write path can talk to. The wizard can *scan* Firestore,
 * but nothing below can read or write it, so it is refused at setup instead of
 * failing every import and write afterwards.
 */
export const WRITABLE_EXTERNAL_DB_TYPES = [
	'mongodb',
	'postgresql',
	'supabase',
	'neon',
	'vercel-postgres',
	'cockroachdb',
	'mysql',
] as const

export function isWritableExternalDbType(type: string): boolean {
	return (WRITABLE_EXTERNAL_DB_TYPES as readonly string[]).includes(type)
}

export function createExternalDbAdapter(config: {
	type: string
	connectionString: string
	database?: string
}): ExternalDbAdapter {
	switch (config.type) {
		case 'mongodb':
			return new MongoDbAdapter(config.connectionString, config.database)
		case 'postgresql':
		case 'supabase':
		case 'neon':
		case 'vercel-postgres':
		case 'cockroachdb':
			return new PostgreSqlAdapter(config.connectionString)
		case 'mysql':
			return new MySqlAdapter(config.connectionString)
		default:
			throw new Error(`Unsupported external database type: ${config.type}`)
	}
}
