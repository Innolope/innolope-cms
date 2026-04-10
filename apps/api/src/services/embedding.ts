import type { FastifyInstance } from 'fastify'
import { content, aiSettings } from '@innolope/db'
import { eq, sql } from 'drizzle-orm'
import type { AiProviderConfig } from './ai.js'

export function chunkText(text: string, maxChunkSize = 500): string[] {
	if (!text || text.length === 0) return []

	// Split by double newlines (paragraphs) or headers
	const blocks = text.split(/\n{2,}|(?=^#{1,6}\s)/m).filter((b) => b.trim().length > 0)

	const chunks: string[] = []
	let current = ''

	for (const block of blocks) {
		if (current.length + block.length > maxChunkSize && current.length > 0) {
			chunks.push(current.trim())
			current = ''
		}
		current += (current ? '\n\n' : '') + block
	}

	if (current.trim().length > 0) {
		chunks.push(current.trim())
	}

	// If no chunks were created (e.g., short text), use the whole text
	if (chunks.length === 0 && text.trim().length > 0) {
		chunks.push(text.trim())
	}

	return chunks
}

export async function generateEmbeddings(
	texts: string[],
	apiKey: string,
	model = 'text-embedding-3-small',
): Promise<number[][]> {
	const response = await fetch('https://api.openai.com/v1/embeddings', {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			Authorization: `Bearer ${apiKey}`,
		},
		body: JSON.stringify({
			model,
			input: texts,
		}),
	})

	if (!response.ok) {
		const err = await response.text().catch(() => 'Unknown error')
		throw new Error(`OpenAI embeddings API error ${response.status}: ${err}`)
	}

	const data = await response.json() as { data: Array<{ embedding: number[] }> }
	return data.data.map((d) => d.embedding)
}

export async function embedContent(
	app: FastifyInstance,
	contentId: string,
	markdown: string,
	providers: AiProviderConfig[],
	cloudMode: boolean,
): Promise<void> {
	// Get OpenAI API key
	const openaiProvider = providers.find((p) => p.provider === 'openai' && p.enabled)
	const apiKey = cloudMode ? process.env.OPENAI_API_KEY : openaiProvider?.apiKey
	if (!apiKey) return // No OpenAI key — skip embedding silently

	const chunks = chunkText(markdown)
	if (chunks.length === 0) return

	try {
		const embeddings = await generateEmbeddings(chunks, apiKey)

		// Delete + insert in a transaction to avoid partial state
		await app.db.transaction(async (tx) => {
			await tx.execute(sql`DELETE FROM content_embeddings WHERE "contentId" = ${contentId}`)

			for (let i = 0; i < chunks.length; i++) {
				await tx.execute(sql`
					INSERT INTO content_embeddings (id, "contentId", embedding, "chunkIndex", "chunkText", model)
					VALUES (gen_random_uuid(), ${contentId}, ${`[${embeddings[i].join(',')}]`}::vector, ${i}, ${chunks[i]}, 'text-embedding-3-small')
				`)
			}
		})
	} catch (err) {
		app.log.warn(err, `Failed to embed content ${contentId}`)
	}
}

export function initAutoEmbedding(app: FastifyInstance) {
	if (!app.db) return

	const unsubscribe = app.events.subscribe(async (event) => {
		if (event.type !== 'content:created' && event.type !== 'content:updated') return

		const projectId = event.data.projectId as string
		const contentId = event.data.id as string
		if (!projectId || !contentId) return

		try {
			// Check if project has auto-embed enabled
			const projectResult = await app.db.execute(
				sql`SELECT settings FROM projects WHERE id = ${projectId}`,
			)
			const settings = (projectResult as unknown as Array<{ settings: Record<string, unknown> }>)[0]?.settings
			if (!settings?.autoEmbed) return

			// Get AI providers for this project
			const [aiConfig] = await app.db
				.select()
				.from(aiSettings)
				.where(eq(aiSettings.projectId, projectId))
				.limit(1)

			const providers = (aiConfig?.providers || []) as AiProviderConfig[]
			const cloudMode = process.env.CLOUD_MODE === 'true'

			// Fetch content markdown
			const [item] = await app.db
				.select({ markdown: content.markdown })
				.from(content)
				.where(eq(content.id, contentId))
				.limit(1)

			if (!item) return

			// Embed asynchronously
			await embedContent(app, contentId, item.markdown, providers, cloudMode)
		} catch (err) {
			app.log.warn(err, `Auto-embed failed for content ${contentId}`)
		}
	})

	app.addHook('onClose', unsubscribe)
}
