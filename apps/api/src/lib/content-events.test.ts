import type { FastifyInstance } from 'fastify'
import { describe, expect, it } from 'vitest'
import { emitContentStatusEvent } from './content-events.js'

function fakeApp() {
	const emitted: Array<Record<string, unknown>> = []
	const app = {
		events: { emit: (e: Record<string, unknown>) => emitted.push(e) },
	} as unknown as FastifyInstance
	return { app, emitted }
}

const updated = { id: 'c1', slug: 'hello', status: 'published' }

describe('emitContentStatusEvent', () => {
	it('always emits the base event with the shared data shape', () => {
		const { app, emitted } = fakeApp()
		emitContentStatusEvent(app, {
			base: 'content:updated',
			previousStatus: 'draft',
			updated: { ...updated, status: 'draft' },
			projectId: 'p1',
		})
		expect(emitted).toHaveLength(1)
		expect(emitted[0]).toMatchObject({
			type: 'content:updated',
			data: { id: 'c1', slug: 'hello', status: 'draft', projectId: 'p1' },
		})
	})

	it.each([
		['newly created', null],
		['draft', 'draft'],
		['pending_review', 'pending_review'],
	])('adds content:published when %s content lands published', (_label, previousStatus) => {
		const { app, emitted } = fakeApp()
		emitContentStatusEvent(app, {
			base: previousStatus === null ? 'content:created' : 'content:approved',
			previousStatus,
			updated,
			projectId: 'p1',
		})
		expect(emitted.map((e) => e.type)).toContain('content:published')
		expect(emitted).toHaveLength(2)
		// Both events describe the same write
		expect(emitted[0].data).toEqual(emitted[1].data)
		expect(emitted[0].timestamp).toEqual(emitted[1].timestamp)
	})

	it('does not re-announce an already-published record', () => {
		const { app, emitted } = fakeApp()
		emitContentStatusEvent(app, {
			base: 'content:updated',
			previousStatus: 'published',
			updated,
			projectId: 'p1',
		})
		expect(emitted.map((e) => e.type)).toEqual(['content:updated'])
	})

	it('does not announce writes that stay unpublished', () => {
		const { app, emitted } = fakeApp()
		emitContentStatusEvent(app, {
			base: 'content:updated',
			previousStatus: 'draft',
			updated: { ...updated, status: 'draft' },
			projectId: 'p1',
		})
		expect(emitted.map((e) => e.type)).toEqual(['content:updated'])
	})

	it('passes extraData through to both events', () => {
		const { app, emitted } = fakeApp()
		emitContentStatusEvent(app, {
			base: 'content:created',
			previousStatus: null,
			updated,
			projectId: 'p1',
			extraData: { locale: 'en' },
		})
		for (const event of emitted) {
			expect(event.data).toMatchObject({ locale: 'en' })
		}
	})
})
