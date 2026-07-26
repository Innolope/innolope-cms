import type { CollectionField } from '@innolope/config'
import {
	KNOWN_LOCALE_CODES,
	isLocaleKeyedObject,
	isLocaleMap,
	looksLikeLocaleCode,
} from './localized-fields.js'

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
 *    value counts as a date); text fields reject only shapes that can never
 *    render (arrays, non-locale-map objects).
 *
 * On updates, `metadata` is the MERGED post-update view (so required-to-publish
 * sees the whole record) while `updatedKeys` names the fields the write itself
 * carried — type checks apply only to those, so a stored legacy value that
 * predates a stricter check can never block an unrelated update.
 *
 * Returns a list of problems (empty = valid) so the caller can surface
 * field-level errors alongside the collection schema.
 */
export function validateContentMetadata(
	fields: CollectionField[],
	metadata: Record<string, unknown> | undefined,
	opts: { enforceRequired: boolean; updatedKeys?: Iterable<string>; locales?: string[] },
): FieldValidationError[] {
	const errors: FieldValidationError[] = []
	const data = metadata ?? {}
	const touched = opts.updatedKeys ? new Set(opts.updatedKeys) : null
	for (const field of fields) {
		const value = data[field.name]
		const isEmpty = value === undefined || value === null || value === ''
		if (isEmpty) {
			if (field.required && opts.enforceRequired) {
				errors.push({ field: field.name, message: `"${field.name}" is required to publish.` })
			}
			continue
		}
		if (touched && !touched.has(field.name)) continue
		const typeError = checkFieldType(field, value)
		if (typeError) errors.push({ field: field.name, message: typeError })
	}
	if (opts.locales && opts.locales.length > 0) {
		errors.push(...checkLocaleShapes(fields, data, touched, opts.locales))
	}
	return errors
}

/**
 * Locale-format checks, active only when the caller supplies the project's
 * configured locales (the create/update paths — publish re-validates stored
 * metadata and must not choke on legacy shapes).
 *
 * Localization is per-FIELD in this CMS: one record, each translatable field a
 * `{ locale: value }` map. Two wrong formats are rejected at write time because
 * both store fine and then publish broken pages silently:
 *  1. Record-wrapped locales — metadata: { en: { title... }, uk: {...} }. The
 *     locale keys aren't fields, so sites read nothing at all.
 *  2. Locale maps keyed by unconfigured codes — { "uk": ... } on a project
 *     configured en+ua. The translation is stored but never rendered.
 */
function checkLocaleShapes(
	fields: CollectionField[],
	data: Record<string, unknown>,
	touched: Set<string> | null,
	locales: string[],
): FieldValidationError[] {
	const errors: FieldValidationError[] = []
	const fieldNames = new Set(fields.map((f) => f.name))
	const locSet = new Set(locales)
	const exampleMap = `{ "title": { ${locales.map((l) => `"${l}": "..."`).join(', ')} } }`
	for (const [key, value] of Object.entries(data)) {
		if (touched && !touched.has(key)) continue
		if (fieldNames.has(key)) {
			if (!isLocaleKeyedObject(value, locales)) continue
			const keys = Object.keys(value)
			// Only police maps that are clearly translations: they name at least one
			// configured locale, or every value is per-language text. A structured
			// object whose keys merely resemble codes ({ id: 5, no: 3 }) matches
			// neither and stays out of scope.
			const translationShaped =
				keys.some((k) => locSet.has(k)) ||
				Object.values(value).every((v) => v == null || typeof v === 'string')
			if (!translationShaped) continue
			const bad = keys.filter((k) => !locSet.has(k))
			if (bad.length > 0) {
				errors.push({
					field: key,
					message: `"${key}" holds translations keyed ${bad
						.map((b) => `"${b}"`)
						.join(
							', ',
						)}, but this project's locales are: ${locales.join(', ')}. A translation under any other code is stored but never rendered — use the configured codes exactly.`,
				})
			}
			continue
		}
		// Unknown top-level key that is (or acts like) a locale code: the caller
		// wrapped the record per language instead of per field.
		const wrapsFields =
			!!value &&
			typeof value === 'object' &&
			!Array.isArray(value) &&
			Object.keys(value).some((k) => fieldNames.has(k))
		const knownCode = KNOWN_LOCALE_CODES.has(key.toLowerCase()) && looksLikeLocaleCode(key)
		if (locSet.has(key) || (knownCode && wrapsFields)) {
			errors.push({
				field: key,
				message: `Metadata keys must be field names, not locale codes — "${key}" looks like a record wrapped per language ({ "${key}": { ... } }). Localization is per-field: keep ONE record and give each translatable field a locale map, e.g. ${exampleMap}.`,
			})
		}
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
		case 'array': {
			if (Array.isArray(value)) return null
			// Per-language arrays — localized tags and the like: { en: [...], uk: [...] }.
			if (
				isLocaleKeyedObject(value) &&
				Object.values(value).every((v) => v == null || Array.isArray(v))
			) {
				return null
			}
			return `"${field.name}" must be an array, or a { locale: [...] } map of per-language arrays.`
		}
		case 'object':
			return typeof value === 'object' && !Array.isArray(value)
				? null
				: `"${field.name}" must be an object.`
		case 'text': {
			// Strings plus coercible scalars pass. Locale maps ({ en: "...", uk: "..." })
			// pass on ANY text field — imported collections historically hold them
			// without a `localized` flag, and the admin resolves them at runtime.
			// Everything else (arrays, structured objects) would reach a rendering
			// site as "[object Object]", so it is rejected at write time instead of
			// being discovered on the published page.
			if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
				return null
			}
			if (isLocaleMap(value)) return null
			const shape = Array.isArray(value) ? 'an array' : `a ${typeof value}`
			return `"${field.name}" is a text field and must be a plain string${
				field.localized ? ' or a { locale: text } map (e.g. { "en": "...", "uk": "..." })' : ''
			}, not ${shape}. It would be stored raw and render as "[object Object]" on the site. Structured data belongs in a field typed "object" or "array".`
		}
		default:
			// relation and anything else — accept as-is to stay forgiving.
			return null
	}
}

/**
 * Advisory (never blocking) warnings about the SHAPE of an incoming write —
 * things that are legal to store but usually mean the caller misread the
 * schema. Returned to the caller alongside the write result.
 *
 * Today: a { locale: text } map written to a text field — or per-language
 * arrays written to an array field — that is NOT marked translatable. Both are
 * accepted (imported data legitimately looks like this), but an agent doing it
 * on purpose almost always wanted the field marked translatable — say so
 * instead of letting the mismatch surface as a rendering bug later.
 */
export function collectFieldWarnings(
	fields: CollectionField[],
	incoming: Record<string, unknown> | undefined,
): string[] {
	const warnings: string[] = []
	if (!incoming) return warnings
	for (const field of fields) {
		if (field.localized || !(field.name in incoming)) continue
		const value = incoming[field.name]
		if (field.type === 'text' && isLocaleMap(value)) {
			warnings.push(
				`"${field.name}" received a { locale: text } map, but the field is not marked translatable — the map is stored as-is and sites that expect a plain string will render it wrong. Either pass a plain string, or mark the field localized in the collection schema so per-language values are handled properly.`,
			)
		}
		if (
			field.type === 'array' &&
			isLocaleKeyedObject(value) &&
			Object.values(value).every((v) => v == null || Array.isArray(v))
		) {
			warnings.push(
				`"${field.name}" received per-language arrays ({ locale: [...] }), but the field is not marked translatable — sites that expect a plain array will render it wrong. Mark the field localized in the collection schema so per-language values are handled properly.`,
			)
		}
	}
	return warnings
}

/**
 * Locales whose primary script is Cyrillic — the distinction we can make
 * cheaply. Includes "ua": not the ISO 639-1 code for Ukrainian (that's "uk"),
 * but a common informal choice in real projects (Klekit configures en+ua).
 */
const CYRILLIC_LOCALES = new Set(['uk', 'ua', 'ru', 'be', 'bg', 'sr', 'mk', 'kk'])

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
