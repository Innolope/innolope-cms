import { describe, expect, it } from 'vitest'
import { nextPathAfterProjectSwitch } from './auth'

describe('nextPathAfterProjectSwitch', () => {
	it('sends collection-scoped routes to the dashboard', () => {
		expect(nextPathAfterProjectSwitch('/collections/articles')).toBe('/dashboard')
		expect(nextPathAfterProjectSwitch('/collections/articles/3831bae1')).toBe('/dashboard')
		expect(nextPathAfterProjectSwitch('/collections/articles/edit')).toBe('/dashboard')
		expect(nextPathAfterProjectSwitch('/collections/new')).toBe('/dashboard')
	})

	it('sends content-id routes to the dashboard', () => {
		expect(nextPathAfterProjectSwitch('/content/abc-123')).toBe('/dashboard')
	})

	it('keeps project-agnostic routes', () => {
		for (const path of [
			'/dashboard',
			'/collections',
			'/media',
			'/settings',
			'/account',
			'/review-queue',
		]) {
			expect(nextPathAfterProjectSwitch(path)).toBe(path)
		}
	})

	it('falls back to "/" for an empty pathname', () => {
		expect(nextPathAfterProjectSwitch('')).toBe('/')
	})
})
