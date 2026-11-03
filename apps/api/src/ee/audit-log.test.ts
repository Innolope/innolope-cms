import { describe, expect, it } from 'vitest'
import { deriveAuditAction } from './audit-log.js'

const UUID = '123e4567-e89b-12d3-a456-426614174000'

describe('deriveAuditAction', () => {
	it('derives semantic media upload and field-edit actions without capability query secrets', () => {
		expect(
			deriveAuditAction('PATCH', '/api/v1/media/items/11111111-1111-4111-8111-111111111111'),
		).toMatchObject({
			action: 'media.update',
			resourceType: 'media',
			resourceId: '11111111-1111-4111-8111-111111111111',
		})
		expect(deriveAuditAction('POST', '/api/v1/media/ingest').action).toBe('media.ingest')
		expect(
			deriveAuditAction(
				'POST',
				'/api/v1/media/uploads/11111111-1111-4111-8111-111111111111/complete?token=secret',
			).action,
		).toBe('media.complete')
	})
	it('maps a collection create', () => {
		expect(deriveAuditAction('POST', '/api/v1/content')).toEqual({
			action: 'content.create',
			resourceType: 'content',
			resourceId: null,
		})
	})

	it('maps an update with a uuid resource id', () => {
		expect(deriveAuditAction('PATCH', `/api/v1/content/${UUID}`)).toEqual({
			action: 'content.update',
			resourceType: 'content',
			resourceId: UUID,
		})
	})

	it('uses a trailing sub-action as the verb', () => {
		expect(deriveAuditAction('POST', `/api/v1/content/${UUID}/publish`)).toEqual({
			action: 'content.publish',
			resourceType: 'content',
			resourceId: UUID,
		})
	})

	it('handles numeric ids and DELETE', () => {
		expect(deriveAuditAction('DELETE', '/api/v1/media/42')).toEqual({
			action: 'media.delete',
			resourceType: 'media',
			resourceId: '42',
		})
	})

	it('strips the /api/v1/ee prefix', () => {
		expect(deriveAuditAction('POST', '/api/v1/ee/sso/connections')).toEqual({
			action: 'sso.connections',
			resourceType: 'sso',
			resourceId: null,
		})
	})

	it('ignores the query string', () => {
		expect(deriveAuditAction('PUT', `/api/v1/projects/${UUID}?foo=bar`)).toEqual({
			action: 'projects.update',
			resourceType: 'projects',
			resourceId: UUID,
		})
	})
})
