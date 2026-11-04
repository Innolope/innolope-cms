import type { FastifyInstance } from 'fastify'

type ContentTransaction = Parameters<Parameters<FastifyInstance['db']['transaction']>[0]>[0]
export async function withContentTransaction<T>(
	app: FastifyInstance,
	write: (
		tx: ContentTransaction,
		afterCommit: (effect: () => void) => void,
		afterRollback: (effect: () => Promise<void>) => void,
	) => Promise<T>,
): Promise<T> {
	const effects: Array<() => void> = []
	const rollbackEffects: Array<() => Promise<void>> = []
	let result: T
	try {
		result = await app.db.transaction((tx) =>
			write(
				tx,
				(effect) => effects.push(effect),
				(effect) => rollbackEffects.push(effect),
			),
		)
	} catch (error) {
		// The transaction (including commit) has failed and its locks are released.
		// Provider compensation may now safely use the ordinary connection pool.
		for (const effect of rollbackEffects.reverse()) {
			try {
				await effect()
			} catch (err) {
				app.log.error(err, 'Content rollback compensation failed')
			}
		}
		throw error
	}
	// SSE and webhook listeners must observe the committed revision.
	for (const effect of effects) effect()
	return result
}
