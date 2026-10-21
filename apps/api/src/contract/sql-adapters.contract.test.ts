import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { preflightSql } from '../adapters/codec.js'
import { createExternalDbAdapter, type ExternalDbAdapter } from '../adapters/external-db.js'
import { diffExternalPayload, isEmptyPatch } from '../services/external-patch.js'

/**
 * The adapter contract for SQL sources, run against real databases.
 *
 *   CONTRACT_POSTGRES_URL=postgres://… CONTRACT_MYSQL_URL=mysql://… vitest run src/contract
 *
 * Each dialect is skipped when its URL is unset. CI provides both as service
 * containers. The guarantee under test: for every row read from the source, a
 * save that changes nothing produces an empty patch, a one-column edit touches
 * that column only, and writing the cache's copy of a row back leaves the row
 * identical at the SQL type level.
 */

const suffix = randomUUID().slice(0, 8)
const T = {
	serial: `c_serial_${suffix}`,
	uuid: `c_uuid_${suffix}`,
	composite: `c_composite_${suffix}`,
	nokey: `c_nokey_${suffix}`,
}
const MOOD = `c_mood_${suffix}`

interface Dialect {
	name: 'postgresql' | 'mysql'
	url: string | undefined
	exec(sql: string): Promise<void>
	/** The row as the driver returns it, columns in a stable order. */
	raw(table: string, where: string): Promise<Record<string, unknown>>
	setup: string[]
	teardown: string[]
	seed: string[]
	/** Columns of the serial table and an edit value for each, for the round trip. */
	hasArrays: boolean
}

function normalize(row: Record<string, unknown>): Record<string, unknown> {
	return JSON.parse(
		JSON.stringify(row, (_key, value) => (typeof value === 'bigint' ? value.toString() : value)),
	)
}

const cacheCopy = (doc: Record<string, unknown>) => {
	const { _id, ...rest } = JSON.parse(JSON.stringify(doc)) as Record<string, unknown>
	return rest
}

async function pgDialect(url: string): Promise<Dialect> {
	const postgres = (await import('postgres')).default
	const sql = postgres(url, { onnotice: () => {} })
	return {
		name: 'postgresql',
		url,
		hasArrays: true,
		exec: async (statement) => {
			await sql.unsafe(statement)
		},
		raw: async (table, where) => {
			const [row] = await sql.unsafe(`SELECT * FROM "${table}" WHERE ${where}`)
			return row as Record<string, unknown>
		},
		setup: [
			`CREATE TYPE ${MOOD} AS ENUM ('happy', 'sad')`,
			`CREATE TABLE ${T.serial} (
				id serial PRIMARY KEY,
				title text NOT NULL,
				body jsonb,
				tags text[],
				mood ${MOOD},
				price numeric(20,6),
				views bigint,
				code varchar(10),
				total numeric GENERATED ALWAYS AS (price * 2) STORED,
				published_at timestamptz,
				rating integer
			)`,
			`CREATE TABLE ${T.uuid} (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), title text NOT NULL, rating integer, published_at timestamptz)`,
			`CREATE TABLE ${T.composite} (tenant text, slug text, title text NOT NULL, PRIMARY KEY (tenant, slug))`,
			`CREATE TABLE ${T.nokey} (id integer NOT NULL UNIQUE, title text)`,
		],
		seed: [
			`INSERT INTO ${T.serial} (title, body, tags, mood, price, views, code, published_at, rating)
				VALUES ('First', '{"a":{"b":[1,2]}}', '{x,y}', 'happy', 12345678901234.123456, 9007199254740993, 'abc', '2026-01-02T03:04:05.678Z', 5)`,
			`INSERT INTO ${T.uuid} (title, rating) VALUES ('U', 1)`,
			`INSERT INTO ${T.composite} VALUES ('acme', 'hello', 'Composite')`,
			`INSERT INTO ${T.nokey} VALUES (7, 'No key')`,
		],
		teardown: [
			`DROP TABLE IF EXISTS ${T.serial}`,
			`DROP TABLE IF EXISTS ${T.uuid}`,
			`DROP TABLE IF EXISTS ${T.composite}`,
			`DROP TABLE IF EXISTS ${T.nokey}`,
			`DROP TYPE IF EXISTS ${MOOD}`,
		],
	}
}

async function mysqlDialect(url: string): Promise<Dialect> {
	const mysql = await import('mysql2/promise')
	const conn = await mysql.createConnection({ uri: url, supportBigNumbers: true })
	return {
		name: 'mysql',
		url,
		hasArrays: false,
		exec: async (statement) => {
			await conn.query(statement)
		},
		raw: async (table, where) => {
			const [rows] = await conn.query(`SELECT * FROM \`${table}\` WHERE ${where}`)
			return (rows as Record<string, unknown>[])[0]
		},
		setup: [
			`CREATE TABLE ${T.serial} (
				id INT AUTO_INCREMENT PRIMARY KEY,
				title VARCHAR(255) NOT NULL,
				body JSON,
				mood ENUM('happy', 'sad'),
				price DECIMAL(20,6),
				views BIGINT,
				code VARCHAR(10),
				total DECIMAL(21,6) GENERATED ALWAYS AS (price * 2) STORED,
				published_at DATETIME(3),
				rating INT,
				active TINYINT(1)
			)`,
			`CREATE TABLE ${T.uuid} (id CHAR(36) PRIMARY KEY, title VARCHAR(255) NOT NULL, rating INT, published_at DATETIME(3))`,
			`CREATE TABLE ${T.composite} (tenant VARCHAR(50), slug VARCHAR(50), title VARCHAR(255) NOT NULL, PRIMARY KEY (tenant, slug))`,
			`CREATE TABLE ${T.nokey} (id INT NOT NULL UNIQUE, title VARCHAR(255))`,
		],
		seed: [
			`INSERT INTO ${T.serial} (title, body, mood, price, views, code, published_at, rating, active)
				VALUES ('First', '{"a":{"b":[1,2]}}', 'happy', 12345678901234.123456, 9007199254740993, 'abc', '2026-01-02 03:04:05.678', 5, 1)`,
			`INSERT INTO ${T.uuid} VALUES ('5b1f0c4e-0000-4000-8000-000000000001', 'U', 1, NULL)`,
			`INSERT INTO ${T.composite} VALUES ('acme', 'hello', 'Composite')`,
			`INSERT INTO ${T.nokey} VALUES (7, 'No key')`,
		],
		teardown: [
			`DROP TABLE IF EXISTS ${T.serial}`,
			`DROP TABLE IF EXISTS ${T.uuid}`,
			`DROP TABLE IF EXISTS ${T.composite}`,
			`DROP TABLE IF EXISTS ${T.nokey}`,
		],
	}
}

const DIALECTS: Array<{ name: string; url?: string; make: (url: string) => Promise<Dialect> }> = [
	{ name: 'postgresql', url: process.env.CONTRACT_POSTGRES_URL, make: pgDialect },
	{ name: 'mysql', url: process.env.CONTRACT_MYSQL_URL, make: mysqlDialect },
]

for (const entry of DIALECTS) {
	describe.skipIf(!entry.url)(`SQL adapter contract: ${entry.name}`, { timeout: 30_000 }, () => {
		let dialect: Dialect
		let adapter: ExternalDbAdapter

		beforeAll(async () => {
			dialect = await entry.make(entry.url as string)
			for (const statement of dialect.setup) await dialect.exec(statement)
			for (const statement of dialect.seed) await dialect.exec(statement)
			adapter = createExternalDbAdapter({ type: entry.name, connectionString: entry.url as string })
			await adapter.connect()
		})

		afterAll(async () => {
			await adapter?.disconnect()
			if (dialect) for (const statement of dialect.teardown) await dialect.exec(statement)
		})

		it('describes columns, constraints and keys', async () => {
			const schema = await adapter.describeTable(T.serial)
			const byName = new Map((schema.columns ?? []).map((column) => [column.name, column]))
			expect(schema.primaryKey).toEqual(['id'])
			expect(byName.get('title')).toMatchObject({ nullable: false, hasDefault: false })
			expect(byName.get('total')?.isGenerated).toBe(true)
			expect(byName.get('mood')?.enumValues).toEqual(['happy', 'sad'])
			expect(byName.get('code')?.maxLength).toBe(10)
			expect((await adapter.describeTable(T.composite)).primaryKey).toEqual(['tenant', 'slug'])
		})

		it('produces an empty patch for a save that changes nothing', async () => {
			for (const table of Object.values(T)) {
				for (const doc of await adapter.findAll(table)) {
					const copy = cacheCopy(doc)
					expect(isEmptyPatch(diffExternalPayload(copy, copy, { nested: false }))).toBe(true)
				}
			}
		})

		it('keeps exact numerics exact on read', async () => {
			const [doc] = await adapter.findAll(T.serial)
			expect(String(doc.price)).toBe('12345678901234.123456')
			expect(String(doc.views)).toBe('9007199254740993')
		})

		it('touches only the edited column, and the row is otherwise identical', async () => {
			const schema = await adapter.describeTable(T.serial)
			const [doc] = await adapter.findAll(T.serial)
			const before = normalize(await dialect.raw(T.serial, `id = ${doc._id}`))
			const copy = cacheCopy(doc)
			const patch = diffExternalPayload({ ...copy, title: 'Edited' }, copy, { nested: false })
			expect(patch.set).toEqual({ title: 'Edited' })
			await adapter.update(T.serial, doc._id, patch.set, { schema })
			const after = normalize(await dialect.raw(T.serial, `id = ${doc._id}`))
			expect(after).toEqual({ ...before, title: 'Edited' })
		})

		it('writes the cache copy of a row back without changing it', async () => {
			const schema = await adapter.describeTable(T.serial)
			const [doc] = await adapter.findAll(T.serial)
			const before = normalize(await dialect.raw(T.serial, `id = ${doc._id}`))
			const { values, issues } = preflightSql(cacheCopy(doc), schema, { mode: 'update' })
			expect(issues).toEqual([])
			// The full round trip: every writable column, through the codec.
			await adapter.update(T.serial, doc._id, values, { schema })
			expect(normalize(await dialect.raw(T.serial, `id = ${doc._id}`))).toEqual(before)
		})

		it('inserts an editor payload with empty number and date inputs', async () => {
			const schema = await adapter.describeTable(T.serial)
			const { values, issues } = preflightSql(
				{ title: 'From the editor', rating: '', published_at: '', price: 0.1 },
				schema,
				{ mode: 'insert' },
			)
			expect(issues).toEqual([])
			const inserted = await adapter.insert(T.serial, values, { schema })
			const row = normalize(await dialect.raw(T.serial, `id = ${inserted._id}`))
			expect(row).toMatchObject({ title: 'From the editor', rating: null, published_at: null })
			expect(String(row.price)).toMatch(/^0\.1(0+)?$/)
		})

		it('refuses an insert missing a NOT NULL column without a default', async () => {
			const schema = await adapter.describeTable(T.serial)
			const { issues } = preflightSql({ rating: 1 }, schema, { mode: 'insert' })
			expect(issues.map((issue) => issue.field)).toEqual(['title'])
		})

		it('round-trips a UUID key, generating one when the source has no default', async () => {
			const schema = await adapter.describeTable(T.uuid)
			const inserted = await adapter.insert(T.uuid, { title: 'Second' }, { schema })
			expect(inserted._id).toMatch(/^[0-9a-f-]{36}$/)
			expect((await adapter.findById(T.uuid, inserted._id))?.title).toBe('Second')
		})

		it('addresses a composite key through its JSON-array external id', async () => {
			const [doc] = await adapter.findAll(T.composite)
			expect(doc._id).toBe('["acme","hello"]')
			await adapter.update(T.composite, doc._id, { title: 'Renamed' })
			expect((await adapter.findById(T.composite, doc._id))?.title).toBe('Renamed')
			const inserted = await adapter.insert(T.composite, {
				tenant: 'acme',
				slug: 'second',
				title: 'Two',
			})
			expect(inserted._id).toBe('["acme","second"]')
			const streamed: string[] = []
			for await (const batch of adapter.streamAll(T.composite, {
				batchSize: 1,
				startAfterId: doc._id,
			})) {
				streamed.push(...batch.map((row) => row._id))
			}
			expect(streamed).toEqual(['["acme","second"]'])
		})

		it('falls back to an id column on a table without a primary key', async () => {
			const [doc] = await adapter.findAll(T.nokey)
			expect(doc._id).toBe('7')
			await adapter.update(T.nokey, '7', { title: 'Still addressable' })
			expect((await adapter.findById(T.nokey, '7'))?.title).toBe('Still addressable')
		})

		it.skipIf(entry.name !== 'mysql')('writes a checkbox into tinyint(1) as 0/1', async () => {
			const schema = await adapter.describeTable(T.serial)
			const [doc] = await adapter.findAll(T.serial)
			await adapter.update(T.serial, doc._id, { active: false }, { schema })
			expect(normalize(await dialect.raw(T.serial, `id = ${doc._id}`)).active).toBe(0)
		})

		it.skipIf(entry.name !== 'postgresql')(
			'writes jsonb and text[] back in their own types',
			async () => {
				const schema = await adapter.describeTable(T.serial)
				const [doc] = await adapter.findAll(T.serial)
				await adapter.update(
					T.serial,
					doc._id,
					{ body: ['now', 'an', 'array'], tags: ['z'] },
					{ schema },
				)
				const row = await dialect.raw(T.serial, `id = ${doc._id}`)
				expect(row.body).toEqual(['now', 'an', 'array'])
				expect(row.tags).toEqual(['z'])
			},
		)
	})
}
