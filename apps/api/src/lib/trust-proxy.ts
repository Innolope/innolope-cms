/** Opt in only to a bounded number of proxy hops; never trust arbitrary headers. */
export function parseTrustProxy(value: string | undefined): number | false {
	const normalized = value?.trim().toLowerCase() ?? ''
	if (['true', 'yes', 'on'].includes(normalized)) return 1
	if (!/^[1-9]\d*$/.test(normalized)) return false
	const hops = Number(normalized)
	return Number.isSafeInteger(hops) ? hops : false
}
