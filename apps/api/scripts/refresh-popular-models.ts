// Refreshes the auto-generated POPULAR_MODEL_IDS block in
// src/services/popular-models.ts by hitting each provider's /v1/models endpoint,
// grouping returned models by the families defined in MODEL_FAMILIES, and picking
// the most-recent member of each family.
//
// Usage:
//   pnpm --filter @innolope/api refresh-popular-models
//
// Requires API keys in env: ANTHROPIC_API_KEY, OPENAI_API_KEY, GOOGLEAI_API_KEY (or
// GOOGLE_API_KEY), MISTRAL_API_KEY, DEEPSEEK_API_KEY, QWEN_API_KEY (or
// DASHSCOPE_API_KEY), MOONSHOT_API_KEY, ZHIPU_API_KEY. Providers without a key are
// skipped (their entry in the generated block is preserved).

import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { AiProviderName } from '../src/services/ai.js'
import { MODEL_FAMILIES, POPULAR_MODEL_IDS } from '../src/services/popular-models.js'

interface RawModel {
	id: string
	createdAt?: string // ISO timestamp, when available
}

type Fetcher = (apiKey: string) => Promise<RawModel[]>

async function fetchAnthropic(apiKey: string): Promise<RawModel[]> {
	const res = await fetch('https://api.anthropic.com/v1/models?limit=100', {
		headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
	})
	if (!res.ok) throw new Error(`anthropic ${res.status}`)
	const data = (await res.json()) as { data?: { id: string; created_at?: string }[] }
	return (data.data || []).map((m) => ({ id: m.id, createdAt: m.created_at }))
}

async function fetchOpenAIShape(apiKey: string, url: string): Promise<RawModel[]> {
	const res = await fetch(url, { headers: { Authorization: `Bearer ${apiKey}` } })
	if (!res.ok) throw new Error(`${url} ${res.status}`)
	const data = (await res.json()) as { data?: { id: string; created?: number }[] }
	return (data.data || []).map((m) => ({
		id: m.id,
		createdAt: typeof m.created === 'number' ? new Date(m.created * 1000).toISOString() : undefined,
	}))
}

async function fetchGoogle(apiKey: string): Promise<RawModel[]> {
	const res = await fetch(
		`https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}&pageSize=200`,
	)
	if (!res.ok) throw new Error(`google ${res.status}`)
	const data = (await res.json()) as {
		models?: { name: string; supportedGenerationMethods?: string[] }[]
	}
	// Google's API has no creation timestamp — we'll fall back to lexicographic sort.
	return (data.models || [])
		.filter((m) => m.supportedGenerationMethods?.includes('generateContent'))
		.map((m) => ({ id: m.name.replace(/^models\//, '') }))
}

const FETCHERS: Record<Exclude<AiProviderName, 'openrouter'>, Fetcher> = {
	anthropic: fetchAnthropic,
	openai: (k) => fetchOpenAIShape(k, 'https://api.openai.com/v1/models'),
	google: fetchGoogle,
	mistral: (k) => fetchOpenAIShape(k, 'https://api.mistral.ai/v1/models'),
	deepseek: (k) => fetchOpenAIShape(k, 'https://api.deepseek.com/v1/models'),
	qwen: (k) => fetchOpenAIShape(k, 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1/models'),
	moonshot: (k) => fetchOpenAIShape(k, 'https://api.moonshot.ai/v1/models'),
	zhipu: (k) => fetchOpenAIShape(k, 'https://open.bigmodel.cn/api/paas/v4/models'),
}

const ENV_KEYS: Record<Exclude<AiProviderName, 'openrouter'>, string[]> = {
	anthropic: ['ANTHROPIC_API_KEY'],
	openai: ['OPENAI_API_KEY'],
	google: ['GOOGLEAI_API_KEY', 'GOOGLE_API_KEY'],
	mistral: ['MISTRAL_API_KEY'],
	deepseek: ['DEEPSEEK_API_KEY'],
	qwen: ['QWEN_API_KEY', 'DASHSCOPE_API_KEY'],
	moonshot: ['MOONSHOT_API_KEY'],
	zhipu: ['ZHIPU_API_KEY'],
}

function getApiKey(provider: Exclude<AiProviderName, 'openrouter'>): string | undefined {
	for (const name of ENV_KEYS[provider]) {
		const v = process.env[name]
		if (v) return v
	}
	return undefined
}

function pickLatest(models: RawModel[]): string | undefined {
	if (models.length === 0) return undefined
	// Prefer ISO timestamps when every member has one. Otherwise fall back to
	// lexicographic descending — works for date-suffixed IDs (e.g. claude-haiku-4-5-20251001)
	// and version-suffixed IDs (gemini-3.1-pro-preview).
	const allDated = models.every((m) => m.createdAt)
	if (allDated) {
		return [...models].sort((a, b) => ((a.createdAt ?? '') < (b.createdAt ?? '') ? 1 : -1))[0].id
	}
	return [...models].sort((a, b) => (a.id < b.id ? 1 : -1))[0].id
}

async function resolveProvider(provider: Exclude<AiProviderName, 'openrouter'>): Promise<{
	picks: string[]
	source: 'fetched' | 'skipped' | 'error'
	reason?: string
}> {
	const apiKey = getApiKey(provider)
	if (!apiKey)
		return { picks: POPULAR_MODEL_IDS[provider], source: 'skipped', reason: 'no API key' }

	let models: RawModel[]
	try {
		models = await FETCHERS[provider](apiKey)
	} catch (err) {
		return {
			picks: POPULAR_MODEL_IDS[provider],
			source: 'error',
			reason: err instanceof Error ? err.message : String(err),
		}
	}

	const families = MODEL_FAMILIES.filter((f) => f.provider === provider)
	const picks: string[] = []
	for (const fam of families) {
		const matching = models.filter((m) => fam.match(m.id))
		const latest = pickLatest(matching)
		if (latest && !picks.includes(latest)) picks.push(latest)
	}
	return { picks, source: 'fetched' }
}

async function main() {
	const providers: Exclude<AiProviderName, 'openrouter'>[] = [
		'anthropic',
		'openai',
		'google',
		'mistral',
		'deepseek',
		'qwen',
		'moonshot',
		'zhipu',
	]

	const results = await Promise.all(
		providers.map(async (p) => [p, await resolveProvider(p)] as const),
	)

	const resolved: Record<AiProviderName, string[]> = {
		...POPULAR_MODEL_IDS,
		openrouter: POPULAR_MODEL_IDS.openrouter ?? [],
	}

	for (const [provider, r] of results) {
		resolved[provider] = r.picks
		const tag = r.source === 'fetched' ? 'ok' : r.source
		const detail = r.reason ? ` (${r.reason})` : ''
		console.log(
			`${provider.padEnd(10)} ${tag.padEnd(8)} ${r.picks.join(', ') || '(none)'}${detail}`,
		)
	}

	// Rewrite the auto-gen block in popular-models.ts
	const filePath = resolve(
		dirname(fileURLToPath(import.meta.url)),
		'../src/services/popular-models.ts',
	)
	const contents = readFileSync(filePath, 'utf8')

	const orderedProviders: AiProviderName[] = [
		'anthropic',
		'openai',
		'google',
		'openrouter',
		'mistral',
		'deepseek',
		'qwen',
		'moonshot',
		'zhipu',
	]
	const block =
		'// --- POPULAR_MODEL_IDS-START (auto-generated; do not edit by hand) ---\n' +
		'export const POPULAR_MODEL_IDS: Record<AiProviderName, string[]> = {\n' +
		orderedProviders.map((p) => `\t${p}: ${JSON.stringify(resolved[p] ?? [])},`).join('\n') +
		'\n}\n' +
		'// --- POPULAR_MODEL_IDS-END ---'

	const next = contents.replace(
		/\/\/ --- POPULAR_MODEL_IDS-START[\s\S]*?\/\/ --- POPULAR_MODEL_IDS-END ---/,
		block,
	)
	if (next === contents) {
		console.error('Could not find the auto-gen block — file untouched.')
		process.exitCode = 1
		return
	}
	writeFileSync(filePath, next)
	console.log(`\nWrote ${filePath}`)
}

void main().catch((err) => {
	console.error(err)
	process.exit(1)
})
