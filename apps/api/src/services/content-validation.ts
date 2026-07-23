import type { CollectionField } from '@innolope/config'

export interface FieldValidationError {
	field: string
	message: string
}

/**
 * Validate a content item's metadata against a collection's field schema.
 *
 * Forgiving by design so it never rejects writes that work today:
 *  - unknown/extra metadata keys are ignored (only declared fields are checked),
 *  - required fields are enforced ONLY when the item is being published
 *    (`enforceRequired`) — drafts may be incomplete,
 *  - type checks are lenient (numeric strings count as numbers, any parseable
 *    value counts as a date) and skip ambiguous types (text/relation).
 *
 * Returns a list of problems (empty = valid) so the caller can surface
 * field-level errors alongside the collection schema.
 */
export function validateContentMetadata(
	fields: CollectionField[],
	metadata: Record<string, unknown> | undefined,
	opts: { enforceRequired: boolean },
): FieldValidationError[] {
	const errors: FieldValidationError[] = []
	const data = metadata ?? {}
	for (const field of fields) {
		const value = data[field.name]
		const isEmpty = value === undefined || value === null || value === ''
		if (isEmpty) {
			if (field.required && opts.enforceRequired) {
				errors.push({ field: field.name, message: `"${field.name}" is required to publish.` })
			}
			continue
		}
		const typeError = checkFieldType(field, value)
		if (typeError) errors.push({ field: field.name, message: typeError })
	}
	return errors
}

function checkFieldType(field: CollectionField, value: unknown): string | null {
	switch (field.type) {
		case 'number':
			if (typeof value === 'number' && !Number.isNaN(value)) return null
			if (typeof value === 'string' && value.trim() !== '' && !Number.isNaN(Number(value))) {
				return null
			}
			return `"${field.name}" must be a number.`
		case 'boolean':
			if (typeof value === 'boolean' || value === 'true' || value === 'false') return null
			return `"${field.name}" must be true or false.`
		case 'date': {
			if (value instanceof Date) return null
			if (typeof value === 'string' || typeof value === 'number') {
				if (!Number.isNaN(new Date(value).getTime())) return null
			}
			return `"${field.name}" must be a valid date.`
		}
		case 'enum':
			if (field.options && field.options.length > 0) {
				if (typeof value === 'string' && field.options.includes(value)) return null
				return `"${field.name}" must be one of: ${field.options.join(', ')}.`
			}
			return null
		case 'array':
			return Array.isArray(value) ? null : `"${field.name}" must be an array.`
		case 'object':
			return typeof value === 'object' && !Array.isArray(value)
				? null
				: `"${field.name}" must be an object.`
		default:
			// text / relation and anything else — accept as-is to stay forgiving.
			return null
	}
}

/** Locales whose primary script is Cyrillic — the distinction we can make cheaply. */
const CYRILLIC_LOCALES = new Set(['uk', 'ru', 'be', 'bg', 'sr', 'mk', 'kk'])

const baseLang = (locale: string) => locale.toLowerCase().split(/[-_]/)[0] ?? locale

const scriptOf = (locale: string): 'cyrillic' | 'latin' =>
	CYRILLIC_LOCALES.has(baseLang(locale)) ? 'cyrillic' : 'latin'

/**
 * Cheap language sanity check for writes: agents routinely leave `locale` at
 * its default and file e.g. Ukrainian text under "en". When the text's dominant
 * script clearly contradicts the declared locale AND the project has a
 * configured locale that matches the text, return a human-readable warning
 * naming the better locale. Never blocks the write — mixed-language content is
 * legitimate — and stays silent unless there is a concrete locale to suggest.
 */
export function detectLocaleScriptMismatch(
	text: string,
	locale: string,
	projectLocales: string[],
): string | null {
	const cyrillic = (text.match(/[Ѐ-ӿ]/g) ?? []).length
	const latin = (text.match(/[a-zA-Z]/g) ?? []).length
	const total = cyrillic + latin
	if (total < 40) return null // too little text to judge

	const dominant: 'cyrillic' | 'latin' | null =
		cyrillic / total > 0.7 ? 'cyrillic' : latin / total > 0.7 ? 'latin' : null
	if (!dominant || dominant === scriptOf(locale)) return null

	const suggestion = projectLocales.find(
		(candidate) => scriptOf(candidate) === dominant && baseLang(candidate) !== baseLang(locale),
	)
	if (!suggestion) return null

	const scriptLabel =
		dominant === 'cyrillic' ? 'a Cyrillic-script language' : 'a Latin-script language'
	return `Language check: the content appears to be written in ${scriptLabel}, but it was saved under locale "${locale}". If this should be the "${suggestion}" version, recreate it (or update it) with locale: "${suggestion}".`
}

/** Shape the 400 body: the field errors plus a trimmed schema the caller can act on. */
export function contentValidationError(fields: CollectionField[], errors: FieldValidationError[]) {
	return {
		error: 'Content does not match the collection schema',
		fields: errors,
		schema: fields.map((f) => ({
			name: f.name,
			type: f.type,
			required: !!f.required,
			...(f.options ? { options: f.options } : {}),
		})),
	}
}
