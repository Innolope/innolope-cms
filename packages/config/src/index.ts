export type { InnolopeConfig } from './cms-config.js'
export { defaultConfig } from './cms-config.js'
export type { CollectionField, CollectionFieldUi, CollectionTemplate } from './templates.js'
export { COLLECTION_TEMPLATES, hasFieldCustomizations } from './templates.js'
export type { ContentSource, ContentStatus, ExternalStatusSupport } from './validation.js'
export {
	CLIENT_HEADER,
	CONTENT_SOURCES,
	CONTENT_STATUSES,
	CREATABLE_CONTENT_STATUSES,
	contentInputSchema,
	contentListSchema,
	envSchema,
	externalStatusSupport,
	isSchemalessExternalDb,
	SCHEMALESS_EXTERNAL_DB_TYPES,
	validateSchedule,
} from './validation.js'
