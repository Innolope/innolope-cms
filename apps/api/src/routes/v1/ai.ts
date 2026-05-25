import { aiSettings } from '@innolope/db'
import { randomUUID } from 'node:crypto'
import { eq } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { getProject } from '../../plugins/project.js'
import {
	AI_MODELS,
	type AiProviderConfig,
	complete,
	fetchAllDynamicModels,
	PROVIDER_NAMES,
} from '../../services/ai.js'
import { popularityRank } from '../../services/popular-models.js'

// Provider display order used when sorting dynamic models. Matches the order
// users see in the "+ Add provider" menu.
const PROVIDER_ORDER = new Map(PROVIDER_NAMES.map((p, i) => [p as string, i]))

function sortDynamicModels<
	T extends { provider: string; modelId: string; name: string },
>(models: T[]): T[] {
	return [...models].sort((a, b) => {
		const provDelta =
			(PROVIDER_ORDER.get(a.provider) ?? 99) - (PROVIDER_ORDER.get(b.provider) ?? 99)
		if (provDelta !== 0) return provDelta
		const popDelta = popularityRank(a.provider, a.modelId) - popularityRank(b.provider, b.modelId)
		if (popDelta !== 0) return popDelta
		return a.name.localeCompare(b.name)
	})
}

export async function aiRoutes(app: FastifyInstance) {
	const CLOUD_MODE = !!process.env.CLOUD_MODE

	// Get AI settings for current project
	app.get('/settings', { preHandler: [app.requireProject('viewer')] }, async (request) => {
		const [settings] = await app.db
			.select()
			.from(aiSettings)
			.where(eq(aiSettings.projectId, getProject(request).id))
			.limit(1)

		// List available models based on connected providers
		const providers = (settings?.providers || []) as AiProviderConfig[]
		const connectedProviders = CLOUD_MODE
			? [
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
			: providers.filter((p) => p.enabled && p.apiKey).map((p) => p.provider)

		const builtIn = Object.entries(AI_MODELS)
			.filter(([_, m]) => connectedProviders.includes(m.provider))
			.map(([key, m]) => ({
				key,
				provider: m.provider,
				name: m.name,
				modelId: m.modelId,
				source: 'built-in' as const,
			}))

		const dynamic = await fetchAllDynamicModels(providers, CLOUD_MODE)
		const seenModel = new Set(builtIn.map((m) => `${m.provider}:${m.modelId}`))
		const dynamicUnique = sortDynamicModels(
			dynamic.filter((m) => !seenModel.has(`${m.provider}:${m.modelId}`)),
		)

		const availableModels = [...builtIn, ...dynamicUnique]

		return {
			defaultModel: settings?.defaultModel || 'gemini-3.1-flash-lite',
			fallbackEnabled: settings?.fallbackEnabled ?? false,
			providers: CLOUD_MODE
				? [
						{ id: 'cloud-anthropic', provider: 'anthropic', enabled: true, connected: true },
						{ id: 'cloud-openai', provider: 'openai', enabled: true, connected: true },
						{ id: 'cloud-google', provider: 'google', enabled: true, connected: true },
						{ id: 'cloud-openrouter', provider: 'openrouter', enabled: true, connected: true },
						{ id: 'cloud-mistral', provider: 'mistral', enabled: true, connected: true },
						{ id: 'cloud-deepseek', provider: 'deepseek', enabled: true, connected: true },
						{ id: 'cloud-qwen', provider: 'qwen', enabled: true, connected: true },
						{ id: 'cloud-moonshot', provider: 'moonshot', enabled: true, connected: true },
						{ id: 'cloud-zhipu', provider: 'zhipu', enabled: true, connected: true },
					]
				: providers.map((p) => ({
						id: p.id,
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
		const { defaultModel, providers, fallbackEnabled } = request.body as {
			defaultModel?: string
			providers?: (Omit<AiProviderConfig, 'id'> & { id?: string })[]
			fallbackEnabled?: boolean
		}

		const existing = await app.db
			.select()
			.from(aiSettings)
			.where(eq(aiSettings.projectId, getProject(request).id))
			.limit(1)

		const updates: Record<string, unknown> = { updatedAt: new Date() }
		if (defaultModel) updates.defaultModel = defaultModel
		if (typeof fallbackEnabled === 'boolean') updates.fallbackEnabled = fallbackEnabled
		if (providers) {
			// The incoming array defines provider membership and priority order. An empty
			// apiKey means "keep the existing stored key for this row" — the client never
			// receives keys back, so it cannot re-send them on a reorder or model-only change.
			// Matching by `id` (not `provider`) lets users keep multiple keys for the same provider.
			const existingProviders = (existing[0]?.providers ?? []) as AiProviderConfig[]
			updates.providers = providers.map((p) => {
				const id = p.id ?? randomUUID()
				if (p.apiKey?.trim()) {
					return { id, provider: p.provider, apiKey: p.apiKey, enabled: p.enabled }
				}
				const prev = existingProviders.find((e) => e.id === p.id)
				return { id, provider: p.provider, apiKey: prev?.apiKey ?? '', enabled: p.enabled }
			})
		}

		if (existing.length > 0) {
			const [updated] = await app.db
				.update(aiSettings)
				.set(updates)
				.where(eq(aiSettings.projectId, getProject(request).id))
				.returning()
			return updated
		}

		const [created] = await app.db
			.insert(aiSettings)
			.values({
				projectId: getProject(request).id,
				defaultModel: defaultModel || 'gemini-3.1-flash-lite',
				providers: (providers || []).map((p) => ({
					id: p.id ?? randomUUID(),
					provider: p.provider,
					apiKey: p.apiKey || '',
					enabled: p.enabled,
				})),
				fallbackEnabled: fallbackEnabled ?? false,
			})
			.returning()
		return created
	})

	// AI completion (editor+, project-scoped)
	app.post(
		'/complete',
		{ preHandler: [app.requireProject('editor'), app.requireLicense('ai-assistant')] },
		async (request, reply) => {
			const {
				prompt,
				field,
				selectedText,
				action,
				targetLanguage,
				sourceLanguage,
				model: requestedModel,
			} = request.body as {
				prompt?: string
				field: string
				selectedText?: string
				action?: 'rewrite' | 'shorter' | 'longer' | 'fix-grammar' | 'translate' | 'seo' | 'custom'
				targetLanguage?: string
				sourceLanguage?: string
				model?: string
			}

			// Get project AI settings
			const [settings] = await app.db
				.select()
				.from(aiSettings)
				.where(eq(aiSettings.projectId, getProject(request).id))
				.limit(1)

			const modelKey = requestedModel || settings?.defaultModel || 'gemini-3.1-flash-lite'
			const providers = (settings?.providers || []) as AiProviderConfig[]
			const fallbackEnabled = settings?.fallbackEnabled ?? false

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
						if (targetLanguage) {
							userPrompt = `Translate the following text ${
								sourceLanguage ? `from ${sourceLanguage} ` : ''
							}to ${targetLanguage}. Preserve all Markdown formatting, structure, and inline code. Do not translate code, URLs, or proper nouns that should stay unchanged. Output only the translation.\n\n${text}`
						} else {
							userPrompt = `Translate the following text to English. If already in English, translate to the most likely target language based on context.\n\n${text}`
						}
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
					fallbackEnabled,
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
		},
	)

	// Generate collection schema from description (admin+, project-scoped)
	app.post(
		'/generate-schema',
		{ preHandler: [app.requireProject('admin'), app.requireLicense('ai-assistant')] },
		async (request, reply) => {
			const { description } = request.body as { description: string }
			if (!description?.trim()) return reply.status(400).send({ error: 'Description is required' })

			const [settings] = await app.db
				.select()
				.from(aiSettings)
				.where(eq(aiSettings.projectId, getProject(request).id))
				.limit(1)

			const modelKey = settings?.defaultModel || 'gemini-3.1-flash-lite'
			const providers = (settings?.providers || []) as AiProviderConfig[]
			const fallbackEnabled = settings?.fallbackEnabled ?? false

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
					fallbackEnabled,
				)

				// Extract JSON from response (handle potential markdown fences)
				let jsonStr = result.text.trim()
				const fenceMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/)
				if (fenceMatch) jsonStr = fenceMatch[1].trim()

				const fields = JSON.parse(jsonStr)
				if (!Array.isArray(fields)) throw new Error('Expected array')

				const validTypes = new Set([
					'text',
					'number',
					'boolean',
					'date',
					'enum',
					'relation',
					'object',
					'array',
				])
				const cleaned = fields
					.filter((f: Record<string, unknown>) => typeof f.name === 'string' && f.name.trim())
					.map((f: Record<string, unknown>) => ({
						name: String(f.name).trim(),
						type: validTypes.has(String(f.type)) ? String(f.type) : 'text',
						required: !!f.required,
						localized: !!f.localized,
						...(f.type === 'enum' && Array.isArray(f.options)
							? { options: f.options.map(String) }
							: {}),
					}))

				return { fields: cleaned }
			} catch (err) {
				return reply.status(502).send({
					error: err instanceof Error ? err.message : 'Failed to generate schema',
				})
			}
		},
	)

	// List available models (curated catalog + dynamic from each connected provider)
	app.get('/models', { preHandler: [app.requireProject('viewer')] }, async (request) => {
		const builtIn = Object.entries(AI_MODELS).map(([key, m]) => ({
			key,
			provider: m.provider,
			name: m.name,
			modelId: m.modelId,
			source: 'built-in' as const,
		}))

		const [settings] = await app.db
			.select()
			.from(aiSettings)
			.where(eq(aiSettings.projectId, getProject(request).id))
			.limit(1)
		const providers = (settings?.providers || []) as AiProviderConfig[]

		const dynamic = await fetchAllDynamicModels(providers, CLOUD_MODE)
		// Dedup: built-in wins (has curated display names) for any duplicate provider+modelId.
		const seen = new Set(builtIn.map((m) => `${m.provider}:${m.modelId}`))
		const dynamicUnique = sortDynamicModels(
			dynamic.filter((m) => !seen.has(`${m.provider}:${m.modelId}`)),
		)

		return [...builtIn, ...dynamicUnique]
	})
}
