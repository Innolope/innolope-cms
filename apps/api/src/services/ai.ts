export type AiProviderName =
	| 'anthropic'
	| 'openai'
	| 'google'
	| 'openrouter'
	| 'mistral'
	| 'deepseek'
	| 'qwen'
	| 'moonshot'
	| 'zhipu'

export const PROVIDER_NAMES: AiProviderName[] = [
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

const PROVIDER_NAME_SET = new Set<string>(PROVIDER_NAMES)

function parseModelKey(modelKey: string): { provider: AiProviderName; modelId: string } | null {
	// Colon-prefixed: "anthropic:claude-3-5-sonnet-20241022", "openrouter:meta-llama/llama-3", etc.
	const colonIdx = modelKey.indexOf(':')
	if (colonIdx > 0) {
		const maybeProvider = modelKey.slice(0, colonIdx)
		if (PROVIDER_NAME_SET.has(maybeProvider)) {
			return { provider: maybeProvider as AiProviderName, modelId: modelKey.slice(colonIdx + 1) }
		}
	}
	// Curated key from AI_MODELS (e.g. "claude-4.6-opus")
	const m = AI_MODELS[modelKey]
	if (m) return { provider: m.provider as AiProviderName, modelId: m.modelId }
	return null
}

export interface AiProviderConfig {
	id: string
	provider: AiProviderName
	apiKey: string
	enabled: boolean
}

export class AiProviderError extends Error {
	status: number
	provider: string
	constructor(provider: string, status: number, message: string) {
		super(message)
		this.name = 'AiProviderError'
		this.provider = provider
		this.status = status
	}
}

function isRetryable(err: unknown): boolean {
	if (err instanceof AiProviderError) {
		return err.status === 429 || err.status >= 500
	}
	// Network errors (fetch throws TypeError on connection failure) are retryable
	return err instanceof TypeError
}

export const AI_MODELS: Record<string, { provider: string; name: string; modelId: string }> = {
	// Anthropic — latest as of April 2026
	'claude-4.6-opus': { provider: 'anthropic', name: 'Claude Opus 4.6', modelId: 'claude-opus-4-6' },
	'claude-4.6-sonnet': {
		provider: 'anthropic',
		name: 'Claude Sonnet 4.6',
		modelId: 'claude-sonnet-4-6',
	},
	'claude-4.5-haiku': {
		provider: 'anthropic',
		name: 'Claude Haiku 4.5',
		modelId: 'claude-haiku-4-5-20251001',
	},

	// OpenAI — latest as of April 2026
	'gpt-5.4': { provider: 'openai', name: 'GPT-5.4', modelId: 'gpt-5.4-2026-03-05' },
	'gpt-5.4-pro': { provider: 'openai', name: 'GPT-5.4 Pro', modelId: 'gpt-5.4-pro-2026-03-05' },
	'gpt-5.4-mini': { provider: 'openai', name: 'GPT-5.4 Mini', modelId: 'gpt-5.4-mini-2026-03-17' },
	'gpt-5.4-nano': { provider: 'openai', name: 'GPT-5.4 Nano', modelId: 'gpt-5.4-nano-2026-03-17' },

	// Google — latest as of April 2026
	'gemini-3.1-pro': {
		provider: 'google',
		name: 'Gemini 3.1 Pro',
		modelId: 'gemini-3.1-pro-preview',
	},
	'gemini-3.1-flash-lite': {
		provider: 'google',
		name: 'Gemini 3.1 Flash Lite',
		modelId: 'gemini-3.1-flash-lite-preview',
	},
	'gemini-2.5-flash': {
		provider: 'google',
		name: 'Gemini 2.5 Flash',
		modelId: 'gemini-2.5-flash-preview-05-20',
	},

	// Mistral
	'mistral-large': {
		provider: 'mistral',
		name: 'Mistral Large',
		modelId: 'mistral-large-latest',
	},
	'mistral-medium': {
		provider: 'mistral',
		name: 'Mistral Medium',
		modelId: 'mistral-medium-latest',
	},
	'mistral-small': {
		provider: 'mistral',
		name: 'Mistral Small',
		modelId: 'mistral-small-latest',
	},
	codestral: {
		provider: 'mistral',
		name: 'Codestral',
		modelId: 'codestral-latest',
	},

	// DeepSeek
	'deepseek-chat': {
		provider: 'deepseek',
		name: 'DeepSeek V3',
		modelId: 'deepseek-chat',
	},
	'deepseek-reasoner': {
		provider: 'deepseek',
		name: 'DeepSeek R1 (Reasoner)',
		modelId: 'deepseek-reasoner',
	},

	// Alibaba Qwen
	'qwen-max': { provider: 'qwen', name: 'Qwen Max', modelId: 'qwen-max' },
	'qwen-plus': { provider: 'qwen', name: 'Qwen Plus', modelId: 'qwen-plus' },
	'qwen-turbo': { provider: 'qwen', name: 'Qwen Turbo', modelId: 'qwen-turbo' },

	// Moonshot Kimi
	'kimi-k2': { provider: 'moonshot', name: 'Kimi K2', modelId: 'kimi-k2-0905-preview' },
	'moonshot-v1-128k': {
		provider: 'moonshot',
		name: 'Moonshot v1 128k',
		modelId: 'moonshot-v1-128k',
	},

	// Zhipu GLM
	'glm-4.6': { provider: 'zhipu', name: 'GLM-4.6', modelId: 'glm-4.6' },
	'glm-4-plus': { provider: 'zhipu', name: 'GLM-4 Plus', modelId: 'glm-4-plus' },
	'glm-4-air': { provider: 'zhipu', name: 'GLM-4 Air', modelId: 'glm-4-air' },
}

export interface AiCompletionRequest {
	model: string
	prompt: string
	systemPrompt?: string
	maxTokens?: number
}

export interface AiCompletionResponse {
	text: string
	model: string
	provider: string
	tokensUsed?: number
}

function callByProvider(
	provider: AiProviderName,
	apiKey: string,
	modelId: string,
	request: AiCompletionRequest,
): Promise<AiCompletionResponse> {
	switch (provider) {
		case 'anthropic':
			return callAnthropic(apiKey, modelId, request)
		case 'openai':
			return callOpenAI(apiKey, modelId, request)
		case 'google':
			return callGoogle(apiKey, modelId, request)
		case 'openrouter':
			return callOpenRouter(apiKey, modelId, request)
		case 'mistral':
			return callMistral(apiKey, modelId, request)
		case 'deepseek':
			return callDeepseek(apiKey, modelId, request)
		case 'qwen':
			return callQwen(apiKey, modelId, request)
		case 'moonshot':
			return callMoonshot(apiKey, modelId, request)
		case 'zhipu':
			return callZhipu(apiKey, modelId, request)
		default:
			throw new Error(`Unsupported provider: ${provider}`)
	}
}

function defaultModelIdFor(provider: AiProviderName): string | undefined {
	const entry = Object.values(AI_MODELS).find((m) => m.provider === provider)
	return entry?.modelId
}

export async function complete(
	request: AiCompletionRequest,
	providers: AiProviderConfig[],
	cloudMode = false,
	fallbackEnabled = false,
): Promise<AiCompletionResponse> {
	// Resolve the requested model. Two shapes are supported:
	//   "claude-4.6-opus"            — curated key from AI_MODELS
	//   "anthropic:claude-3-5-..."   — provider-prefixed dynamic key
	const parsed = parseModelKey(request.model)
	if (!parsed) throw new Error(`Unknown model: ${request.model}`)
	const { provider: requestedProvider, modelId: requestedModelId } = parsed

	// Cloud mode: platform-managed keys, no user-controlled fallback list.
	if (cloudMode) {
		const apiKey = getCloudApiKey(requestedProvider)
		if (!apiKey) throw new Error(`No API key configured for ${requestedProvider}.`)
		return callByProvider(requestedProvider, apiKey, requestedModelId, request)
	}

	// Self-hosted: walk the providers list in user-defined order.
	const enabled = providers.filter((p) => p.enabled && p.apiKey)

	// Primary attempts: every list entry matching the requested provider, in order,
	// each tried with the originally-requested model.
	const primary = enabled
		.filter((p) => p.provider === requestedProvider)
		.map((p) => ({ p, modelId: requestedModelId }))

	// Fallback attempts: every other enabled provider, in order, with that provider's
	// default model (since the requested model doesn't exist there).
	const fallback = fallbackEnabled
		? enabled
				.filter((p) => p.provider !== requestedProvider)
				.flatMap((p) => {
					const modelId = defaultModelIdFor(p.provider)
					return modelId ? [{ p, modelId }] : []
				})
		: []

	const attempts = [...primary, ...fallback]
	if (attempts.length === 0) {
		throw new Error(
			`No API key configured for ${requestedProvider}. Add it in Settings > AI Models.`,
		)
	}

	let lastError: unknown
	for (const { p, modelId } of attempts) {
		try {
			return await callByProvider(p.provider, p.apiKey, modelId, request)
		} catch (err) {
			lastError = err
			if (!isRetryable(err)) throw err
		}
	}
	throw lastError instanceof Error ? lastError : new Error('All providers failed')
}

function getCloudApiKey(provider: string): string | undefined {
	switch (provider) {
		case 'anthropic':
			return process.env.ANTHROPIC_API_KEY
		case 'openai':
			return process.env.OPENAI_API_KEY
		case 'google':
			return process.env.GOOGLEAI_API_KEY
		case 'openrouter':
			return process.env.OPENROUTER_API_KEY
		case 'mistral':
			return process.env.MISTRAL_API_KEY
		case 'deepseek':
			return process.env.DEEPSEEK_API_KEY
		case 'qwen':
			return process.env.QWEN_API_KEY ?? process.env.DASHSCOPE_API_KEY
		case 'moonshot':
			return process.env.MOONSHOT_API_KEY
		case 'zhipu':
			return process.env.ZHIPU_API_KEY
		default:
			return undefined
	}
}

async function callAnthropic(
	apiKey: string,
	modelId: string,
	request: AiCompletionRequest,
): Promise<AiCompletionResponse> {
	const body: Record<string, unknown> = {
		model: modelId,
		max_tokens: request.maxTokens || 4096,
		messages: [{ role: 'user', content: request.prompt }],
	}
	if (request.systemPrompt) {
		body.system = request.systemPrompt
	}

	const res = await fetch('https://api.anthropic.com/v1/messages', {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			'x-api-key': apiKey,
			'anthropic-version': '2023-06-01',
		},
		body: JSON.stringify(body),
	})

	if (!res.ok) {
		const err = await res.json().catch(() => ({}))
		throw new AiProviderError(
			'anthropic',
			res.status,
			`Anthropic API error: ${(err as { error?: { message?: string } }).error?.message || res.statusText}`,
		)
	}

	const data = (await res.json()) as {
		content: { type: string; text: string }[]
		usage: { input_tokens: number; output_tokens: number }
	}

	return {
		text: data.content[0]?.text || '',
		model: request.model,
		provider: 'anthropic',
		tokensUsed: data.usage.input_tokens + data.usage.output_tokens,
	}
}

async function callOpenAI(
	apiKey: string,
	modelId: string,
	request: AiCompletionRequest,
): Promise<AiCompletionResponse> {
	const messages: { role: string; content: string }[] = []
	if (request.systemPrompt) {
		messages.push({ role: 'system', content: request.systemPrompt })
	}
	messages.push({ role: 'user', content: request.prompt })

	const res = await fetch('https://api.openai.com/v1/chat/completions', {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			Authorization: `Bearer ${apiKey}`,
		},
		body: JSON.stringify({
			model: modelId,
			messages,
			max_tokens: request.maxTokens || 4096,
		}),
	})

	if (!res.ok) {
		const err = await res.json().catch(() => ({}))
		throw new AiProviderError(
			'openai',
			res.status,
			`OpenAI API error: ${(err as { error?: { message?: string } }).error?.message || res.statusText}`,
		)
	}

	const data = (await res.json()) as {
		choices: { message: { content: string } }[]
		usage: { total_tokens: number }
	}

	return {
		text: data.choices[0]?.message.content || '',
		model: request.model,
		provider: 'openai',
		tokensUsed: data.usage.total_tokens,
	}
}

async function callGoogle(
	apiKey: string,
	modelId: string,
	request: AiCompletionRequest,
): Promise<AiCompletionResponse> {
	const contents: { role: string; parts: { text: string }[] }[] = []
	if (request.systemPrompt) {
		contents.push({ role: 'user', parts: [{ text: request.systemPrompt }] })
		contents.push({ role: 'model', parts: [{ text: 'Understood.' }] })
	}
	contents.push({ role: 'user', parts: [{ text: request.prompt }] })

	const res = await fetch(
		`https://generativelanguage.googleapis.com/v1beta/models/${modelId}:generateContent?key=${apiKey}`,
		{
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				contents,
				generationConfig: { maxOutputTokens: request.maxTokens || 4096 },
			}),
		},
	)

	if (!res.ok) {
		const err = await res.json().catch(() => ({}))
		throw new AiProviderError(
			'google',
			res.status,
			`Google AI error: ${(err as { error?: { message?: string } }).error?.message || res.statusText}`,
		)
	}

	const data = (await res.json()) as {
		candidates: { content: { parts: { text: string }[] } }[]
		usageMetadata?: { totalTokenCount: number }
	}

	return {
		text: data.candidates[0]?.content.parts[0]?.text || '',
		model: request.model,
		provider: 'google',
		tokensUsed: data.usageMetadata?.totalTokenCount,
	}
}

async function callOpenRouter(
	apiKey: string,
	modelId: string,
	request: AiCompletionRequest,
): Promise<AiCompletionResponse> {
	const messages: { role: string; content: string }[] = []
	if (request.systemPrompt) {
		messages.push({ role: 'system', content: request.systemPrompt })
	}
	messages.push({ role: 'user', content: request.prompt })

	const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			Authorization: `Bearer ${apiKey}`,
		},
		body: JSON.stringify({ model: modelId, messages, max_tokens: request.maxTokens || 4096 }),
	})

	if (!res.ok) {
		const err = await res.json().catch(() => ({}))
		throw new AiProviderError(
			'openrouter',
			res.status,
			`OpenRouter error: ${(err as { error?: { message?: string } }).error?.message || res.statusText}`,
		)
	}

	const data = (await res.json()) as {
		choices: { message: { content: string } }[]
		usage?: { total_tokens: number }
	}

	return {
		text: data.choices[0]?.message.content || '',
		model: request.model,
		provider: 'openrouter',
		tokensUsed: data.usage?.total_tokens,
	}
}

async function callMistral(
	apiKey: string,
	modelId: string,
	request: AiCompletionRequest,
): Promise<AiCompletionResponse> {
	const messages: { role: string; content: string }[] = []
	if (request.systemPrompt) {
		messages.push({ role: 'system', content: request.systemPrompt })
	}
	messages.push({ role: 'user', content: request.prompt })

	const res = await fetch('https://api.mistral.ai/v1/chat/completions', {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			Authorization: `Bearer ${apiKey}`,
		},
		body: JSON.stringify({ model: modelId, messages, max_tokens: request.maxTokens || 4096 }),
	})

	if (!res.ok) {
		const err = await res.json().catch(() => ({}))
		throw new AiProviderError(
			'mistral',
			res.status,
			`Mistral API error: ${(err as { error?: { message?: string }; message?: string }).error?.message || (err as { message?: string }).message || res.statusText}`,
		)
	}

	const data = (await res.json()) as {
		choices: { message: { content: string } }[]
		usage?: { total_tokens: number }
	}

	return {
		text: data.choices[0]?.message.content || '',
		model: request.model,
		provider: 'mistral',
		tokensUsed: data.usage?.total_tokens,
	}
}

async function callDeepseek(
	apiKey: string,
	modelId: string,
	request: AiCompletionRequest,
): Promise<AiCompletionResponse> {
	const messages: { role: string; content: string }[] = []
	if (request.systemPrompt) {
		messages.push({ role: 'system', content: request.systemPrompt })
	}
	messages.push({ role: 'user', content: request.prompt })

	const res = await fetch('https://api.deepseek.com/v1/chat/completions', {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			Authorization: `Bearer ${apiKey}`,
		},
		body: JSON.stringify({ model: modelId, messages, max_tokens: request.maxTokens || 4096 }),
	})

	if (!res.ok) {
		const err = await res.json().catch(() => ({}))
		throw new AiProviderError(
			'deepseek',
			res.status,
			`DeepSeek API error: ${(err as { error?: { message?: string }; message?: string }).error?.message || (err as { message?: string }).message || res.statusText}`,
		)
	}

	const data = (await res.json()) as {
		choices: { message: { content: string } }[]
		usage?: { total_tokens: number }
	}

	return {
		text: data.choices[0]?.message.content || '',
		model: request.model,
		provider: 'deepseek',
		tokensUsed: data.usage?.total_tokens,
	}
}

async function callOpenAICompat(
	url: string,
	apiKey: string,
	modelId: string,
	request: AiCompletionRequest,
	providerLabel: string,
	provider: 'qwen' | 'moonshot' | 'zhipu',
): Promise<AiCompletionResponse> {
	const messages: { role: string; content: string }[] = []
	if (request.systemPrompt) {
		messages.push({ role: 'system', content: request.systemPrompt })
	}
	messages.push({ role: 'user', content: request.prompt })

	const res = await fetch(url, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			Authorization: `Bearer ${apiKey}`,
		},
		body: JSON.stringify({ model: modelId, messages, max_tokens: request.maxTokens || 4096 }),
	})

	if (!res.ok) {
		const err = await res.json().catch(() => ({}))
		throw new AiProviderError(
			provider,
			res.status,
			`${providerLabel} API error: ${(err as { error?: { message?: string }; message?: string }).error?.message || (err as { message?: string }).message || res.statusText}`,
		)
	}

	const data = (await res.json()) as {
		choices: { message: { content: string } }[]
		usage?: { total_tokens: number }
	}

	return {
		text: data.choices[0]?.message.content || '',
		model: request.model,
		provider,
		tokensUsed: data.usage?.total_tokens,
	}
}

function callQwen(apiKey: string, modelId: string, request: AiCompletionRequest) {
	return callOpenAICompat(
		'https://dashscope-intl.aliyuncs.com/compatible-mode/v1/chat/completions',
		apiKey,
		modelId,
		request,
		'Qwen',
		'qwen',
	)
}

function callMoonshot(apiKey: string, modelId: string, request: AiCompletionRequest) {
	return callOpenAICompat(
		'https://api.moonshot.ai/v1/chat/completions',
		apiKey,
		modelId,
		request,
		'Moonshot',
		'moonshot',
	)
}

function callZhipu(apiKey: string, modelId: string, request: AiCompletionRequest) {
	return callOpenAICompat(
		'https://open.bigmodel.cn/api/paas/v4/chat/completions',
		apiKey,
		modelId,
		request,
		'Zhipu',
		'zhipu',
	)
}

// ---------------------------------------------------------------------------
// Dynamic model fetching
// ---------------------------------------------------------------------------

export interface DynamicModel {
	key: string
	provider: AiProviderName
	name: string
	modelId: string
	source: 'dynamic'
}

const dynamicModelsCache = new Map<string, { models: DynamicModel[]; fetchedAt: number }>()
const DYNAMIC_CACHE_TTL_MS = 60 * 60 * 1000

async function fetchAnthropicModels(apiKey: string): Promise<DynamicModel[]> {
	const res = await fetch('https://api.anthropic.com/v1/models?limit=100', {
		headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
	})
	if (!res.ok) return []
	const data = (await res.json()) as {
		data?: { id: string; display_name?: string }[]
	}
	return (data.data || []).map((m) => ({
		key: `anthropic:${m.id}`,
		provider: 'anthropic',
		name: m.display_name || m.id,
		modelId: m.id,
		source: 'dynamic',
	}))
}

// OpenAI's /v1/models returns embeddings, whisper, dall-e, moderation, tts, etc.
// Keep only chat-capable model families.
const OPENAI_CHAT_PREFIX = /^(gpt-|o1|o3|o4|chatgpt-)/
const OPENAI_NONCHAT = /(realtime|audio|transcribe|tts|embedding|dall-e|whisper|image|moderation|instruct|search)/i

async function fetchOpenAIModels(apiKey: string): Promise<DynamicModel[]> {
	const res = await fetch('https://api.openai.com/v1/models', {
		headers: { Authorization: `Bearer ${apiKey}` },
	})
	if (!res.ok) return []
	const data = (await res.json()) as { data?: { id: string }[] }
	return (data.data || [])
		.filter((m) => OPENAI_CHAT_PREFIX.test(m.id) && !OPENAI_NONCHAT.test(m.id))
		.map((m) => ({
			key: `openai:${m.id}`,
			provider: 'openai',
			name: m.id,
			modelId: m.id,
			source: 'dynamic',
		}))
}

async function fetchGoogleModels(apiKey: string): Promise<DynamicModel[]> {
	const res = await fetch(
		`https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}&pageSize=200`,
	)
	if (!res.ok) return []
	const data = (await res.json()) as {
		models?: {
			name: string
			displayName?: string
			supportedGenerationMethods?: string[]
		}[]
	}
	return (data.models || [])
		.filter((m) => m.supportedGenerationMethods?.includes('generateContent'))
		.map((m) => {
			const id = m.name.replace(/^models\//, '')
			return {
				key: `google:${id}`,
				provider: 'google',
				name: m.displayName || id,
				modelId: id,
				source: 'dynamic' as const,
			}
		})
}

// Generic OpenAI-compatible /v1/models fetcher. Filters out non-chat models
// (embeddings, rerankers, audio, etc.) by id substring.
const COMPAT_NONCHAT = /(embed|rerank|whisper|tts|moderation|vision-ocr|audio|speech)/i

async function fetchOpenAICompatModels(
	url: string,
	apiKey: string,
	provider: AiProviderName,
): Promise<DynamicModel[]> {
	const res = await fetch(url, { headers: { Authorization: `Bearer ${apiKey}` } })
	if (!res.ok) return []
	const data = (await res.json()) as { data?: { id: string }[] }
	return (data.data || [])
		.filter((m) => !COMPAT_NONCHAT.test(m.id))
		.map((m) => ({
			key: `${provider}:${m.id}`,
			provider,
			name: m.id,
			modelId: m.id,
			source: 'dynamic' as const,
		}))
}

// OpenRouter exposes a public /v1/models endpoint (no auth) with hundreds of
// models. Keep only paid/non-free in a reasonable price range and cap at 50.
async function fetchOpenRouterModels(): Promise<DynamicModel[]> {
	const res = await fetch('https://openrouter.ai/api/v1/models')
	if (!res.ok) return []
	const data = (await res.json()) as {
		data?: { id: string; name: string; pricing: { prompt: string; completion: string } }[]
	}
	return (data.data || [])
		.filter((m) => {
			const promptCost = parseFloat(m.pricing.prompt)
			return promptCost > 0 && promptCost < 0.1
		})
		.slice(0, 50)
		.map((m) => ({
			key: `openrouter:${m.id}`,
			provider: 'openrouter' as const,
			name: m.name,
			modelId: m.id,
			source: 'dynamic' as const,
		}))
}

async function fetchProviderModels(
	provider: AiProviderName,
	apiKey: string,
): Promise<DynamicModel[]> {
	switch (provider) {
		case 'anthropic':
			return fetchAnthropicModels(apiKey)
		case 'openai':
			return fetchOpenAIModels(apiKey)
		case 'google':
			return fetchGoogleModels(apiKey)
		case 'openrouter':
			return fetchOpenRouterModels()
		case 'mistral':
			return fetchOpenAICompatModels('https://api.mistral.ai/v1/models', apiKey, 'mistral')
		case 'deepseek':
			return fetchOpenAICompatModels('https://api.deepseek.com/v1/models', apiKey, 'deepseek')
		case 'qwen':
			return fetchOpenAICompatModels(
				'https://dashscope-intl.aliyuncs.com/compatible-mode/v1/models',
				apiKey,
				'qwen',
			)
		case 'moonshot':
			return fetchOpenAICompatModels('https://api.moonshot.ai/v1/models', apiKey, 'moonshot')
		case 'zhipu':
			return fetchOpenAICompatModels(
				'https://open.bigmodel.cn/api/paas/v4/models',
				apiKey,
				'zhipu',
			)
		default:
			return []
	}
}

async function fetchDynamicModelsCached(
	provider: AiProviderName,
	apiKey: string,
): Promise<DynamicModel[]> {
	// Cache key includes apiKey so different keys for the same provider don't
	// share results. Empty key (cloud mode without that env) returns empty.
	if (!apiKey && provider !== 'openrouter') return []
	const cacheKey = `${provider}:${apiKey}`
	const cached = dynamicModelsCache.get(cacheKey)
	if (cached && Date.now() - cached.fetchedAt < DYNAMIC_CACHE_TTL_MS) return cached.models
	let models: DynamicModel[] = []
	try {
		models = await fetchProviderModels(provider, apiKey)
	} catch {
		models = []
	}
	dynamicModelsCache.set(cacheKey, { models, fetchedAt: Date.now() })
	return models
}

export async function fetchAllDynamicModels(
	providers: AiProviderConfig[],
	cloudMode: boolean,
): Promise<DynamicModel[]> {
	const entries: { provider: AiProviderName; apiKey: string }[] = cloudMode
		? PROVIDER_NAMES.flatMap((p) => {
				const k = getCloudApiKey(p)
				// OpenRouter's /models is public — fetch even without a key.
				if (k || p === 'openrouter') return [{ provider: p, apiKey: k || '' }]
				return []
			})
		: providers
				.filter((p) => p.enabled && (p.apiKey || p.provider === 'openrouter'))
				.map((p) => ({ provider: p.provider, apiKey: p.apiKey }))

	const results = await Promise.all(
		entries.map(({ provider, apiKey }) =>
			fetchDynamicModelsCached(provider, apiKey).catch(() => []),
		),
	)
	return results.flat()
}
