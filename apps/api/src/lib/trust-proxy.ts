/** Opt in only to a bounded number of proxy hops; never trust arbitrary headers. */
export function parseTrustProxy(value: string | undefined): number | false {
	const normalized = value?.trim().toLowerCase() ?? ''
	if (['true', 'yes', 'on'].includes(normalized)) return 1
	if (!/^[1-9]\d*$/.test(normalized)) return false
	const hops = Number(normalized)
	return Number.isSafeInteger(hops) ? hops : false
}

/**
 * Fastify option for TRUST_PROXY. Fastify 5.12 types no longer accept a hop
 * count and its runtime now trusts nothing for one, so trust the nearest
 * `hops` addresses ourselves (proxy-addr's own hop-count rule).
 */
export function trustProxyOption(
	value: string | undefined,
): false | ((address: string, hop: number) => boolean) {
	const hops = parseTrustProxy(value)
	return hops === false ? false : (_address, hop) => hop < hops
}
