import { describe, expect, it } from 'vitest'
import type { IngestResult } from './media-ingest.js'
import { type LedgerClaim, type LedgerStore, runIngestLedger } from './media-ledger.js'

const result: IngestResult = {
	id: 'record',
	externalId: null,
	filename: 'a.png',
	fullPath: 'https://cdn.test/a.png',
	deliveryUrl: 'https://cdn.test/a.png',
	deliveryVerified: true,
	width: 1,
	height: 1,
	bytes: 10,
	mimeType: 'image/png',
	sha256: 'abc',
	duplicate: false,
	target: { kind: 'library' },
}
function memoryStore(initial?: LedgerClaim) {
	let row = initial
	let exists = true
	let now = Date.now()
	const store: LedgerStore = {
		claim: async (claimId) => {
			if (row) return false
			row = {
				claimId,
				status: 'pending',
				updatedAt: new Date(now),
				result: null,
				mediaId: null,
				contentId: null,
			}
			return true
		},
		read: async () => row,
		recordExists: async () => exists,
		forgetDone: async (owner) => {
			if (row?.claimId === owner && row.status === 'done') row = undefined
		},
		takeover: async (owner, previous, cutoff) => {
			if (row?.claimId !== previous || row.status !== 'pending' || row.updatedAt >= cutoff)
				return false
			row = { ...row, claimId: owner, updatedAt: new Date(now) }
			return true
		},
		finish: async (owner, value) => {
			if (row?.claimId !== owner || row.status !== 'pending') return false
			row = { ...row, status: 'done', result: value, mediaId: value.id }
			return true
		},
		release: async (owner) => {
			if (row?.claimId === owner && row.status === 'pending') row = undefined
		},
		receipt: async (owner, value) => {
			if (!row || row.status === 'done')
				row = {
					claimId: owner,
					status: 'done',
					result: value,
					mediaId: value.id,
					contentId: null,
					updatedAt: new Date(now),
				}
		},
	}
	return {
		store,
		row: () => row,
		setRow: (value: LedgerClaim) => {
			row = value
		},
		deleted: () => {
			exists = false
		},
		clock: {
			now: () => now,
			wait: async (ms: number) => {
				now += ms
				await Promise.resolve()
			},
		},
	}
}
describe('durable ingest claim state machine (F6/F7)', () => {
	it('records one upload and returns a duplicate without side effects', async () => {
		const m = memoryStore()
		let uploads = 0
		const perform = async () => {
			uploads++
			return result
		}
		expect(await runIngestLedger(m.store, perform)).toEqual(result)
		expect(await runIngestLedger(m.store, perform)).toEqual({ ...result, duplicate: true })
		expect(uploads).toBe(1)
	})
	it('serializes deterministic overlapping identical callers and bounded 20-caller load', async () => {
		const m = memoryStore()
		let uploads = 0
		const perform = async () => {
			uploads++
			await new Promise((resolve) => setTimeout(resolve, 10))
			return result
		}
		const values = await Promise.all(
			Array.from({ length: 20 }, () => runIngestLedger(m.store, perform)),
		)
		expect(uploads).toBe(1)
		expect(values.filter((v) => v.duplicate)).toHaveLength(19)
	})
	it('releases a failed provider/external write claim and never marks done', async () => {
		const m = memoryStore()
		await expect(
			runIngestLedger(m.store, async () => {
				throw new Error('external insert failed')
			}),
		).rejects.toThrow(/external/)
		expect(m.row()).toBeUndefined()
		expect((await runIngestLedger(m.store, async () => result)).duplicate).toBe(false)
	})
	it('takes over a stale claim with CAS and prevents the old worker finishing/releasing it', async () => {
		const m = memoryStore({
			claimId: 'old',
			status: 'pending',
			updatedAt: new Date(Date.now() - 300_001),
			result: null,
			mediaId: null,
			contentId: null,
		})
		await runIngestLedger(m.store, async () => result, false, m.clock)
		expect(await m.store.finish('old', result)).toBe(false)
		await m.store.release('old')
		expect(m.row()?.status).toBe('done')
	})
	it('does not take over a fresh pending row and waits under 30 seconds', async () => {
		const m = memoryStore({
			claimId: 'other',
			status: 'pending',
			updatedAt: new Date(),
			result: null,
			mediaId: null,
			contentId: null,
		})
		let uploads = 0
		const start = m.clock.now()
		await expect(
			runIngestLedger(
				m.store,
				async () => {
					uploads++
					return result
				},
				false,
				m.clock,
			),
		).rejects.toThrow(/pending/)
		expect(m.clock.now() - start).toBe(29_000)
		expect(uploads).toBe(0)
		expect(m.row()?.claimId).toBe('other')
	})
	it('treats a deleted done record as absent and force bypasses an existing receipt', async () => {
		const m = memoryStore()
		let uploads = 0
		const perform = async () => {
			uploads++
			return result
		}
		await runIngestLedger(m.store, perform)
		m.deleted()
		await runIngestLedger(m.store, perform)
		await runIngestLedger(m.store, perform, true)
		expect(uploads).toBe(3)
	})
	it('never reports success after losing the claim during a provider write', async () => {
		const m = memoryStore()
		await expect(
			runIngestLedger(m.store, async () => {
				m.setRow({
					claimId: 'new',
					status: 'pending',
					updatedAt: new Date(),
					result: null,
					mediaId: null,
					contentId: null,
				})
				return result
			}),
		).rejects.toThrow(/reconciliation/)
		expect(m.row()?.claimId).toBe('new')
	})
})
