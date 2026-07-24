/**
 * Whether this server runs as the hosted cloud product (`CLOUD_MODE=true`).
 *
 * Cloud mode changes behavior in a few load-bearing places: licensing is
 * implicit, AI keys come from server env instead of project settings, and
 * media is never stored on the server's local disk. Always test through this
 * helper — a truthy-but-not-'true' value (e.g. `CLOUD_MODE=false`) must not
 * count as cloud.
 */
export function isCloudMode(): boolean {
	return process.env.CLOUD_MODE === 'true'
}
