import { randomUUID } from 'node:crypto'
import { content, type Database, media, mediaIngestLedger } from '@innolope/db'
import { and, eq, lt } from 'drizzle-orm'
import type { IngestResult } from './media-ingest.js'
import { ingestError } from './media-ingest-policy.js'

export interface LedgerClaim {
	claimId: string
	status: 'pending' | 'done'
	updatedAt: Date
	result: IngestResult | null
	mediaId: string | null
	contentId: string | null
}
export interface LedgerStore {
	claim(owner: string): Promise<boolean>
	read(): Promise<LedgerClaim | undefined>
	recordExists(row: LedgerClaim): Promise<boolean>
	forgetDone(owner: string): Promise<void>
	takeover(owner: string, previous: string, olderThan: Date): Promise<boolean>
	finish(owner: string, result: IngestResult): Promise<boolean>
	release(owner: string): Promise<void>
	receipt(owner: string, result: IngestResult): Promise<void>
}
/** Pure state machine; the store implements each transition atomically in Postgres. */
export async function runIngestLedger(
	store: LedgerStore,
	perform: () => Promise<IngestResult>,
	force = false,
	clock = {
		now: () => Date.now(),
		wait: (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
	},
): Promise<IngestResult> {
	const owner = randomUUID()
	if (force) {
		const result = await perform()
		await store.receipt(owner, result)
		return result
	}
	const started = clock.now()
	for (;;) {
		let claimed = await store.claim(owner)
		if (!claimed) {
			const existing = await store.read()
			if (existing?.status === 'done') {
				if (existing.result && (await store.recordExists(existing)))
					return { ...existing.result, duplicate: true }
				await store.forgetDone(existing.claimId)
			} else if (existing)
				claimed = await store.takeover(owner, existing.claimId, new Date(clock.now() - 300_000))
		}
		if (claimed) {
			try {
				const result = await perform()
				if (!(await store.finish(owner, result)))
					throw ingestError(
						'Upload finished after its ledger claim expired; outcome needs reconciliation. Call list_media before retrying.',
						409,
					)
				return result
			} catch (err) {
				await store.release(owner)
				throw err
			}
		}
		if (clock.now() - started >= 29_000)
			throw ingestError(
				'An identical media upload is still pending. Call list_media, then retry upload_media after it completes.',
				409,
			)
		await clock.wait(100)
	}
}
export async function ingestOnce(
	db: Database,
	projectId: string,
	targetKey: string,
	sha256: string,
	perform: () => Promise<IngestResult>,
	force = false,
	verifyRecord?: (row: LedgerClaim) => Promise<boolean>,
) {
	const key = and(
		eq(mediaIngestLedger.projectId, projectId),
		eq(mediaIngestLedger.targetKey, targetKey),
		eq(mediaIngestLedger.sha256, sha256),
	)
	const owned = (owner: string, status: 'pending' | 'done') =>
		and(key, eq(mediaIngestLedger.claimId, owner), eq(mediaIngestLedger.status, status))
	const receipt = (claimId: string, result: IngestResult) => ({
		projectId,
		targetKey,
		sha256,
		claimId,
		status: 'done' as const,
		result,
		mediaId: result.target.kind === 'library' ? result.id : null,
		contentId: result.target.kind === 'collection' ? result.id : null,
		externalId: result.externalId,
		updatedAt: new Date(),
	})
	return runIngestLedger(
		{
			claim: async (claimId) =>
				(
					await db
						.insert(mediaIngestLedger)
						.values({ projectId, targetKey, sha256, claimId, status: 'pending' })
						.onConflictDoNothing()
						.returning({ id: mediaIngestLedger.id })
				).length > 0,
			read: async () => {
				const [row] = await db.select().from(mediaIngestLedger).where(key).limit(1)
				return row ? { ...row, result: row.result as unknown as IngestResult | null } : undefined
			},
			recordExists: async (row) => {
				const table = row.mediaId ? media : content
				const id = row.mediaId ?? row.contentId
				if (!id) return false
				const records = await db
					.select({ id: table.id })
					.from(table)
					.where(and(eq(table.id, id), eq(table.projectId, projectId)))
					.limit(1)
				return records.length > 0 && (!verifyRecord || (await verifyRecord(row)))
			},
			forgetDone: async (owner) => {
				await db.delete(mediaIngestLedger).where(owned(owner, 'done'))
			},
			takeover: async (owner, previous, olderThan) =>
				(
					await db
						.update(mediaIngestLedger)
						.set({ claimId: owner, updatedAt: new Date() })
						.where(and(owned(previous, 'pending'), lt(mediaIngestLedger.updatedAt, olderThan)))
						.returning({ id: mediaIngestLedger.id })
				).length > 0,
			finish: async (owner, result) =>
				(
					await db
						.update(mediaIngestLedger)
						.set(receipt(owner, result))
						.where(owned(owner, 'pending'))
						.returning({ id: mediaIngestLedger.id })
				).length > 0,
			release: async (owner) => {
				await db.delete(mediaIngestLedger).where(owned(owner, 'pending'))
			},
			receipt: async (owner, result) => {
				const values = receipt(owner, result)
				await db
					.insert(mediaIngestLedger)
					.values(values)
					.onConflictDoUpdate({
						target: [
							mediaIngestLedger.projectId,
							mediaIngestLedger.targetKey,
							mediaIngestLedger.sha256,
						],
						set: values,
						setWhere: eq(mediaIngestLedger.status, 'done'),
					})
			},
		},
		perform,
		force,
	)
}
