import { describe, expect, it } from 'vitest'
import {
	describeExternalDbError,
	ExternalWriteError,
	externalFailureBody,
	sanitizeDriverMessage,
} from './external-errors.js'

const fields = [
	{ name: 'title', label: 'Title', type: 'text' as const },
	{ name: 'price', type: 'number' as const },
	{ name: 'slug', type: 'text' as const },
]

describe('describeExternalDbError — PostgreSQL', () => {
	it('names the column of a NOT NULL violation', () => {
		const failure = describeExternalDbError(
			{
				code: '23502',
				column_name: 'title',
				message: 'null value in column "title" of relation "posts" violates not-null constraint',
			},
			{ fields },
		)
		expect(failure.statusCode).toBe(400)
		expect(failure.code).toBe('EXTERNAL_REQUIRED')
		expect(failure.fields).toEqual([
			{ field: 'title', message: 'Title is required by the source database.' },
		])
	})

	it('reports a duplicate key as a conflict on the indexed column', () => {
		const failure = describeExternalDbError(
			{
				code: '23505',
				constraint_name: 'posts_slug_key',
				detail: 'Key (slug)=(hello) already exists.',
				message: 'duplicate key value violates unique constraint "posts_slug_key"',
			},
			{ fields },
		)
		expect(failure.statusCode).toBe(409)
		expect(failure.fields[0].field).toBe('slug')
	})

	it('finds the column of a bad input value by the value Postgres quotes back', () => {
		const failure = describeExternalDbError(
			{ code: '22P02', message: 'invalid input syntax for type integer: "abc"' },
			{ fields, payload: { title: 'T', price: 'abc' } },
		)
		expect(failure.code).toBe('EXTERNAL_INVALID_VALUE')
		expect(failure.fields).toEqual([
			{ field: 'price', message: 'price is not a valid integer for the source column.' },
		])
	})

	it('finds the column of a too-long value by its length', () => {
		const failure = describeExternalDbError(
			{ code: '22001', message: 'value too long for type character varying(5)' },
			{ fields, payload: { title: 'Much too long', slug: 'ok' } },
		)
		expect(failure.code).toBe('EXTERNAL_TOO_LONG')
		expect(failure.fields[0].field).toBe('title')
	})

	it('flags an unknown column for a re-scan', () => {
		const failure = describeExternalDbError(
			{ code: '42703', message: 'column "subtitle" of relation "posts" does not exist' },
			{ fields },
		)
		expect(failure.unknownColumn).toBe('subtitle')
		expect(failure.statusCode).toBe(400)
	})

	it('names the failed check constraint', () => {
		const failure = describeExternalDbError(
			{ code: '23514', constraint_name: 'price_positive', message: 'new row violates check' },
			{ fields },
		)
		expect(failure.error).toContain('price_positive')
	})
})

describe('describeExternalDbError — MySQL', () => {
	it('names the column of a NULL into a NOT NULL column', () => {
		const failure = describeExternalDbError(
			{ errno: 1048, code: 'ER_BAD_NULL_ERROR', sqlMessage: "Column 'title' cannot be null" },
			{ fields },
		)
		expect(failure.code).toBe('EXTERNAL_REQUIRED')
		expect(failure.fields[0].field).toBe('title')
	})

	it('names the column of an incorrect value', () => {
		const failure = describeExternalDbError(
			{
				errno: 1366,
				code: 'ER_TRUNCATED_WRONG_VALUE_FOR_FIELD',
				sqlMessage: "Incorrect integer value: 'abc' for column 'price' at row 1",
			},
			{ fields },
		)
		expect(failure.code).toBe('EXTERNAL_INVALID_VALUE')
		expect(failure.fields[0]).toEqual({
			field: 'price',
			message: 'price is not a valid integer for the source column.',
		})
	})

	it('maps a duplicate entry to its key column', () => {
		const failure = describeExternalDbError(
			{ errno: 1062, sqlMessage: "Duplicate entry 'hello' for key 'posts.slug'" },
			{ fields },
		)
		expect(failure.statusCode).toBe(409)
		expect(failure.fields[0].field).toBe('slug')
	})

	it('flags an unknown column for a re-scan', () => {
		const failure = describeExternalDbError(
			{ errno: 1054, sqlMessage: "Unknown column 'subtitle' in 'field list'" },
			{ fields },
		)
		expect(failure.unknownColumn).toBe('subtitle')
	})
})

describe('describeExternalDbError — MongoDB', () => {
	it('reports a duplicate key by the index keys', () => {
		const failure = describeExternalDbError(
			{ code: 11000, keyPattern: { slug: 1 }, message: 'E11000 duplicate key error' },
			{ fields },
		)
		expect(failure.statusCode).toBe(409)
		expect(failure.fields.map((issue) => issue.field)).toEqual(['slug'])
	})

	it('reports a document-validation failure as a 400', () => {
		const failure = describeExternalDbError({ code: 121, message: 'Document failed validation' })
		expect(failure.statusCode).toBe(400)
	})
})

describe('describeExternalDbError — unreachable and unknown', () => {
	it('adds the allow-list hint for a network failure', () => {
		const failure = describeExternalDbError({ code: 'ECONNREFUSED', message: 'connect refused' })
		expect(failure.statusCode).toBe(502)
		expect(failure.error).toContain('allow list')
	})

	it('treats a MongoDB server-selection timeout as unreachable', () => {
		const failure = describeExternalDbError({ name: 'MongoServerSelectionError', message: 'x' })
		expect(failure.code).toBe('EXTERNAL_UNREACHABLE')
	})

	it('keeps anything else a generic 502', () => {
		const failure = describeExternalDbError(new Error('something odd'))
		expect(failure).toMatchObject({ statusCode: 502, code: 'EXTERNAL_WRITE_FAILED' })
	})

	it('passes an already-classified failure through', () => {
		const inner = describeExternalDbError({ code: '23502', column_name: 'title', message: '' })
		expect(describeExternalDbError(new ExternalWriteError(inner))).toBe(inner)
	})
})

describe('externalFailureBody', () => {
	it('carries the issues the editor shows inline', () => {
		const failure = describeExternalDbError(
			{ code: '23502', column_name: 'title', message: '' },
			{ fields },
		)
		expect(externalFailureBody(failure).issues).toEqual([
			{ path: 'metadata.title', message: 'Title is required by the source database.' },
		])
	})
})

describe('sanitizeDriverMessage', () => {
	it('redacts connection strings and passwords', () => {
		expect(
			sanitizeDriverMessage('failed for postgres://u:p@host/db with password=hunter2 ok'),
		).toBe('failed for <connection-string> with password=<redacted> ok')
	})
})
