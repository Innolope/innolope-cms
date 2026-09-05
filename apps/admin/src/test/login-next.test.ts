import { describe, expect, it } from 'vitest'
import { safeNextParam } from '../routes/login'

describe('safeNextParam', () => {
	it('keeps same-origin paths', () => {
		expect(safeNextParam('?next=%2Fcollections%2Fposts')).toBe('/collections/posts')
	})
	it('rejects protocol-relative, backslash and control-character escapes', () => {
		expect(safeNextParam('?next=%2F%2Fevil.example')).toBe('/')
		expect(safeNextParam('?next=%2F%5Cevil.example')).toBe('/')
		expect(safeNextParam('?next=%2Fx%0D%0Aevil')).toBe('/')
		expect(safeNextParam('?next=https%3A%2F%2Fevil.example')).toBe('/')
	})
	it('never bounces back into the login flow', () => {
		expect(safeNextParam('?next=%2Flogin%3Fnext%3D%2Fx')).toBe('/')
	})
})
