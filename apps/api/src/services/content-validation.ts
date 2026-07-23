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
