import { describe, expect, it } from 'vitest'
import { roleChangeError } from './projects.js'

describe('roleChangeError', () => {
	it('refuses granting a role above the caller', () => {
		expect(roleChangeError('admin', undefined, 'owner')).toMatch(/above your own/)
		expect(roleChangeError('admin', undefined, 'admin')).toBeNull()
		expect(roleChangeError('owner', undefined, 'owner')).toBeNull()
	})
	it('refuses touching a member above the caller', () => {
		expect(roleChangeError('admin', 'owner', 'viewer')).toMatch(/above your own/)
		expect(roleChangeError('admin', 'owner', undefined)).toMatch(/above your own/)
		expect(roleChangeError('owner', 'admin', 'viewer')).toBeNull()
	})
	it('rejects unknown roles', () => {
		expect(roleChangeError('owner', undefined, 'superuser')).toBe('Invalid role')
	})
})
