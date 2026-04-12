export interface CollectionField {
	name: string
	type: 'text' | 'number' | 'boolean' | 'date' | 'enum' | 'relation' | 'object' | 'array'
	required?: boolean
	localized?: boolean
	options?: string[]
	defaultValue?: unknown
}

export interface CollectionTemplate {
	label: string
	name: string
	description: string
	fields: CollectionField[]
}

export const COLLECTION_TEMPLATES: CollectionTemplate[] = [
	{
		label: 'Knowledge Base',
		name: 'knowledge-base',
		description: 'Structured articles for AI agent retrieval and customer self-service',
		fields: [
			{ name: 'title', type: 'text', required: true, localized: true },
			{ name: 'category', type: 'enum', options: ['general', 'technical', 'onboarding', 'troubleshooting'] },
			{ name: 'tags', type: 'array' },
			{ name: 'summary', type: 'text', localized: true },
			{ name: 'difficulty', type: 'enum', options: ['beginner', 'intermediate', 'advanced'] },
			{ name: 'relatedArticles', type: 'relation' },
		],
	},
	{
		label: 'FAQ',
		name: 'faq',
		description: 'Question-answer pairs optimized for AI-powered support agents',
		fields: [
			{ name: 'question', type: 'text', required: true, localized: true },
			{ name: 'answer', type: 'text', required: true, localized: true },
			{ name: 'category', type: 'enum', options: ['general', 'billing', 'technical', 'account'] },
			{ name: 'order', type: 'number', defaultValue: 0 },
			{ name: 'helpful', type: 'number' },
		],
	},
	{
		label: 'Product Catalog',
		name: 'product-catalog',
		description: 'Structured product data for AI-driven recommendations and search',
		fields: [
			{ name: 'title', type: 'text', required: true, localized: true },
			{ name: 'price', type: 'number', required: true },
			{ name: 'currency', type: 'enum', options: ['USD', 'EUR', 'GBP'] },
			{ name: 'sku', type: 'text', required: true },
			{ name: 'category', type: 'enum', options: ['software', 'hardware', 'service', 'subscription'] },
			{ name: 'inStock', type: 'boolean', defaultValue: true },
			{ name: 'specs', type: 'object' },
			{ name: 'images', type: 'relation' },
		],
	},
	{
		label: 'Documentation',
		name: 'documentation',
		description: 'Technical docs with section ordering for developer-facing AI assistants',
		fields: [
			{ name: 'title', type: 'text', required: true, localized: true },
			{ name: 'section', type: 'text', required: true },
			{ name: 'order', type: 'number', defaultValue: 0 },
			{ name: 'tags', type: 'array' },
			{ name: 'codeExamples', type: 'array' },
			{ name: 'deprecated', type: 'boolean' },
			{ name: 'relatedDocs', type: 'relation' },
		],
	},
	{
		label: 'Changelog',
		name: 'changelog',
		description: 'Version history and release notes for product updates',
		fields: [
			{ name: 'title', type: 'text', required: true },
			{ name: 'version', type: 'text', required: true },
			{ name: 'date', type: 'date', required: true },
			{ name: 'type', type: 'enum', required: true, options: ['feature', 'fix', 'improvement', 'breaking'] },
			{ name: 'breaking', type: 'boolean' },
		],
	},
	{
		label: 'API Reference',
		name: 'api-reference',
		description: 'Endpoint documentation for API-aware AI agents and developer tools',
		fields: [
			{ name: 'title', type: 'text', required: true },
			{ name: 'method', type: 'enum', required: true, options: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'] },
			{ name: 'endpoint', type: 'text', required: true },
			{ name: 'parameters', type: 'object' },
			{ name: 'responseSchema', type: 'object' },
			{ name: 'authenticated', type: 'boolean' },
			{ name: 'rateLimit', type: 'number' },
			{ name: 'deprecated', type: 'boolean' },
		],
	},
	{
		label: 'CRM',
		name: 'crm',
		description: 'Customer contacts and deals for AI-assisted sales workflows',
		fields: [
			{ name: 'name', type: 'text', required: true },
			{ name: 'email', type: 'text', required: true },
			{ name: 'company', type: 'text' },
			{ name: 'stage', type: 'enum', required: true, options: ['lead', 'qualified', 'proposal', 'negotiation', 'closed-won', 'closed-lost'] },
			{ name: 'dealValue', type: 'number' },
			{ name: 'lastContact', type: 'date' },
			{ name: 'notes', type: 'array' },
		],
	},
	{
		label: 'Blog',
		name: 'blog',
		description: 'Articles and posts with SEO metadata for content marketing',
		fields: [
			{ name: 'title', type: 'text', required: true, localized: true },
			{ name: 'excerpt', type: 'text', localized: true },
			{ name: 'author', type: 'text', required: true },
			{ name: 'publishDate', type: 'date' },
			{ name: 'category', type: 'enum', options: ['engineering', 'product', 'company', 'tutorial'] },
			{ name: 'tags', type: 'array' },
			{ name: 'featuredImage', type: 'relation' },
			{ name: 'seoDescription', type: 'text', localized: true },
		],
	},
	{
		label: 'Job Board',
		name: 'job-board',
		description: 'Open positions with structured requirements for recruiting agents',
		fields: [
			{ name: 'title', type: 'text', required: true },
			{ name: 'department', type: 'enum', required: true, options: ['engineering', 'design', 'product', 'marketing', 'sales', 'operations'] },
			{ name: 'location', type: 'text', required: true },
			{ name: 'remote', type: 'boolean' },
			{ name: 'salaryMin', type: 'number' },
			{ name: 'salaryMax', type: 'number' },
			{ name: 'requirements', type: 'array' },
		],
	},
	{
		label: 'SEO Article',
		name: 'seo-article',
		description: 'Content optimized for search engines with full SEO and Open Graph metadata',
		fields: [
			{ name: 'title', type: 'text', required: true, localized: true },
			{ name: 'slug', type: 'text', required: true },
			{ name: 'excerpt', type: 'text', localized: true },
			{ name: 'author', type: 'text' },
			{ name: 'publishDate', type: 'date' },
			{ name: 'metaTitle', type: 'text', localized: true },
			{ name: 'metaDescription', type: 'text', localized: true },
			{ name: 'canonicalUrl', type: 'text' },
			{ name: 'ogImage', type: 'relation' },
			{ name: 'ogTitle', type: 'text' },
			{ name: 'ogDescription', type: 'text' },
			{ name: 'keywords', type: 'array' },
			{ name: 'noIndex', type: 'boolean' },
		],
	},
	{
		label: 'Events',
		name: 'events',
		description: 'Webinars, meetups, and conferences with scheduling and registration data',
		fields: [
			{ name: 'title', type: 'text', required: true, localized: true },
			{ name: 'type', type: 'enum', required: true, options: ['webinar', 'meetup', 'conference', 'workshop', 'launch'] },
			{ name: 'startDate', type: 'date', required: true },
			{ name: 'endDate', type: 'date' },
			{ name: 'timezone', type: 'text' },
			{ name: 'location', type: 'text' },
			{ name: 'online', type: 'boolean' },
			{ name: 'registrationUrl', type: 'text' },
			{ name: 'speakers', type: 'array' },
			{ name: 'capacity', type: 'number' },
		],
	},
]
