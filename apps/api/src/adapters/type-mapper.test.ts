import { describe, expect, it } from 'vitest'
import { mapColumnType, tableNameToLabel } from './type-mapper.js'

describe('mapColumnType', () => {
	it('maps numeric column types', () => {
		for (const t of ['integer', 'bigint', 'numeric', 'double precision', 'tinyint', 'real']) {
			expect(mapColumnType(t)).toBe('number')
		}
	})

	it('maps boolean, date, object, array, and enum types', () => {
		expect(mapColumnType('boolean')).toBe('boolean')
		expect(mapColumnType('bit')).toBe('boolean')
		expect(mapColumnType('timestamp with time zone')).toBe('date')
		expect(mapColumnType('datetime')).toBe('date')
		expect(mapColumnType('jsonb')).toBe('object')
		expect(mapColumnType('array')).toBe('array')
		expect(mapColumnType('_text')).toBe('array')
		expect(mapColumnType('enum')).toBe('enum')
		expect(mapColumnType('set')).toBe('enum')
	})

	it('falls back to text for unknown types', () => {
		expect(mapColumnType('varchar')).toBe('text')
		expect(mapColumnType('uuid')).toBe('text')
	})
})

describe('tableNameToLabel', () => {
	it('humanizes snake_case, kebab-case, and camelCase names', () => {
		expect(tableNameToLabel('blog_posts')).toBe('Blog Posts')
		expect(tableNameToLabel('user-profiles')).toBe('User Profiles')
		expect(tableNameToLabel('courseModules')).toBe('Course Modules')
		expect(tableNameToLabel('content')).toBe('Content')
	})
})
