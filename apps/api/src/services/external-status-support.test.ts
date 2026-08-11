import { externalStatusSupport, isSchemalessExternalDb } from '@innolope/config'
import { describe, expect, it } from 'vitest'

describe('isSchemalessExternalDb', () => {
	it('recognises MongoDB and nothing else', () => {
		expect(isSchemalessExternalDb('mongodb')).toBe(true)
		expect(isSchemalessExternalDb('postgresql')).toBe(false)
		expect(isSchemalessExternalDb(null)).toBe(false)
		expect(isSchemalessExternalDb(undefined)).toBe(false)
	})
})

describe('externalStatusSupport', () => {
	const fields = [{ name: 'title' }]

	it('supports every internal collection — the CMS owns the row', () => {
		expect(
			externalStatusSupport({ source: 'internal', accessMode: null, fields, dbType: null }),
		).toEqual({ supported: true })
	})

	it('supports a schemaless target even with no status field declared', () => {
		// This is the whole point: writing `status` to a Mongo document that never
		// had one simply adds the field, so an external draft can finally be hidden.
		expect(
			externalStatusSupport({
				source: 'external',
				accessMode: 'read-write',
				fields,
				dbType: 'mongodb',
			}),
		).toEqual({ supported: true })
	})

	it('reports a SQL target with no status column as unsupported', () => {
		expect(
			externalStatusSupport({
				source: 'external',
				accessMode: 'read-write',
				fields,
				dbType: 'postgresql',
			}),
		).toEqual({ supported: false, reason: 'no-status-column' })
	})

	it('supports a SQL target that declares a status column', () => {
		expect(
			externalStatusSupport({
				source: 'external',
				accessMode: 'read-write',
				fields: [...fields, { name: 'status' }],
				dbType: 'postgresql',
			}),
		).toEqual({ supported: true })
	})

	it('reports read-only collections separately — nothing reaches the source at all', () => {
		expect(
			externalStatusSupport({
				source: 'external',
				accessMode: 'read-only',
				fields: [...fields, { name: 'status' }],
				dbType: 'mongodb',
			}),
		).toEqual({ supported: false, reason: 'read-only' })
	})
})
