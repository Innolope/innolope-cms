// Curated "popular families" per provider. The MODEL_FAMILIES list is hand-maintained
// (these are the model lines we want surfaced first in dropdowns), and the
// POPULAR_MODEL_IDS block below is auto-resolved to the latest version of each family
// by `pnpm --filter @innolope/api refresh-popular-models`.

import type { AiProviderName } from './ai.js'

export interface ModelFamily {
	provider: AiProviderName
	family: string
	// Identifies which models belong to this family. The script picks the
	// single most-recent matching model per family.
	match: (id: string) => boolean
}

export const MODEL_FAMILIES: ModelFamily[] = [
	// Anthropic — match by name token (claude-opus-4-6 → "opus")
	{ provider: 'anthropic', family: 'opus', match: (id) => /opus/i.test(id) },
	{ provider: 'anthropic', family: 'sonnet', match: (id) => /sonnet/i.test(id) },
	{ provider: 'anthropic', family: 'haiku', match: (id) => /haiku/i.test(id) },

	// OpenAI — flagship (no mini/nano), mini, reasoning (o-series)
	{
		provider: 'openai',
		family: 'gpt-flagship',
		match: (id) => /^gpt-\d/.test(id) && !/(mini|nano|preview|audio|realtime)/i.test(id),
	},
	{ provider: 'openai', family: 'gpt-mini', match: (id) => /^gpt-\d.*mini/.test(id) },
	{ provider: 'openai', family: 'o-series', match: (id) => /^o[1-9](-|$)/.test(id) },

	// Google
	{
		provider: 'google',
		family: 'gemini-pro',
		match: (id) => /gemini.*pro/i.test(id) && !/(flash|lite|nano)/i.test(id),
	},
	{
		provider: 'google',
		family: 'gemini-flash',
		match: (id) => /gemini.*flash/i.test(id) && !/lite/i.test(id),
	},
	{
		provider: 'google',
		family: 'gemini-flash-lite',
		match: (id) => /gemini.*flash.*lite/i.test(id),
	},

	// Mistral
	{ provider: 'mistral', family: 'mistral-large', match: (id) => /mistral-large/i.test(id) },
	{ provider: 'mistral', family: 'mistral-medium', match: (id) => /mistral-medium/i.test(id) },
	{ provider: 'mistral', family: 'mistral-small', match: (id) => /mistral-small/i.test(id) },

	// DeepSeek
	{ provider: 'deepseek', family: 'chat', match: (id) => /^deepseek-chat/i.test(id) },
	{
		provider: 'deepseek',
		family: 'reasoner',
		match: (id) => /^deepseek-(reasoner|r\d)/i.test(id),
	},

	// Qwen
	{ provider: 'qwen', family: 'qwen-max', match: (id) => /qwen.*max/i.test(id) },
	{ provider: 'qwen', family: 'qwen-plus', match: (id) => /qwen.*plus/i.test(id) },
	{ provider: 'qwen', family: 'qwen-turbo', match: (id) => /qwen.*turbo/i.test(id) },

	// Moonshot (Kimi)
	{ provider: 'moonshot', family: 'kimi-k', match: (id) => /kimi-k/i.test(id) },
	{ provider: 'moonshot', family: 'moonshot-v1', match: (id) => /moonshot-v\d/i.test(id) },

	// Zhipu (GLM) — flagship vs air
	{
		provider: 'zhipu',
		family: 'glm-flagship',
		match: (id) => /^glm-\d/i.test(id) && !/(air|flash)/i.test(id),
	},
	{ provider: 'zhipu', family: 'glm-air', match: (id) => /glm.*air/i.test(id) },
]

// --- POPULAR_MODEL_IDS-START (auto-generated; do not edit by hand) ---
export const POPULAR_MODEL_IDS: Record<AiProviderName, string[]> = {
	anthropic: ['claude-opus-4-6', 'claude-sonnet-4-6', 'claude-haiku-4-5-20251001'],
	openai: ['gpt-5.4-2026-03-05', 'gpt-5.4-mini-2026-03-17'],
	google: ['gemini-3.1-pro-preview', 'gemini-3.1-flash-lite-preview'],
	openrouter: [],
	mistral: ['mistral-large-latest', 'mistral-medium-latest', 'mistral-small-latest'],
	deepseek: ['deepseek-chat', 'deepseek-reasoner'],
	qwen: ['qwen-max', 'qwen-plus', 'qwen-turbo'],
	moonshot: ['kimi-k2-0905-preview', 'moonshot-v1-128k'],
	zhipu: ['glm-4.6', 'glm-4-air'],
}
// --- POPULAR_MODEL_IDS-END ---

export function popularityRank(provider: string, modelId: string): number {
	const list = POPULAR_MODEL_IDS[provider as AiProviderName]
	if (!list) return Number.POSITIVE_INFINITY
	const i = list.indexOf(modelId)
	return i === -1 ? Number.POSITIVE_INFINITY : i
}
