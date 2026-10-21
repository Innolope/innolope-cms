# External Databases: Adapting to Any Data Structure

Design document for making externally connected databases (PostgreSQL, MySQL, MongoDB and the Postgres-compatible hosts) safe to edit and sync regardless of how the source data is shaped, and for presenting complex nested data to editors who are not technical.

Status: proposal. The "Current behaviour" sections describe the code as of this writing; file references point at the places a change would land.

Contents:

- [Problem statement](#problem-statement)
- [Part 1: Data layer](#part-1-data-layer)
  - [Failure classes in the current code](#failure-classes-in-the-current-code)
  - [Design goals](#design-goals)
  - [Layer 1: Patch semantics on write](#layer-1-patch-semantics-on-write)
  - [Layer 2: Persisted source schema and a type-preserving codec](#layer-2-persisted-source-schema-and-a-type-preserving-codec)
  - [Layer 3: Preflight, structured errors and drift recovery](#layer-3-preflight-structured-errors-and-drift-recovery)
  - [Layer 4: The opaque fallback](#layer-4-the-opaque-fallback)
  - [The round-trip invariant and contract tests](#the-round-trip-invariant-and-contract-tests)
- [Part 2: Editing complex structures](#part-2-editing-complex-structures)
  - [What the editor already does](#what-the-editor-already-does)
  - [Shape presets: detected first, chosen second](#shape-presets-detected-first-chosen-second)
  - [The field designer](#the-field-designer)
  - [Progressive disclosure in the editor](#progressive-disclosure-in-the-editor)
  - [Rich-text editor state](#rich-text-editor-state)
  - [List views](#list-views)
- [Schema additions](#schema-additions)
- [Rollout plan](#rollout-plan)
- [Out of scope](#out-of-scope)

---

## Problem statement

When a user connects their own database, the CMS scans it once, projects every table into a list of `CollectionField`s with eight possible types, caches the rows as JSONB, and on every save pushes the merged record back to the source. Two things go wrong in practice:

1. **Errors during editing and sync.** The CMS keeps exactly one representation of a record (the JSONB cache plus the eight field types). Anything that representation cannot express is either rewritten in a corrupted form or rejected by the source database. The user sees a generic `502 Failed to sync to external database` with no indication of which column or why.
2. **Unusable editing of nested data.** Objects and arrays of objects render either as an auto-exploded subform, a generic repeater, or a raw JSON textarea. For editors without technical background these are hard to read and easy to break.

Both have the same cure in principle: stop pretending the CMS understands everything, make sure what it does not understand round-trips untouched, and make what it does understand genuinely friendly.

---

## Part 1: Data layer

### Failure classes in the current code

Each of these was found by reading the write and sync paths; the first two are the most common user-facing failures.

| # | Failure | Where | Effect |
|---|---------|-------|--------|
| 1 | Clearing a number or date input sends `''`. The editor emits `''` for an emptied `<input type="number">` or date picker (`apps/admin/src/components/editor/field-renderer.tsx`). Validation treats `''` as "empty, skip" and `coerceExternalFieldValue` only handles `text` and `date`. | `apps/api/src/services/external-content.ts` | Postgres and strict MySQL reject `''` for integer and timestamp columns (`22P02`). MongoDB accepts it and the field silently changes type. |
| 2 | Untouched columns are rewritten with a lossy copy. `buildExternalData` iterates the **merged** metadata, so a title edit rewrites every column from the JSONB cache. Nested ObjectIds, nested Dates, `Decimal128` and `Long` survive the cache only as strings or `{ $numberDecimal }` objects; only top-level relation and date fields are coerced back. | `apps/api/src/services/external-content.ts`, `apps/api/src/routes/v1/content.ts` update path | `items[].productId` becomes a string and the customer's `$lookup` stops matching. Nested timestamps become strings and sort wrong in BSON. |
| 3 | The SQL scan ignores constraints. It reads only `column_name` and `data_type`: no nullability, defaults, identity or generated columns, composite keys, varchar length or check constraints. | `apps/api/src/routes/v1/database.ts` scan route | Inserts fail on NOT NULL columns the schema never surfaced. A composite or missing primary key falls back to a column literally named `id`. |
| 4 | Schema drift is never detected. The scan runs only when the wizard is submitted. | `apps/api/src/routes/v1/database.ts` | A column added, dropped or retyped after import is invisible until a write hits `42703 undefined_column` and surfaces as a 502. |
| 5 | MongoDB classification is first-document-wins. The first sample's runtime type decides the field type; only the ISO-date flag can be demoted. | `apps/api/src/routes/v1/database.ts` Mongo branch, `apps/api/src/adapters/mongo-introspect.ts` | A field that is a string in one document and an object in the next gets one widget, which mangles the other shape on save. |
| 6 | Firebase is a trap. The wizard scans Firestore, but `createExternalDbAdapter` throws `Unsupported external database type` for it. | `apps/api/src/adapters/external-db.ts` | Setup succeeds, then import and every write fail. |
| 7 | MySQL insert ids. A non-autoincrement primary key (uuid, natural key) returns `insertId` 0. | `apps/api/src/adapters/external-db.ts` MySqlAdapter | The cached row links to external id `"0"`. |
| 8 | Numeric precision. `numeric`, `bigint` and `Decimal128` are carried as JavaScript numbers. | type mapper and cache | Values above 2^53 or with many decimals are rounded on round-trip. |

### Design goals

"Bulletproof" does not mean understanding every schema. It means:

- **Never corrupt what we do not understand.** A value the CMS cannot model must reach the source exactly as it was read, or not be written at all.
- **Fail early with a precise message.** A write that cannot succeed is refused before the source is touched, naming the column and the reason.
- **Recover from change.** A source schema that changed is re-learned automatically, with the admin's customisations preserved.
- **Prove it.** The guarantee is a testable invariant, not a list of handled cases.

Four layers deliver this. They are independent; each is useful on its own.

### Layer 1: Patch semantics on write

Every cached external row already stores `externalSnapshot`, the last state observed in the source (`packages/db/src/schema/content.ts`). Use it.

On update, diff the edited metadata, status, slug and body against the snapshot and build the external payload from **changed keys only**. For MongoDB that is a minimal `$set` (plus `$unset` for keys the editor explicitly removed). For SQL it is an `UPDATE` with only the changed columns in `SET`.

Effects:

- Untouched columns are never rewritten, which removes the bulk of failure class 2 without any type knowledge at all.
- Writes become smaller and conflict detection in `mergeSyncState` sees exactly the fields the user changed.
- Inserts keep the full payload; there is nothing to diff against.

Implementation notes:

- `buildExternalData` gains a `baseline` argument. Keys whose `stableValue` equals the baseline are skipped. The lifecycle timestamps (`updatedAt`) are still stamped when the collection declares them.
- The body field is compared as a locale map when localized, so a one-language edit produces a one-key patch inside the map rather than replacing the whole map.
- The bulk update path already records a `previous` image per row for rollback; it should use the same diff.
- When `externalSnapshot` is null (legacy rows), fall back to the current behaviour for that one write and record a snapshot afterwards.

### Layer 2: Persisted source schema and a type-preserving codec

Separate what the **source** is from what the **editor** shows. Today both live in `collections.fields`. Add a `sourceSchema` JSONB column on `collections` that the scan fills and the sync refreshes; `fields` stays the editor-facing projection built from it by `buildCollectionFields` and `mergeFieldCustomizations`.

For SQL targets, per column:

```
{ name, nativeType, udtName, nullable, hasDefault, isIdentity, isGenerated,
  maxLength, enumValues?, isPrimaryKey }
```

plus table-level `primaryKey: string[]`, `schema: 'public' | ...`, and a `hash` of the whole descriptor for cheap drift checks.

For MongoDB, a per-path type histogram over the sample, including nested paths:

```
{ path: 'items[].productId', types: { objectId: 20 }, nullable: true }
{ path: 'price',             types: { decimal128: 18, double: 2 }, mixed: true }
```

Each adapter then exposes two functions that use this descriptor:

- `decode(doc) -> { metadata, meta }`: converts a source document into the cache representation **and** records what was lost. For MongoDB that is a compact per-document type map for the paths whose BSON type is not representable in JSON (ObjectId, Date, Decimal128, Long, Binary). It can be stored next to `externalSnapshot` or derived from `sourceSchema` when the path is not mixed.
- `encode(patch, existingDoc?) -> source payload`: restores types by path. On update the existing document, which `updateExternalDb` already fetches for read-back, is the template: a path inherits the type the row already holds, even if the schema never saw it. On insert, `sourceSchema` is the template.

Type rules the codec enforces:

| Source type | Cache | Written back as |
|-------------|-------|-----------------|
| PG `jsonb` / `json`, MySQL `json` | object | explicitly JSON-serialised parameter |
| PG arrays (`_text`, `_int4` …) | array | native array |
| PG `numeric`, `bigint`, Mongo `Decimal128`, `Long` | string (or `{ value, type }`) | same native type, no float conversion |
| PG `uuid`, user-defined enums | string | string, validated against `enumValues` where known |
| Mongo `ObjectId` at any depth | 24-hex string | `ObjectId`, by path |
| Mongo `Date` at any depth | ISO string | `Date`, by path |
| `''` for a non-text column | treated as empty | `null`, or key omitted on insert when the column has a default |
| MySQL `tinyint(1)` | boolean | `0` / `1` |
| Mixed-type Mongo path | opaque (see Layer 4) | never written unless edited as JSON |

Primary keys: `getPrimaryKey` returns the column list; single-column keys behave as today, composite keys are encoded into `externalId` as a stable JSON array string and decoded for `WHERE`. For MySQL, read the key back by `RETURNING`-equivalent (`SELECT` on the inserted key or a `LAST_INSERT_ID()` only when the key is auto-increment).

### Layer 3: Preflight, structured errors and drift recovery

**Preflight.** Before the adapter is touched, validate the patch against `sourceSchema`:

- SQL: drop keys that are not columns (replaces `stripUnmappedSystemColumns` with a general rule); on insert, refuse when a NOT NULL column without a default is missing; check enum membership and `maxLength`; coerce `''` per the codec rules.
- MongoDB: refuse a write to a mixed-type path unless the field is in JSON edit mode; keep `_id` and `$`-prefixed keys out, as today.

Refusals are `400` responses in the existing `contentValidationError` shape so the editor can show them inline on the field.

**Structured driver errors.** Map the error codes the source actually raises to the same shape, so a failure that slipped past preflight is still actionable:

| Code | Meaning | Response |
|------|---------|----------|
| PG `23502`, MySQL `1048` | not null violation | 400, names the column |
| PG `23505`, MySQL `1062`, Mongo `11000` | duplicate key | 409, names the index |
| PG `22P02`, `22007`, MySQL `1366`, `1292` | bad input for type | 400, names the column and expected type |
| PG `42703`, MySQL `1054` | unknown column | triggers re-scan, then one retry; 400 if it persists |
| PG `23514` | check constraint | 400, names the constraint |
| connection / auth errors | 502, with the existing IP-allow-list hint |

Everything else stays a 502, but logs the sanitised driver message so support can see it.

**Drift detection.** Two triggers:

1. Reactive: an unknown-column error, or a Mongo path not present in `sourceSchema`, re-runs the scan for that one table and merges through `mergeFieldCustomizations`, which already preserves labels, widgets and required flags and reports type changes.
2. Proactive: the sync worker compares the `sourceSchema.hash` against a fresh `information_schema` query (SQL) or a 20-document sample (Mongo) on each pass. A difference is recorded on `external_sync_state` and surfaced in the collection header as "Source schema changed, review fields", the same place sync conflicts appear today.

### Layer 4: The opaque fallback

Any path the codec cannot classify, or a Mongo path with mixed types, becomes an **opaque** field:

- Detected as `{ type: 'object' | 'array', ui: { widget: 'json', readOnly: true, opaque: true } }`.
- Rendered read-only in the "Technical fields" section (Part 2), with an "Edit as JSON" affordance for admins only.
- Never included in a patch unless it was edited in JSON mode, in which case the raw value is written exactly as entered and the preflight checks nothing beyond JSON validity.

This is the floor under the whole design: the editor never changes what it does not understand, and the write path never sends it.

### The round-trip invariant and contract tests

The guarantee is one statement:

> For every document `d` read from the source, `encode(decode(d), d)` equals `d` at the BSON or SQL type level, and a save that changes nothing produces an empty patch.

Back it with a contract suite that runs the same tests against PostgreSQL, MySQL and MongoDB containers (testcontainers, gated behind an environment flag in CI). Each adapter is exercised against a zoo of schemas:

- primary keys: serial, uuid, composite, none
- SQL: `jsonb`, arrays, user-defined enums, `numeric(20,6)`, `bigint`, NOT NULL without default, generated columns, `varchar(10)`, `tinyint(1)`
- MongoDB: nested ObjectIds in arrays of objects, nested Dates, `Decimal128`, `Long`, a mixed string-or-object field, a locale map, an empty collection
- every row type: read, save with no change (expect empty patch), change one scalar (expect one-key patch), insert from the editor payload including `''` for number and date

The existing unit tests on `external-content`, `sync-state`, `localized-fields` and `collection-schema` keep covering the pure functions; the contract suite is what proves the adapters.

---

## Part 2: Editing complex structures

### What the editor already does

- `SubformField` explodes an object into one labelled control per key, inferring a widget from each value's runtime type, and seeds rows from `ui.subFields` for new records.
- `ObjectArrayField` renders arrays of objects as rows and uses detected `ui.subFields` to type sub-controls (enum becomes a dropdown).
- Locale maps collapse into one language-aware control through `LocalizedTextField`.
- `JsonField` is the fallback, opt-in through `ui.widget = 'json'`.
- The schema editor's Advanced panel can set widget, placeholder, help text, read-only and hidden per field; `mergeFieldCustomizations` carries all of that across a re-scan.
- Mongo array-of-object shapes are detected at scan time and written into `ui.subFields` (`detectMongoArrayShapes`), with a special case promoting a `platform` key to a social-platform enum.

What is missing is a vocabulary above "object" and "array": a way to say that `{ url, alt, width, height }` is an image and should look like one.

### Shape presets: detected first, chosen second

Predefined templates on their own move the problem to the admin, who must pick the right template for every nested field. The approach that works for non-technical editors is three things together: shapes the system recognises on its own, an admin step to confirm or adjust them once, and an editor that hides what it could not make friendly instead of showing JSON.

**Detection.** Extend the array-shape and locale-map detection at scan time with a preset matcher. A preset is matched by key-set signature and value types over the sampled documents, and recorded on the field as `ui.preset`. Initial catalogue, in rough order of frequency in real databases:

| Preset | Signature | Rendered as |
|--------|-----------|-------------|
| `image` | `{ url, alt?, width?, height? }`, or a single URL string pointing at a known image host | Thumbnail, alt-text input, picker from the media library |
| `link` | `{ label, url }`, `{ title, href }` | One row: label plus URL |
| `social-link` | `{ platform, url }` (existing detection) | Icon plus URL; platform enum |
| `seo` | `{ title, description, keywords?, ogImage?, canonical? }` | Collapsible card with character counters |
| `money` | `{ amount, currency }` | One input with a currency dropdown |
| `geo-point` | `{ lat, lng }` or `{ latitude, longitude }` or GeoJSON `Point` | Lat/lng inputs; map preview optional |
| `address` | `{ street, city, zip | postalCode, country, ... }` | Grouped address form |
| `date-range` | `{ start, end }` / `{ from, to }` with date values | Two date pickers with validation |
| `key-value` | array of `{ key, value }`, or a flat object of scalars with non-schema keys | Two-column table with add/remove |
| `rich-text` | `{ type, children }` trees, Editor.js `{ blocks }`, Portable Text arrays | See [Rich-text editor state](#rich-text-editor-state) |

A match needs agreement across the sample (same threshold logic as locale detection: at least two documents, or the only document in a near-empty collection). A field that matches no preset keeps the current subform or repeater.

**Presets are also templates.** The same catalogue is what an admin picks from in the field designer when detection found nothing, and what a new internal collection can use for an `object` field. Make them **project-level**: a shape mapped once on `authors.socialLinks` is offered for `team.links`, and a project can save its own (`{ icon, title, body }` feature cards, for example) as a custom preset.

### The field designer

Detection proposes; a human confirms. In the collection schema editor, an `object` or `array` field gets a "Design this field" step:

- Left: the sampled values from the cache, as they are.
- Right: the proposed preset and key mapping, with controls to rename labels, add help text, choose the **summary key** (the sub-key that titles a collapsed row), mark sub-keys hidden or read-only, reorder them, and set whether editors may add keys at all.
- Save writes everything into `ui` on the field and its `subFields`. From then on the editor is stable even when a document deviates from the sample.

Confirming a preset **locks the shape** by default: `ui.allowExtraKeys = false` hides the "+ Add field" affordance for editors, required sub-keys are validated, and empty rows are dropped on save. This is what keeps the UI simplification from producing documents the customer's site cannot read.

The AI panel that already exists in the admin fits here: given field names and samples it can propose labels, help text and the preset mapping, and the admin only approves. The output is ordinary `ui` configuration, so nothing in the editor depends on AI being available.

### Progressive disclosure in the editor

Editors without technical background need to see less, not more. Four rules:

1. **Collapsed by default.** Repeater rows and nested cards show a one-line summary built from the summary key (for example "LinkedIn · linkedin.com/in/…") and expand on click. Depth beyond two renders as a card with a breadcrumb rather than deeper indentation.
2. **A "Technical fields" section at the bottom, collapsed.** Ids, version counters, opaque fields from Layer 4, mixed-type fields and the system-column twins live there, read-only. An editor never sees JSON unless they open this section. Admins get an "Edit as JSON" toggle per field inside it.
3. **Composite controls for scalar-like objects.** Money, date range, geo point and locale maps render as one control, the way a date already does. The editor should never see `{ amount, currency }` as two unrelated inputs.
4. **Forms follow the preset, not the document.** When a preset is confirmed, the subform renders the preset's keys in the preset's order even if a document is missing some; extra keys in the document that the preset does not list go to the Technical section rather than disappearing.

### Rich-text editor state

Bodies stored as editor state (Lexical, Slate, Editor.js, Portable Text) are the hardest case: the site renders them with a specific component tree, and the CMS body editor speaks markdown.

- Detect the format by signature (`root.type === 'root'` with `children` for Lexical; `{ blocks: [{ type, data }] }` for Editor.js; arrays of `{ _type: 'block' }` for Portable Text).
- Convert to markdown for editing **only when the block set in use round-trips cleanly** (headings, paragraphs, lists, links, images, code). `apps/admin/src/lib/markdown-round-trip.ts` is the starting point; the converter is per format and runs on the API so MCP and SDK writes get the same treatment.
- When the document uses blocks the converter cannot represent (embeds, columns, custom components), render a read-only preview, lock the field, and explain why in the field's help text. A locked, readable preview is still far better than a JSON textarea.

### List views

Complex fields are unreadable in the collection table today. The same presets drive column rendering: `image` renders a thumbnail, `link` a link, `money` a formatted amount, arrays a count badge with the first summary key on hover. Opaque fields are not offered as columns.

---

## Schema additions

All additions are JSONB-internal and need no migration beyond the new `collections.sourceSchema` column.

`CollectionFieldUi` (`packages/db/src/schema/collections.ts`, `packages/config/src/templates.ts`):

```ts
interface CollectionFieldUi {
  // existing
  widget?: string
  placeholder?: string
  helpText?: string
  rows?: number
  separator?: 'enter' | 'comma' | 'both'
  readOnly?: boolean
  hidden?: boolean
  subFields?: CollectionField[]
  // new
  preset?: string            // 'image' | 'link' | 'seo' | ... | 'custom:<id>'
  summaryKey?: string        // sub-key that titles a collapsed row
  allowExtraKeys?: boolean   // default false once a preset is confirmed
  opaque?: boolean           // Layer 4: round-trips untouched, JSON edit only
  section?: 'main' | 'technical'
}
```

`collections`:

```ts
sourceSchema: jsonb().$type<SourceSchema>()   // per-table descriptor, see Layer 2
sourceSchemaHash: text()                       // cheap drift comparison
```

`projects.settings`:

```ts
fieldPresets?: Record<string, { label: string; subFields: CollectionField[]; summaryKey?: string }>
```

`content`: no change. `externalSnapshot` already carries what Layer 1 needs; the per-document BSON type map from Layer 2, if stored, is a sibling key inside it.

---

## Rollout plan

Ordered by user impact per unit of work. Each step ships on its own.

1. **Patch semantics and `''` coercion** (Layer 1, part of Layer 2's codec rules). Removes the two most common user-facing failures with no new detection.
2. **Structured error mapping and reactive re-scan on unknown column** (Layer 3). Turns the 502 into a field-level message the user can act on.
3. **Summary keys, collapsed rows and the Technical section** (Part 2). Needs no detection, fixes readability immediately, and gives Layer 4 somewhere to put opaque fields.
4. **`sourceSchema` persistence and the codec**: Postgres first (constraints, jsonb, numeric), then MongoDB nested types by path, then MySQL.
5. **Preset detection for `image`, `link`, `social-link`, `seo`, `money`** and the matching composite controls. Covers most real schemas.
6. **Opaque fallback for mixed and unknown types**, and either a real Firestore adapter or removal of Firebase from the wizard.
7. **The field designer and project-level presets**, with AI-assisted proposals.
8. **The contract suite** against the three databases, so every later adapter change is proven before it ships. In practice this should start alongside step 4 and grow with each step.
9. **Rich-text converters**, one format at a time, starting with whichever the connected projects actually use.

---

## Out of scope

- Writing through to views, or to tables without any usable key.
- Two-way sync of schema changes made in the CMS schema editor back to the source database (the CMS never alters source DDL).
- Firestore beyond read-only, unless step 6 chooses to build the adapter.
