/**
 * Deployed-build freshness check.
 *
 * The admin is a SPA: a tab keeps running whatever bundle it loaded, and
 * client-side navigation never refetches it — after a redeploy a long-lived
 * tab renders days-old UI with no signal (seen in production: an editor saw
 * pre-fix date inputs and a missing image field days after the fix shipped).
 *
 * The bundle carries `__BUILD_ID__` (vite.config.ts `define`); the same id is
 * emitted as /version.json next to index.html. Polling that file and comparing
 * ids tells a running tab a newer build is live so it can offer a reload.
 */

/** Build id compiled into this bundle. `dev` under the dev server (no define). */
export const BUILD_ID: string = typeof __BUILD_ID__ === 'string' ? __BUILD_ID__ : 'dev'

/** How often a visible tab re-checks. Focus/visibility also trigger a check. */
const POLL_INTERVAL_MS = 5 * 60 * 1000

/**
 * Read the deployed build id. `no-store` bypasses the HTTP cache (asset
 * responses are cacheable for hours). Returns null when the file is missing or
 * unparseable — e.g. a deployment predating it, where the SPA 404-fallback
 * answers with index.html — so the caller just stays quiet.
 */
export async function fetchDeployedBuildId(): Promise<string | null> {
	try {
		const res = await fetch('/version.json', { cache: 'no-store' })
		if (!res.ok) return null
		const body = (await res.json()) as { buildId?: unknown }
		return typeof body.buildId === 'string' && body.buildId ? body.buildId : null
	} catch {
		return null
	}
}

export interface UpdateWatcherOptions {
	/** The id this bundle was built with. */
	currentId: string
	/** Reads the deployed id; null means "couldn't tell" and is ignored. */
	fetchId: () => Promise<string | null>
	/** Called exactly once, the first time a different deployed id is seen. */
	onUpdate: () => void
	intervalMs?: number
}

/**
 * Start watching for a newer deployed build: an interval plus a check whenever
 * the tab regains focus/visibility (the exact moment a user returns to a
 * long-lived tab). Fires `onUpdate` once, then stands down — the only cure is
 * a reload, so repeating the news would just nag. Returns a stop function.
 */
export function startUpdateWatcher(opts: UpdateWatcherOptions): () => void {
	const { currentId, fetchId, onUpdate, intervalMs = POLL_INTERVAL_MS } = opts
	let stopped = false
	let notified = false
	let inFlight = false

	const check = async () => {
		if (stopped || notified || inFlight) return
		inFlight = true
		try {
			// A failed check is a non-event — the next tick simply tries again.
			const deployed = await fetchId().catch(() => null)
			if (!stopped && !notified && deployed && deployed !== currentId) {
				notified = true
				stop()
				onUpdate()
			}
		} finally {
			inFlight = false
		}
	}

	const onVisible = () => {
		if (document.visibilityState === 'visible') void check()
	}

	const timer = setInterval(() => void check(), intervalMs)
	window.addEventListener('focus', onVisible)
	document.addEventListener('visibilitychange', onVisible)

	function stop() {
		clearInterval(timer)
		window.removeEventListener('focus', onVisible)
		document.removeEventListener('visibilitychange', onVisible)
	}

	return () => {
		stopped = true
		stop()
	}
}
