import { describe, expect, it } from 'vitest'
import { buildSubField, classifyMongoValue, type ObjectArrayShape } from './mongo-introspect.js'

describe('classifyMongoValue', () => {
	it('classifies primitives', () => {
		expect(classifyMongoValue('hi').type).toBe('text')
		expect(classifyMongoValue(5).type).toBe('number')
		expect(classifyMongoValue(true).type).toBe('boolean')
		expect(classifyMongoValue({ a: 1 }).type).toBe('object')
		expect(classifyMongoValue(new Date()).type).toBe('date')
	})

	it('treats null/undefined as unknown', () => {
		expect(classifyMongoValue(null).type).toBe('unknown')
		expect(classifyMongoValue(undefined).type).toBe('unknown')
	})

	it('detects ObjectId as a relation', () => {
		const oid = classifyMongoValue({ _bsontype: 'ObjectId' })
		expect(oid).toEqual({ type: 'relation', isObjectId: true, isArray: false })
	})

	it('detects arrays of ObjectIds and plain arrays', () => {
		expect(classifyMongoValue([{ _bsontype: 'ObjectId' }])).toEqual({
			type: 'relation',
			isObjectId: true,
			isArray: true,
		})
		expect(classifyMongoValue([1, 2, 3])).toEqual({
			type: 'array',
			isObjectId: false,
			isArray: true,
		})
	})
})

describe('buildSubField', () => {
	const shapeWith = (values: string[]): ObjectArrayShape => ({
		keys: ['platform'],
		stringValues: new Map([['platform', new Set(values)]]),
	})

	it('promotes a platform field to an enum when all values are known platforms', () => {
		const field = buildSubField('platform', shapeWith(['linkedin', 'twitter']))
		expect(field.type).toBe('enum')
		expect(field.options).toContain('linkedin')
		expect(field.options).toContain('twitter')
		// Known platforms not observed are still offered.
		expect(field.options).toContain('github')
	})

	it('keeps platform as free text when an unknown value is present', () => {
		const field = buildSubField('platform', shapeWith(['linkedin', 'myspace']))
		expect(field).toEqual({ name: 'platform', type: 'text' })
	})

	it('returns a plain text field for non-platform keys', () => {
		expect(buildSubField('url', shapeWith([]))).toEqual({ name: 'url', type: 'text' })
	})
})
