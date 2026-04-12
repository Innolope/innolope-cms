/** Map external column/field types to CollectionField types */
export function mapColumnType(colType: string): 'text' | 'number' | 'boolean' | 'date' | 'enum' | 'object' | 'array' {
	const t = colType.toLowerCase()

	// Number types
	if (['integer', 'bigint', 'smallint', 'numeric', 'decimal', 'real', 'float', 'double', 'int', 'tinyint', 'mediumint', 'number'].some(k => t.includes(k))) return 'number'

	// Boolean
	if (t.includes('bool') || t === 'bit') return 'boolean'

	// Date/time
	if (['timestamp', 'date', 'time', 'datetime'].some(k => t.includes(k))) return 'date'

	// JSON/object
	if (['json', 'jsonb'].some(k => t.includes(k))) return 'object'

	// Array (PostgreSQL array types start with _)
	if (t === 'array' || t.startsWith('_')) return 'array'

	// Enum
	if (t === 'enum' || t === 'set') return 'enum'

	// Everything else is text
	return 'text'
}

/** Convert a database table/collection name to a human-readable label */
export function tableNameToLabel(name: string): string {
	return name
		.replace(/[_-]/g, ' ')
		.replace(/([a-z])([A-Z])/g, '$1 $2')
		.replace(/\b\w/g, c => c.toUpperCase())
}
