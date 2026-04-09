export interface AiProviderConfig {
	provider: 'anthropic' | 'openai' | 'google' | 'openrouter'
	apiKey: string
	enabled: boolean
}

export const AI_MODELS: Record<string, { provider: string; name: string; modelId: string }> = {
	// Anthropic — latest as of April 2026
	'claude-4.6-opus': { provider: 'anthropic', name: 'Claude Opus 4.6', modelId: 'claude-opus-4-6' },
	'claude-4.6-sonnet': { provider: 'anthropic', name: 'Claude Sonnet 4.6', modelId: 'claude-sonnet-4-6' },
	'claude-4.5-haiku': { provider: 'anthropic', name: 'Claude Haiku 4.5', modelId: 'claude-haiku-4-5-20251001' },

	// OpenAI — latest as of April 2026
	'gpt-5.4': { provider: 'openai', name: 'GPT-5.4', modelId: 'gpt-5.4-2026-03-05' },
	'gpt-5.4-pro': { provider: 'openai', name: 'GPT-5.4 Pro', modelId: 'gpt-5.4-pro-2026-03-05' },
	'gpt-5.4-mini': { provider: 'openai', name: 'GPT-5.4 Mini', modelId: 'gpt-5.4-mini-2026-03-17' },
	'gpt-5.4-nano': { provider: 'openai', name: 'GPT-5.4 Nano', modelId: 'gpt-5.4-nano-2026-03-17' },

	// Google — latest as of April 2026
	'gemini-3.1-pro': { provider: 'google', name: 'Gemini 3.1 Pro', modelId: 'gemini-3.1-pro-preview' },
	'gemini-3.1-flash-lite': { provider: 'google', name: 'Gemini 3.1 Flash Lite', modelId: 'gemini-3.1-flash-lite-preview' },
	'gemini-2.5-flash': { provider: 'google', name: 'Gemini 2.5 Flash', modelId: 'gemini-2.5-flash-preview-05-20' },
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

export async function complete(
	request: AiCompletionRequest,
	providers: AiProviderConfig[],
	cloudMode = false,
): Promise<AiCompletionResponse> {
	// Handle OpenRouter dynamic models (key starts with "openrouter:")
	if (request.model.startsWith('openrouter:')) {
		const modelId = request.model.slice('openrouter:'.length)
		const providerConfig = providers.find((p) => p.provider === 'openrouter' && p.enabled)
		const apiKey = cloudMode ? getCloudApiKey('openrouter') : providerConfig?.apiKey
		if (!apiKey) throw new Error('No API key configured for OpenRouter.')
		return callOpenRouter(apiKey, modelId, request)
	}

	const modelConfig = AI_MODELS[request.model]
	if (!modelConfig) {
		throw new Error(`Unknown model: ${request.model}`)
	}

	const providerConfig = providers.find((p) => p.provider === modelConfig.provider && p.enabled)

	// Cloud mode: use platform keys from env
	const apiKey = cloudMode
		? getCloudApiKey(modelConfig.provider)
		: providerConfig?.apiKey

	if (!apiKey) {
		throw new Error(
			`No API key configured for ${modelConfig.provider}. Add it in Settings > AI Models.`,
		)
	}

	switch (modelConfig.provider) {
		case 'anthropic':
			return callAnthropic(apiKey, modelConfig.modelId, request)
		case 'openai':
			return callOpenAI(apiKey, modelConfig.modelId, request)
		case 'google':
			return callGoogle(apiKey, modelConfig.modelId, request)
		case 'openrouter':
			return callOpenRouter(apiKey, modelConfig.modelId, request)
		default:
			throw new Error(`Unsupported provider: ${modelConfig.provider}`)
	}
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
		throw new Error(`Anthropic API error: ${(err as { error?: { message?: string } }).error?.message || res.statusText}`)
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
		throw new Error(`OpenAI API error: ${(err as { error?: { message?: string } }).error?.message || res.statusText}`)
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
		throw new Error(`Google AI error: ${(err as { error?: { message?: string } }).error?.message || res.statusText}`)
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
		throw new Error(`OpenRouter error: ${(err as { error?: { message?: string } }).error?.message || res.statusText}`)
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
