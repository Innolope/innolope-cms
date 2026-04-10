export interface CollectionField {
	name: string
	type: 'text' | 'number' | 'boolean' | 'date' | 'select' | 'relation' | 'json'
	required?: boolean
	localized?: boolean
	options?: string[]
	defaultValue?: unknown
}

export interface CollectionTemplate {
	name: string
	slug: string
	description: string
	fields: CollectionField[]
}

export const COLLECTION_TEMPLATES: CollectionTemplate[] = [
	{
		name: 'Knowledge Base',
		slug: 'knowledge-base',
		description: 'Structured articles for AI agent retrieval and customer self-service',
		fields: [
			{ name: 'title', type: 'text', required: true, localized: true },
			{ name: 'category', type: 'select', options: ['general', 'technical', 'onboarding', 'troubleshooting'] },
			{ name: 'tags', type: 'json' },
			{ name: 'summary', type: 'text', localized: true },
		],
	},
	{
		name: 'FAQ',
		slug: 'faq',
		description: 'Question-answer pairs optimized for AI-powered support agents',
		fields: [
			{ name: 'question', type: 'text', required: true, localized: true },
			{ name: 'answer', type: 'text', required: true, localized: true },
			{ name: 'category', type: 'select', options: ['general', 'billing', 'technical', 'account'] },
			{ name: 'order', type: 'number', defaultValue: 0 },
		],
	},
	{
		name: 'Product Catalog',
		slug: 'product-catalog',
		description: 'Structured product data for AI-driven recommendations and search',
		fields: [
			{ name: 'title', type: 'text', required: true, localized: true },
			{ name: 'price', type: 'number' },
			{ name: 'sku', type: 'text' },
			{ name: 'category', type: 'select', options: ['software', 'hardware', 'service', 'subscription'] },
			{ name: 'inStock', type: 'boolean', defaultValue: true },
			{ name: 'specs', type: 'json' },
		],
	},
	{
		name: 'Documentation',
		slug: 'documentation',
		description: 'Technical docs with section ordering for developer-facing AI assistants',
		fields: [
			{ name: 'title', type: 'text', required: true, localized: true },
			{ name: 'section', type: 'text' },
			{ name: 'order', type: 'number', defaultValue: 0 },
			{ name: 'tags', type: 'json' },
		],
	},
	{
		name: 'Changelog',
		slug: 'changelog',
		description: 'Version history and release notes for product updates',
		fields: [
			{ name: 'title', type: 'text', required: true },
			{ name: 'version', type: 'text', required: true },
			{ name: 'date', type: 'date', required: true },
			{ name: 'type', type: 'select', required: true, options: ['feature', 'fix', 'improvement', 'breaking'] },
		],
	},
	{
		name: 'API Reference',
		slug: 'api-reference',
		description: 'Endpoint documentation for API-aware AI agents and developer tools',
		fields: [
			{ name: 'title', type: 'text', required: true },
			{ name: 'method', type: 'select', required: true, options: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'] },
			{ name: 'endpoint', type: 'text', required: true },
			{ name: 'parameters', type: 'json' },
			{ name: 'responseSchema', type: 'json' },
		],
	},
]
