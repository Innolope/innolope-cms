export interface ExternalDocument {
	_id: string
	[key: string]: unknown
}

export interface ExternalDbAdapter {
	connect(): Promise<void>
	disconnect(): Promise<void>
	estimateSizeBytes(): Promise<number>
	findAll(table: string, opts?: { limit?: number; offset?: number }): Promise<ExternalDocument[]>
	findById(table: string, id: string): Promise<ExternalDocument | null>
	insert(table: string, data: Record<string, unknown>): Promise<ExternalDocument>
	update(table: string, id: string, data: Record<string, unknown>): Promise<ExternalDocument>
	delete(table: string, id: string): Promise<void>
	count(table: string): Promise<number>
	testWritePermission(table: string): Promise<boolean>
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

	async estimateSizeBytes(): Promise<number> {
		const stats = await this.db().stats()
		return stats.dataSize || 0
	}

	async findAll(table: string, opts?: { limit?: number; offset?: number }): Promise<ExternalDocument[]> {
		const docs = await this.db().collection(table)
			.find()
			.skip(opts?.offset ?? 0)
			.limit(opts?.limit ?? 100)
			.toArray()
		return docs.map(d => ({ ...d, _id: String(d._id) }))
	}

	async findById(table: string, id: string): Promise<ExternalDocument | null> {
		const { ObjectId } = await import('mongodb')
		let query: Record<string, unknown>
		try { query = { _id: new ObjectId(id) } } catch { query = { _id: id } }
		const doc = await this.db().collection(table).findOne(query)
		if (!doc) return null
		return { ...doc, _id: String(doc._id) }
	}

	async insert(table: string, data: Record<string, unknown>): Promise<ExternalDocument> {
		const result = await this.db().collection(table).insertOne(data)
		return { ...data, _id: String(result.insertedId) }
	}

	async update(table: string, id: string, data: Record<string, unknown>): Promise<ExternalDocument> {
		const { ObjectId } = await import('mongodb')
		let filter: Record<string, unknown>
		try { filter = { _id: new ObjectId(id) } } catch { filter = { _id: id } }
		await this.db().collection(table).updateOne(filter, { $set: data })
		return { ...data, _id: id }
	}

	async delete(table: string, id: string): Promise<void> {
		const { ObjectId } = await import('mongodb')
		let filter: Record<string, unknown>
		try { filter = { _id: new ObjectId(id) } } catch { filter = { _id: id } }
		await this.db().collection(table).deleteOne(filter)
	}

	async count(table: string): Promise<number> {
		return this.db().collection(table).estimatedDocumentCount()
	}

	async testWritePermission(table: string): Promise<boolean> {
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
	private client: any = null

	constructor(private connectionString: string) {}

	async connect() {
		const postgresModule = await import('postgres')
		const postgres = postgresModule.default
		this.client = postgres(this.connectionString, {
			ssl: this.connectionString.includes('sslmode=') ? 'require' : false,
			connect_timeout: 10,
		})
		await this.client`SELECT 1`
	}

	async disconnect() {
		await this.client?.end()
		this.client = null
	}

	private sql(): any {
		if (!this.client) throw new Error('Not connected')
		return this.client
	}

	async estimateSizeBytes(): Promise<number> {
		const [row] = await this.sql()`SELECT pg_database_size(current_database()) as size`
		return Number(row.size)
	}

	private async getPrimaryKey(table: string): Promise<string> {
		const [row] = await this.sql()`
			SELECT kcu.column_name FROM information_schema.table_constraints tc
			JOIN information_schema.key_column_usage kcu ON tc.constraint_name = kcu.constraint_name
			WHERE tc.table_schema = 'public' AND tc.table_name = ${table} AND tc.constraint_type = 'PRIMARY KEY'
			LIMIT 1
		`
		return row?.column_name || 'id'
	}

	async findAll(table: string, opts?: { limit?: number; offset?: number }): Promise<ExternalDocument[]> {
		const pk = await this.getPrimaryKey(table)
		const rows = await this.sql()`
			SELECT * FROM ${this.sql()(table)} ORDER BY ${this.sql()(pk)} LIMIT ${opts?.limit ?? 100} OFFSET ${opts?.offset ?? 0}
		`
		return rows.map((r: any) => ({ ...r, _id: String(r[pk]) }))
	}

	async findById(table: string, id: string): Promise<ExternalDocument | null> {
		const pk = await this.getPrimaryKey(table)
		const [row] = await this.sql()`SELECT * FROM ${this.sql()(table)} WHERE ${this.sql()(pk)} = ${id} LIMIT 1`
		if (!row) return null
		return { ...row, _id: String(row[pk]) }
	}

	async insert(table: string, data: Record<string, unknown>): Promise<ExternalDocument> {
		const pk = await this.getPrimaryKey(table)
		const cols = Object.keys(data)
		const vals = Object.values(data)
		const [row] = await this.sql()`INSERT INTO ${this.sql()(table)} (${this.sql()(cols)}) VALUES (${vals}) RETURNING *`
		return { ...row, _id: String(row[pk]) }
	}

	async update(table: string, id: string, data: Record<string, unknown>): Promise<ExternalDocument> {
		const pk = await this.getPrimaryKey(table)
		const [row] = await this.sql()`UPDATE ${this.sql()(table)} SET ${this.sql()(data)} WHERE ${this.sql()(pk)} = ${id} RETURNING *`
		return { ...row, _id: String(row[pk]) }
	}

	async delete(table: string, id: string): Promise<void> {
		const pk = await this.getPrimaryKey(table)
		await this.sql()`DELETE FROM ${this.sql()(table)} WHERE ${this.sql()(pk)} = ${id}`
	}

	async count(table: string): Promise<number> {
		const [row] = await this.sql()`SELECT count(*)::int as count FROM ${this.sql()(table)}`
		return Number(row.count)
	}

	async testWritePermission(table: string): Promise<boolean> {
		try {
			const [row] = await this.sql()`SELECT has_table_privilege(current_user, ${table}, 'INSERT') as can_insert`
			return row.can_insert === true
		} catch {
			return false
		}
	}
}

// ─── MySQL Adapter ───────────────────────────────────────────────────────────

export class MySqlAdapter implements ExternalDbAdapter {
	private conn: import('mysql2/promise').Connection | null = null

	constructor(private connectionString: string) {}

	async connect() {
		const mysql = await import('mysql2/promise')
		this.conn = await mysql.createConnection(this.connectionString)
	}

	async disconnect() {
		await this.conn?.end()
		this.conn = null
	}

	private db() {
		if (!this.conn) throw new Error('Not connected')
		return this.conn
	}

	async estimateSizeBytes(): Promise<number> {
		const [rows] = await this.db().execute(
			`SELECT SUM(data_length + index_length) as size FROM information_schema.tables WHERE table_schema = DATABASE()`,
		)
		return Number((rows as Array<{ size: number }>)[0]?.size || 0)
	}

	private async getPrimaryKey(table: string): Promise<string> {
		const [rows] = await this.db().execute(
			`SELECT COLUMN_NAME FROM information_schema.KEY_COLUMN_USAGE WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND CONSTRAINT_NAME = 'PRIMARY' LIMIT 1`,
			[table],
		)
		return (rows as Array<{ COLUMN_NAME: string }>)[0]?.COLUMN_NAME || 'id'
	}

	async findAll(table: string, opts?: { limit?: number; offset?: number }): Promise<ExternalDocument[]> {
		const pk = await this.getPrimaryKey(table)
		const [rows] = await this.db().execute(
			`SELECT * FROM \`${table}\` ORDER BY \`${pk}\` LIMIT ? OFFSET ?`,
			[opts?.limit ?? 100, opts?.offset ?? 0],
		)
		return (rows as Array<Record<string, unknown>>).map(r => ({ ...r, _id: String(r[pk]) }))
	}

	async findById(table: string, id: string): Promise<ExternalDocument | null> {
		const pk = await this.getPrimaryKey(table)
		const [rows] = await this.db().execute(`SELECT * FROM \`${table}\` WHERE \`${pk}\` = ? LIMIT 1`, [id])
		const arr = rows as Array<Record<string, unknown>>
		if (arr.length === 0) return null
		return { ...arr[0], _id: String(arr[0][pk]) }
	}

	async insert(table: string, data: Record<string, unknown>): Promise<ExternalDocument> {
		const cols = Object.keys(data).map(c => `\`${c}\``).join(', ')
		const placeholders = Object.keys(data).map(() => '?').join(', ')
		const [result] = await this.db().execute(`INSERT INTO \`${table}\` (${cols}) VALUES (${placeholders})`, Object.values(data) as any[])
		const insertId = (result as { insertId: number }).insertId
		return { ...data, _id: String(insertId) }
	}

	async update(table: string, id: string, data: Record<string, unknown>): Promise<ExternalDocument> {
		const pk = await this.getPrimaryKey(table)
		const sets = Object.keys(data).map(c => `\`${c}\` = ?`).join(', ')
		await this.db().execute(`UPDATE \`${table}\` SET ${sets} WHERE \`${pk}\` = ?`, [...Object.values(data), id] as any[])
		return { ...data, _id: id }
	}

	async delete(table: string, id: string): Promise<void> {
		const pk = await this.getPrimaryKey(table)
		await this.db().execute(`DELETE FROM \`${table}\` WHERE \`${pk}\` = ?`, [id])
	}

	async count(table: string): Promise<number> {
		const [rows] = await this.db().execute(`SELECT COUNT(*) as count FROM \`${table}\``)
		return Number((rows as Array<{ count: number }>)[0].count)
	}

	async testWritePermission(_table: string): Promise<boolean> {
		try {
			const [rows] = await this.db().execute(`SHOW GRANTS FOR CURRENT_USER()`)
			const grants = (rows as Array<Record<string, string>>).map(r => Object.values(r)[0]).join(' ')
			return grants.includes('ALL PRIVILEGES') || grants.includes('INSERT')
		} catch {
			return false
		}
	}
}

// ─── Factory ─────────────────────────────────────────────────────────────────

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
