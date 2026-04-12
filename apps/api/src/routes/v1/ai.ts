import { aiSettings } from '@innolope/db'
import type { FastifyInstance } from 'fastify'
import { eq } from 'drizzle-orm'
import { complete, AI_MODELS, type AiProviderConfig } from '../../services/ai.js'

export async function aiRoutes(app: FastifyInstance) {
	const CLOUD_MODE = !!process.env.CLOUD_MODE

	// Get AI settings for current project
	app.get('/settings', { preHandler: [app.requireProject('viewer')] }, async (request) => {
		const [settings] = await app.db
			.select()
			.from(aiSettings)
			.where(eq(aiSettings.projectId, request.project!.id))
			.limit(1)

		// List available models based on connected providers
		const providers = (settings?.providers || []) as AiProviderConfig[]
		const connectedProviders = CLOUD_MODE
			? ['anthropic', 'openai', 'google', 'openrouter']
			: providers.filter((p) => p.enabled && p.apiKey).map((p) => p.provider)

		const availableModels = Object.entries(AI_MODELS)
			.filter(([_, m]) => connectedProviders.includes(m.provider))
			.map(([key, m]) => ({ key, provider: m.provider, name: m.name, modelId: m.modelId }))

		return {
			defaultModel: settings?.defaultModel || 'gemini-3.1-flash-lite',
			providers: CLOUD_MODE
				? [
						{ provider: 'anthropic', enabled: true, connected: true },
						{ provider: 'openai', enabled: true, connected: true },
						{ provider: 'google', enabled: true, connected: true },
						{ provider: 'openrouter', enabled: true, connected: true },
					]
				: providers.map((p) => ({
						provider: p.provider,
						enabled: p.enabled,
						connected: !!p.apiKey,
					})),
			availableModels,
			cloudMode: CLOUD_MODE,
		}
	})

	// Update AI settings (admin+, project-scoped)
	app.put('/settings', { preHandler: [app.requireProject('admin')] }, async (request) => {
		const { defaultModel, providers } = request.body as {
			defaultModel?: string
			providers?: AiProviderConfig[]
		}

		const existing = await app.db
			.select()
			.from(aiSettings)
			.where(eq(aiSettings.projectId, request.project!.id))
			.limit(1)

		const updates: Record<string, unknown> = { updatedAt: new Date() }
		if (defaultModel) updates.defaultModel = defaultModel
		if (providers) updates.providers = providers

		if (existing.length > 0) {
			const [updated] = await app.db
				.update(aiSettings)
				.set(updates)
				.where(eq(aiSettings.projectId, request.project!.id))
				.returning()
			return updated
		}

		const [created] = await app.db
			.insert(aiSettings)
			.values({
				projectId: request.project!.id,
				defaultModel: defaultModel || 'gemini-3.1-flash-lite',
				providers: providers || [],
			})
			.returning()
		return created
	})

	// AI completion (editor+, project-scoped)
	app.post('/complete', { preHandler: [app.requireProject('editor'), app.requireLicense('ai-assistant')] }, async (request, reply) => {
		const { prompt, field, selectedText, action, model: requestedModel } = request.body as {
			prompt?: string
			field: string
			selectedText?: string
			action?: 'rewrite' | 'shorter' | 'longer' | 'fix-grammar' | 'translate' | 'seo' | 'custom'
			model?: string
		}

		// Get project AI settings
		const [settings] = await app.db
			.select()
			.from(aiSettings)
			.where(eq(aiSettings.projectId, request.project!.id))
			.limit(1)

		const modelKey = requestedModel || settings?.defaultModel || 'gemini-3.1-flash-lite'
		const providers = (settings?.providers || []) as AiProviderConfig[]

		// Build prompt based on action
		const systemPrompt = `You are an AI writing assistant for a CMS. You help edit and improve content. Respond with ONLY the improved text — no explanations, no markdown code fences, no meta-commentary. Match the formatting style of the input.`

		let userPrompt: string
		if (prompt) {
			userPrompt = prompt
			if (selectedText) {
				userPrompt += `\n\nText to work with:\n${selectedText}`
			}
		} else {
			const text = selectedText || ''
			switch (action) {
				case 'rewrite':
					userPrompt = `Rewrite the following text to be clearer and more engaging. Keep the same meaning and tone.\n\n${text}`
					break
				case 'shorter':
					userPrompt = `Make the following text more concise. Remove unnecessary words while keeping all key information.\n\n${text}`
					break
				case 'longer':
					userPrompt = `Expand the following text with more detail and depth. Keep the same style.\n\n${text}`
					break
				case 'fix-grammar':
					userPrompt = `Fix any grammar, spelling, or punctuation errors in the following text. Make minimal changes.\n\n${text}`
					break
				case 'translate':
					userPrompt = `Translate the following text to English. If already in English, translate to the most likely target language based on context.\n\n${text}`
					break
				case 'seo':
					userPrompt = `Optimize the following text for SEO. Improve readability, add relevant keywords naturally, and make it more engaging for search.\n\n${text}`
					break
				default:
					userPrompt = text
			}

			if (field) {
				userPrompt = `[Editing the "${field}" field]\n\n${userPrompt}`
			}
		}

		try {
			const result = await complete(
				{ model: modelKey, prompt: userPrompt, systemPrompt, maxTokens: 4096 },
				providers,
				CLOUD_MODE,
			)
			return {
				text: result.text,
				field,
				model: result.model,
				provider: result.provider,
				tokensUsed: result.tokensUsed,
			}
		} catch (err) {
			return reply.status(502).send({
				error: err instanceof Error ? err.message : 'AI completion failed',
			})
		}
	})

	// Generate collection schema from description (admin+, project-scoped)
	app.post('/generate-schema', { preHandler: [app.requireProject('admin'), app.requireLicense('ai-assistant')] }, async (request, reply) => {
		const { description } = request.body as { description: string }
		if (!description?.trim()) return reply.status(400).send({ error: 'Description is required' })

		const [settings] = await app.db
			.select()
			.from(aiSettings)
			.where(eq(aiSettings.projectId, request.project!.id))
			.limit(1)

		const modelKey = settings?.defaultModel || 'gemini-3.1-flash-lite'
		const providers = (settings?.providers || []) as AiProviderConfig[]

		const systemPrompt = `You are a CMS schema generator. Given a description of a content collection, output a JSON array of field definitions.

Each field object must have:
- "name": camelCase string (e.g. "publishDate", "metaTitle")
- "type": one of "text", "number", "boolean", "date", "enum", "relation", "object", "array"
- "required": boolean
- "localized": boolean (true for user-facing text that may need translation)
- "options": string array (ONLY for "enum" type)

Rules:
- Use "enum" when there's a known set of options, and include the "options" array
- Use "date" for timestamps and dates
- Use "array" for lists of values
- Use "relation" for references to media/other collections
- Use "object" for nested structured data
- Keep field count reasonable (5-15 fields typically)
- Output ONLY the JSON array, no explanation or markdown fences`

		try {
			const result = await complete(
				{ model: modelKey, prompt: description, systemPrompt, maxTokens: 2048 },
				providers,
				CLOUD_MODE,
			)

			// Extract JSON from response (handle potential markdown fences)
			let jsonStr = result.text.trim()
			const fenceMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/)
			if (fenceMatch) jsonStr = fenceMatch[1].trim()

			const fields = JSON.parse(jsonStr)
			if (!Array.isArray(fields)) throw new Error('Expected array')

			const validTypes = new Set(['text', 'number', 'boolean', 'date', 'enum', 'relation', 'object', 'array'])
			const cleaned = fields
				.filter((f: Record<string, unknown>) => typeof f.name === 'string' && f.name.trim())
				.map((f: Record<string, unknown>) => ({
					name: String(f.name).trim(),
					type: validTypes.has(String(f.type)) ? String(f.type) : 'text',
					required: !!f.required,
					localized: !!f.localized,
					...(f.type === 'enum' && Array.isArray(f.options) ? { options: f.options.map(String) } : {}),
				}))

			return { fields: cleaned }
		} catch (err) {
			return reply.status(502).send({
				error: err instanceof Error ? err.message : 'Failed to generate schema',
			})
		}
	})

	// List available models (built-in + OpenRouter dynamic)
	app.get('/models', { preHandler: [app.requireProject('viewer')] }, async (request) => {
		const builtIn = Object.entries(AI_MODELS).map(([key, m]) => ({
			key,
			provider: m.provider,
			name: m.name,
			modelId: m.modelId,
			source: 'built-in',
		}))

		// Fetch OpenRouter models dynamically
		let openRouterModels: typeof builtIn = []
		const [settings] = await app.db
			.select()
			.from(aiSettings)
			.where(eq(aiSettings.projectId, request.project!.id))
			.limit(1)

		const providers = (settings?.providers || []) as AiProviderConfig[]
		const hasOpenRouter = CLOUD_MODE || providers.some((p) => p.provider === 'openrouter' && p.enabled && p.apiKey)

		if (hasOpenRouter) {
			try {
				openRouterModels = await fetchOpenRouterModels()
			} catch {
				// Silently fail — built-in models still available
			}
		}

		return [...builtIn, ...openRouterModels]
	})
}

// Cache OpenRouter models for 1 hour
let openRouterCache: { models: { key: string; provider: string; name: string; modelId: string; source: string }[]; fetchedAt: number } | null = null

async function fetchOpenRouterModels() {
	if (openRouterCache && Date.now() - openRouterCache.fetchedAt < 3600_000) {
		return openRouterCache.models
	}

	const res = await fetch('https://openrouter.ai/api/v1/models')
	if (!res.ok) return []

	const data = (await res.json()) as {
		data: { id: string; name: string; pricing: { prompt: string; completion: string } }[]
	}

	const models = data.data
		.filter((m) => {
			// Filter to popular/useful models, skip free and deprecated
			const promptCost = parseFloat(m.pricing.prompt)
			return promptCost > 0 && promptCost < 0.1
		})
		.slice(0, 50) // Cap at 50 most relevant
		.map((m) => ({
			key: `openrouter:${m.id}`,
			provider: 'openrouter',
			name: m.name,
			modelId: m.id,
			source: 'openrouter' as const,
		}))

	openRouterCache = { models, fetchedAt: Date.now() }
	return models
}
