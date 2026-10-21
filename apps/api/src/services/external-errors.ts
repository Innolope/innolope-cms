/**
 * Turning a failed write to an external database into something an editor can
 * act on.
 *
 * The drivers say exactly what went wrong — which column was NULL, which index
 * collided, which value the column's type refused — and a generic
 * "Failed to sync to external database" threw all of it away. Each recognised
 * error becomes a response in the same shape as a schema validation failure
 * (`fields` for API clients, `issues` for the editor's inline messages), so the
 * message lands next to the field that caused it.
 *
 * Unrecognised errors stay a 502, but their sanitised driver message is logged
 * so support can see it.
 */

import type { CollectionField } from '@innolope/config'

export type ExternalErrorCode =
	| 'EXTERNAL_REQUIRED'
	| 'EXTERNAL_DUPLICATE'
	| 'EXTERNAL_INVALID_VALUE'
	| 'EXTERNAL_TOO_LONG'
	| 'EXTERNAL_UNKNOWN_COLUMN'
	| 'EXTERNAL_CONSTRAINT'
	| 'EXTERNAL_REFERENCE'
	| 'EXTERNAL_REFUSED'
	| 'EXTERNAL_UNREACHABLE'
	| 'EXTERNAL_WRITE_FAILED'

export interface ExternalFieldIssue {
	field: string
	message: string
}

export interface ExternalWriteFailure {
	statusCode: number
	code: ExternalErrorCode
	error: string
	fields: ExternalFieldIssue[]
	/** Set for an unknown-column error: the caller re-scans and retries once. */
	unknownColumn?: string
	/** The sanitised driver message, for the server log. */
	detail?: string
}

/** A failure the routes turn into a structured HTTP response. */
export class ExternalWriteError extends Error {
	readonly statusCode: number
	readonly failure: ExternalWriteFailure

	constructor(failure: ExternalWriteFailure) {
		super(failure.error)
		this.name = 'ExternalWriteError'
		this.statusCode = failure.statusCode
		this.failure = failure
	}
}

/** The response body for a failure — the content-validation shape plus a code. */
export function externalFailureBody(failure: ExternalWriteFailure) {
	return {
		error: failure.error,
		code: failure.code,
		fields: failure.fields,
		issues: failure.fields.map((issue) => ({
			path: `metadata.${issue.field}`,
			message: issue.message,
		})),
	}
}

type DriverError = {
	code?: string | number
	errno?: number
	message?: string
	sqlMessage?: string
	column_name?: string
	constraint_name?: string
	table_name?: string
	detail?: string
	keyPattern?: Record<string, unknown>
	keyValue?: Record<string, unknown>
	name?: string
	cause?: unknown
}

const NETWORK_CODES = new Set([
	'ECONNREFUSED',
	'ECONNRESET',
	'ETIMEDOUT',
	'ENOTFOUND',
	'EHOSTUNREACH',
	'EAI_AGAIN',
	'CONNECT_TIMEOUT',
	// Postgres: bad password, no such role, no such database, server shutting down.
	'28P01',
	'28000',
	'3D000',
	'57P01',
	'57P03',
	// MySQL: access denied, unknown database, too many connections.
	'ER_ACCESS_DENIED_ERROR',
	'ER_BAD_DB_ERROR',
	'ER_CON_COUNT_ERROR',
	'PROTOCOL_CONNECTION_LOST',
])

const NETWORK_ERROR_NAMES = new Set([
	'MongoServerSelectionError',
	'MongoNetworkError',
	'MongoNetworkTimeoutError',
	'MongoTopologyClosedError',
])

/** The IP allow-list hint the connection test already gives. */
export function allowListHint(): string {
	const sshHost = process.env.SSH_HOST
	return sshHost
		? ` If your database requires IP whitelisting, add ${sshHost} to your allow list.`
		: " If your database requires IP whitelisting, add this server's IP to your allow list."
}

/** Strip anything credential-shaped from a driver message before logging it. */
export function sanitizeDriverMessage(message: string): string {
	return message
		.replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s'"]+/gi, '<connection-string>')
		.replace(/(password|pwd|secret|token)=\S+/gi, '$1=<redacted>')
		.slice(0, 500)
}

function labelFor(fields: CollectionField[], column: string): string {
	const field = fields.find((f) => f.name === column)
	return field?.label || column
}

/** Find the payload key holding a value the database quoted back in its message. */
function keyHoldingValue(payload: Record<string, unknown>, quoted: string): string | undefined {
	for (const [key, value] of Object.entries(payload)) {
		if (value === null || value === undefined) continue
		const text = value instanceof Date ? value.toISOString() : String(value)
		if (text === quoted) return key
	}
	return undefined
}

/** The payload key whose string value is longer than `limit`. */
function keyLongerThan(payload: Record<string, unknown>, limit: number): string | undefined {
	return Object.entries(payload).find(
		([, value]) => typeof value === 'string' && value.length > limit,
	)?.[0]
}

/** The first column a Postgres `Key (a, b)=(…)` detail names. */
function keyColumnsFromDetail(detail: string | undefined): string[] {
	const match = /Key \(([^)]+)\)=/.exec(detail ?? '')
	return match ? match[1].split(',').map((column) => column.trim().replace(/^"|"$/g, '')) : []
}

function failure(
	statusCode: number,
	code: ExternalErrorCode,
	error: string,
	fields: ExternalFieldIssue[] = [],
	extra: Partial<ExternalWriteFailure> = {},
): ExternalWriteFailure {
	return { statusCode, code, error, fields, ...extra }
}

/**
 * Classify a driver error raised by an external write.
 *
 * `payload` is what the write sent; Postgres does not name the column for a bad
 * input value, but it quotes the value, which is enough to find the key.
 */
export function describeExternalDbError(
	err: unknown,
	ctx: { fields?: CollectionField[] | null; payload?: Record<string, unknown> } = {},
): ExternalWriteFailure {
	if (err instanceof ExternalWriteError) return err.failure
	const fields = ctx.fields ?? []
	const payload = ctx.payload ?? {}
	const e = (err ?? {}) as DriverError
	const message = String(e.sqlMessage ?? e.message ?? '')
	const detail = sanitizeDriverMessage(message)
	const code = e.code !== undefined ? String(e.code) : ''
	const issue = (column: string, text: string) => ({
		field: column,
		message: text.replace('{label}', labelFor(fields, column)),
	})

	// ── Unreachable source ────────────────────────────────────────────────────
	if (NETWORK_CODES.has(code) || (e.name && NETWORK_ERROR_NAMES.has(e.name))) {
		return failure(
			502,
			'EXTERNAL_UNREACHABLE',
			`Could not reach the external database.${allowListHint()}`,
			[],
			{ detail },
		)
	}

	// ── PostgreSQL (SQLSTATE codes) ───────────────────────────────────────────
	if (/^[0-9A-Z]{5}$/.test(code) && !/^ER_/.test(code)) {
		switch (code) {
			case '23502': {
				const column = e.column_name ?? /column "([^"]+)"/.exec(message)?.[1]
				return failure(
					400,
					'EXTERNAL_REQUIRED',
					column
						? `"${labelFor(fields, column)}" is required by the source database.`
						: 'The source database requires a value that was left empty.',
					column ? [issue(column, '{label} is required by the source database.')] : [],
					{ detail },
				)
			}
			case '23505': {
				const columns = keyColumnsFromDetail(e.detail)
				return failure(
					409,
					'EXTERNAL_DUPLICATE',
					columns.length
						? `Another record in the source database already uses this ${columns
								.map((column) => labelFor(fields, column))
								.join(' + ')}.`
						: `Another record in the source database already has this value (${e.constraint_name ?? 'unique index'}).`,
					columns.map((column) =>
						issue(column, 'Another record in the source database already uses this value.'),
					),
					{ detail },
				)
			}
			case '22P02':
			case '22007':
			case '22008':
			case '22003': {
				const quoted = /: "((?:[^"\\]|\\.)*)"/.exec(message)?.[1]
				const expected = /for type ([a-z0-9 ]+)/i.exec(message)?.[1]?.trim()
				const column = quoted !== undefined ? keyHoldingValue(payload, quoted) : undefined
				const reason =
					code === '22003'
						? 'is out of range for the source column'
						: `is not a valid ${expected ?? 'value'} for the source column`
				return failure(
					400,
					'EXTERNAL_INVALID_VALUE',
					column
						? `"${labelFor(fields, column)}" ${reason}.`
						: `The source database rejected a value: ${reason}.`,
					column ? [issue(column, `{label} ${reason}.`)] : [],
					{ detail },
				)
			}
			case '22001': {
				const limit = Number(/\((\d+)\)/.exec(message)?.[1])
				const column = Number.isFinite(limit) ? keyLongerThan(payload, limit) : undefined
				const text = Number.isFinite(limit)
					? `is longer than the ${limit} characters the source column allows`
					: 'is longer than the source column allows'
				return failure(
					400,
					'EXTERNAL_TOO_LONG',
					column ? `"${labelFor(fields, column)}" ${text}.` : `A value ${text}.`,
					column ? [issue(column, `{label} ${text}.`)] : [],
					{ detail },
				)
			}
			case '42703': {
				const column = /column "([^"]+)"/.exec(message)?.[1]
				return failure(
					400,
					'EXTERNAL_UNKNOWN_COLUMN',
					column
						? `"${labelFor(fields, column)}" no longer exists in the source table. Reload the editor and try again.`
						: 'A column no longer exists in the source table. Reload the editor and try again.',
					column ? [issue(column, '{label} no longer exists in the source table.')] : [],
					{ detail, ...(column && { unknownColumn: column }) },
				)
			}
			case '23514':
				return failure(
					400,
					'EXTERNAL_CONSTRAINT',
					`The source database rejected this record: check constraint "${e.constraint_name ?? 'unknown'}" failed.`,
					[],
					{ detail },
				)
			case '23503': {
				const [column] = keyColumnsFromDetail(e.detail)
				const target = /table "([^"]+)"/.exec(e.detail ?? '')?.[1]
				const text = `must point to an existing record${target ? ` in ${target}` : ''}`
				return failure(
					400,
					'EXTERNAL_REFERENCE',
					column ? `"${labelFor(fields, column)}" ${text}.` : `A reference ${text}.`,
					column ? [issue(column, `{label} ${text}.`)] : [],
					{ detail },
				)
			}
		}
	}

	// ── MySQL ─────────────────────────────────────────────────────────────────
	const errno = typeof e.errno === 'number' ? e.errno : undefined
	if (errno !== undefined || /^ER_/.test(code)) {
		const columnFromMessage =
			/(?:column|Column|Field) '([^']+)'/.exec(message)?.[1] ??
			/for column '([^']+)'/.exec(message)?.[1]
		switch (errno) {
			case 1048:
			case 1364:
				return failure(
					400,
					'EXTERNAL_REQUIRED',
					columnFromMessage
						? `"${labelFor(fields, columnFromMessage)}" is required by the source database.`
						: 'The source database requires a value that was left empty.',
					columnFromMessage
						? [issue(columnFromMessage, '{label} is required by the source database.')]
						: [],
					{ detail },
				)
			case 1062: {
				const index = /for key '([^']+)'/.exec(message)?.[1]
				const column = index?.split('.').pop()
				const known = column && fields.some((field) => field.name === column)
				return failure(
					409,
					'EXTERNAL_DUPLICATE',
					known
						? `Another record in the source database already uses this ${labelFor(fields, column)}.`
						: `Another record in the source database already has this value (${index ?? 'unique index'}).`,
					known
						? [issue(column, 'Another record in the source database already uses this value.')]
						: [],
					{ detail },
				)
			}
			case 1366:
			case 1292:
			case 1264:
			case 1265: {
				const expected = /Incorrect (\w+) value/.exec(message)?.[1]
				const reason =
					errno === 1264
						? 'is out of range for the source column'
						: `is not a valid ${expected ?? 'value'} for the source column`
				return failure(
					400,
					'EXTERNAL_INVALID_VALUE',
					columnFromMessage
						? `"${labelFor(fields, columnFromMessage)}" ${reason}.`
						: `The source database rejected a value: ${reason}.`,
					columnFromMessage ? [issue(columnFromMessage, `{label} ${reason}.`)] : [],
					{ detail },
				)
			}
			case 1406:
				return failure(
					400,
					'EXTERNAL_TOO_LONG',
					columnFromMessage
						? `"${labelFor(fields, columnFromMessage)}" is longer than the source column allows.`
						: 'A value is longer than the source column allows.',
					columnFromMessage
						? [issue(columnFromMessage, '{label} is longer than the source column allows.')]
						: [],
					{ detail },
				)
			case 1054:
				return failure(
					400,
					'EXTERNAL_UNKNOWN_COLUMN',
					columnFromMessage
						? `"${labelFor(fields, columnFromMessage)}" no longer exists in the source table. Reload the editor and try again.`
						: 'A column no longer exists in the source table. Reload the editor and try again.',
					columnFromMessage
						? [issue(columnFromMessage, '{label} no longer exists in the source table.')]
						: [],
					{ detail, ...(columnFromMessage && { unknownColumn: columnFromMessage }) },
				)
			case 3819: {
				const constraint = /Check constraint '([^']+)'/.exec(message)?.[1]
				return failure(
					400,
					'EXTERNAL_CONSTRAINT',
					`The source database rejected this record: check constraint "${constraint ?? 'unknown'}" failed.`,
					[],
					{ detail },
				)
			}
			case 1452:
				return failure(
					400,
					'EXTERNAL_REFERENCE',
					'A reference must point to an existing record in the source database.',
					[],
					{ detail },
				)
		}
	}

	// ── MongoDB ───────────────────────────────────────────────────────────────
	if (code === '11000' || code === '11001') {
		const columns = Object.keys(e.keyPattern ?? e.keyValue ?? {})
		return failure(
			409,
			'EXTERNAL_DUPLICATE',
			columns.length
				? `Another record in the source database already uses this ${columns
						.map((column) => labelFor(fields, column))
						.join(' + ')}.`
				: 'Another record in the source database already has this value.',
			columns.map((column) =>
				issue(column, 'Another record in the source database already uses this value.'),
			),
			{ detail },
		)
	}
	if (code === '121') {
		return failure(
			400,
			'EXTERNAL_CONSTRAINT',
			'The source collection’s validation rules rejected this record.',
			[],
			{ detail },
		)
	}

	return failure(502, 'EXTERNAL_WRITE_FAILED', 'Failed to sync to external database', [], {
		detail,
	})
}

/**
 * Answer a failed external write with the driver's reason, field by field, and
 * log the sanitised driver message for support.
 */
export function sendExternalWriteFailure(
	reply: { status: (code: number) => { send: (body: unknown) => unknown } },
	err: unknown,
	ctx: {
		log: { warn: (obj: unknown, msg: string) => void }
		message: string
		fields?: CollectionField[] | null
	},
) {
	const failure = describeExternalDbError(err, { fields: ctx.fields })
	ctx.log.warn({ err, code: failure.code, detail: failure.detail }, ctx.message)
	return reply.status(failure.statusCode).send(externalFailureBody(failure))
}
