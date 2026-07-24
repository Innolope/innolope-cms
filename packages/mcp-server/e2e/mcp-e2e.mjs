// End-to-end verification of the Innolope MCP server: drives the built stdio
// server (packages/mcp-server/dist/index.js) over a real MCP client against a
// disposable API instance, asserting the protocol contract (annotations, error
// funnel + schema echo, dry runs, size caps, delete confirm, project stamping,
// locale checks, slug/frontmatter normalization, feedback drop box).
//
// Setup (fresh DB + API on :3101, then run):
//   createdb innolope_mcp_e2e   # any empty Postgres
//   cd apps/api && DATABASE_URL=postgresql://localhost/innolope_mcp_e2e \
//     AUTH_SECRET=<32+ chars> API_PORT=3101 API_HOST=127.0.0.1 npx tsx src/index.ts &
//   curl -c /tmp/c.txt -X POST localhost:3101/api/v1/auth/register \
//     -H 'Content-Type: application/json' \
//     -d '{"email":"e2e@test.local","password":"E2e-Test-Passw0rd!","name":"E2E"}'
//   INNOLOPE_E2E_JWT=$(grep innolope_token /tmp/c.txt | awk '{print $NF}') \
//     node packages/mcp-server/e2e/mcp-e2e.mjs
//
// Requires `pnpm build` first (runs the compiled dist server).
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const SDK = `${REPO}/packages/mcp-server/node_modules/@modelcontextprotocol/sdk/dist/esm`
const { Client } = await import(`${SDK}/client/index.js`)
const { StdioClientTransport } = await import(`${SDK}/client/stdio.js`)

const JWT =
	process.env.INNOLOPE_E2E_JWT ?? readFileSync(`${process.env.SCRATCH_DIR}/jwt.txt`, 'utf8').trim()

let passed = 0
let failed = 0
function check(name, cond, detail = '') {
	if (cond) {
		passed++
		console.log(`PASS ${name}`)
	} else {
		failed++
		console.log(`FAIL ${name}${detail ? ` — ${detail}` : ''}`)
	}
}

function textOf(result) {
	return (result.content ?? []).map((c) => c.text ?? '').join('\n')
}

async function connect(extraEnv = {}) {
	const transport = new StdioClientTransport({
		command: 'node',
		args: [`${REPO}/packages/mcp-server/dist/index.js`],
		env: {
			...process.env,
			INNOLOPE_API_URL: 'http://127.0.0.1:3101',
			INNOLOPE_API_KEY: JWT,
			...extraEnv,
		},
	})
	const client = new Client({ name: 'e2e-test', version: '0.0.1' })
	await client.connect(transport)
	return client
}

const client = await connect()

// --- 1. tools/list: annotations derived from operationType ------------------
const { tools } = await client.listTools()
const byName = Object.fromEntries(tools.map((t) => [t.name, t]))
check('29 tools registered', tools.length === 29, `got ${tools.length}`)
check(
	'list_content has readOnlyHint=true',
	byName.list_content?.annotations?.readOnlyHint === true,
	JSON.stringify(byName.list_content?.annotations),
)
check(
	'delete_content has destructiveHint=true',
	byName.delete_content?.annotations?.destructiveHint === true,
	JSON.stringify(byName.delete_content?.annotations),
)
check(
	'create_content has readOnlyHint=false',
	byName.create_content?.annotations?.readOnlyHint === false,
	JSON.stringify(byName.create_content?.annotations),
)

// --- 2. requireProject guard is isError -------------------------------------
const noProj = await client.callTool({ name: 'create_collection', arguments: { name: 'x' } })
check(
	'create_collection without project → isError with use_project guidance',
	noProj.isError === true && textOf(noProj).includes('use_project'),
	textOf(noProj).slice(0, 120),
)

// --- 3. Set up project + collection -----------------------------------------
const proj = await client.callTool({
	name: 'create_project',
	arguments: { name: 'MCP E2E', slug: 'mcp-e2e' },
})
check('create_project succeeds', proj.isError !== true, textOf(proj).slice(0, 200))

const col = await client.callTool({
	name: 'create_collection',
	arguments: {
		name: 'articles',
		fields: [
			{ name: 'title', type: 'text', required: true },
			{ name: 'category', type: 'enum', options: ['news', 'guide'] },
			{ name: 'rating', type: 'number' },
		],
	},
})
const colId = textOf(col).match(/ID: ([0-9a-f-]{36})/)?.[1]
check('create_collection succeeds', col.isError !== true && !!colId, textOf(col).slice(0, 200))

// --- 4. get_collection_schema returns structuredContent ----------------------
const schema = await client.callTool({ name: 'get_collection_schema', arguments: { id: colId } })
check(
	'get_collection_schema has structuredContent with fields',
	Array.isArray(schema.structuredContent?.fields) && schema.structuredContent.fields.length === 3,
	JSON.stringify(schema.structuredContent)?.slice(0, 150),
)

// --- 5. Schema-violating create → isError with field errors + schema echo ----
const bad = await client.callTool({
	name: 'create_content',
	arguments: {
		collectionId: colId,
		markdown: '# Bad item',
		metadata: { title: 'Bad item', category: 'nonsense', rating: 'not-a-number' },
	},
})
const badText = textOf(bad)
check('invalid metadata → isError', bad.isError === true, badText.slice(0, 120))
check('error lists field errors', badText.includes('Field errors') && badText.includes('category'))
check('error echoes collection schema', badText.includes('Collection schema'))
check('error names get_collection_schema as next step', badText.includes('get_collection_schema'))

// --- 6. Valid create ---------------------------------------------------------
const good = await client.callTool({
	name: 'create_content',
	arguments: {
		collectionId: colId,
		markdown: `# Good item\n\n${'lorem ipsum dolor sit amet. '.repeat(300)}`,
		metadata: { title: 'Good item', category: 'news', rating: 5 },
	},
})
const goodId = textOf(good).match(/ID: ([0-9a-f-]{36})/)?.[1]
check('valid create succeeds', good.isError !== true && !!goodId, textOf(good).slice(0, 200))

// --- 7. get_content maxBytes truncation --------------------------------------
const truncated = await client.callTool({
	name: 'get_content',
	arguments: { id: goodId, maxBytes: 500 },
})
check(
	'get_content honors maxBytes with truncation notice',
	textOf(truncated).includes('[Truncated: showing') && textOf(truncated).length < 1000,
	`len=${textOf(truncated).length}`,
)
const full = await client.callTool({ name: 'get_content', arguments: { id: goodId } })
check('get_content default is not truncated for normal docs', !textOf(full).includes('[Truncated'))
check(
	'get_content structuredContent carries the markdown body',
	typeof full.structuredContent?.markdown === 'string' &&
		full.structuredContent.markdown.includes('lorem ipsum'),
	JSON.stringify(full.structuredContent?.markdown)?.slice(0, 120),
)
// The fixture's markdown opens with an H1 repeating metadata.title — create
// should have flagged the duplicate (sites render the title field separately).
check(
	'create warns about H1 duplicating metadata.title',
	textOf(good).includes('duplicates metadata.title'),
	textOf(good).slice(-200),
)

// --- 8. delete_content two-step confirm --------------------------------------
const preview = await client.callTool({ name: 'delete_content', arguments: { id: goodId } })
check(
	'delete without confirm returns preview, no delete',
	preview.isError !== true && textOf(preview).includes('confirm: true'),
	textOf(preview).slice(0, 150),
)
const stillThere = await client.callTool({ name: 'get_content', arguments: { id: goodId } })
check('item still exists after preview', stillThere.isError !== true)
const deleted = await client.callTool({
	name: 'delete_content',
	arguments: { id: goodId, confirm: true },
})
check('delete with confirm succeeds', deleted.isError !== true, textOf(deleted))
const gone = await client.callTool({ name: 'get_content', arguments: { id: goodId } })
check(
	'get_content on deleted id → isError with 404 guidance',
	gone.isError === true && textOf(gone).includes('list_content'),
	textOf(gone).slice(0, 150),
)

// --- 9. bulk_create dryRun and per-item errors -------------------------------
const dry = await client.callTool({
	name: 'bulk_create',
	arguments: {
		dryRun: true,
		items: [
			{ collectionId: colId, markdown: '# One', metadata: { title: 'One', category: 'news' } },
			{ collectionId: colId, markdown: '# Two', metadata: { title: 'Two', category: 'bogus' } },
		],
	},
})
const dryText = textOf(dry)
check(
	'bulk_create dryRun reports per-item errors without writing',
	dry.isError !== true && dryText.includes('1/2 items valid') && dryText.includes('item 1'),
	dryText.slice(0, 250),
)
const afterDry = await client.callTool({
	name: 'list_content',
	arguments: { collectionId: colId },
})
check(
	'dryRun wrote nothing',
	afterDry.structuredContent?.total === 0,
	`total=${afterDry.structuredContent?.total}`,
)

const bulkBad = await client.callTool({
	name: 'bulk_create',
	arguments: {
		items: [
			{ collectionId: colId, markdown: '# One', metadata: { title: 'One', category: 'news' } },
			{ collectionId: colId, markdown: '# Two', metadata: { title: 'Two', category: 'bogus' } },
		],
	},
})
const bulkBadText = textOf(bulkBad)
check(
	'bulk_create with bad item → isError, all-or-nothing, per-item report',
	bulkBad.isError === true &&
		bulkBadText.includes('item 1') &&
		bulkBadText.includes('nothing was created'),
	bulkBadText.slice(0, 250),
)
const afterBad = await client.callTool({ name: 'list_content', arguments: { collectionId: colId } })
check(
	'failed bulk wrote nothing',
	afterBad.structuredContent?.total === 0,
	`total=${afterBad.structuredContent?.total}`,
)

const bulkGood = await client.callTool({
	name: 'bulk_create',
	arguments: {
		items: [
			{ collectionId: colId, markdown: '# One', metadata: { title: 'One', category: 'news' } },
			{ collectionId: colId, markdown: '# Two', metadata: { title: 'Two', category: 'guide' } },
		],
	},
})
check(
	'valid bulk_create succeeds',
	bulkGood.isError !== true && textOf(bulkGood).includes('Created 2'),
)

// --- 10. list_content structuredContent --------------------------------------
const listed = await client.callTool({ name: 'list_content', arguments: { collectionId: colId } })
check(
	'list_content returns structuredContent items',
	listed.structuredContent?.total === 2 && listed.structuredContent?.items?.length === 2,
	JSON.stringify(listed.structuredContent)?.slice(0, 150),
)

// --- 11. query_by_fields invalid filter key → hard error ----------------------
const badFilter = await client.callTool({
	name: 'query_by_fields',
	arguments: { collectionId: colId, filters: { 'bad-key!': 'x' } },
})
check(
	'query_by_fields rejects invalid filter names',
	badFilter.isError === true && textOf(badFilter).includes('Invalid filter field name'),
	textOf(badFilter).slice(0, 150),
)
const goodFilter = await client.callTool({
	name: 'query_by_fields',
	arguments: { collectionId: colId, filters: { category: 'news' } },
})
check(
	'query_by_fields valid filter works',
	goodFilter.isError !== true && goodFilter.structuredContent?.total === 1,
	JSON.stringify(goodFilter.structuredContent)?.slice(0, 150),
)

// --- 12. export_collection windowing -----------------------------------------
const exp = await client.callTool({
	name: 'export_collection',
	arguments: { collectionId: colId, limit: 1 },
})
const expText = textOf(exp)
check(
	'export_collection windows with offset hint',
	exp.isError !== true && expText.includes('offset: 1') && expText.includes('Exported 1 item'),
	expText.slice(0, 150),
)

// --- 13. bulk_update dryRun ---------------------------------------------------
const ids = listed.structuredContent.items.map((i) => i.id)
const upDry = await client.callTool({
	name: 'bulk_update',
	arguments: {
		dryRun: true,
		items: [{ id: ids[0], metadata: { rating: 'NaN-ish' } }],
	},
})
check(
	'bulk_update dryRun catches merged-metadata violation',
	upDry.isError !== true && textOf(upDry).includes('0/1 items valid'),
	textOf(upDry).slice(0, 200),
)
const upGood = await client.callTool({
	name: 'bulk_update',
	arguments: { items: [{ id: ids[0], metadata: { rating: 4 } }] },
})
check('valid bulk_update succeeds', upGood.isError !== true && textOf(upGood).includes('Updated 1'))

// --- 16. Read-after-write: metadata block + structuredContent -----------------
const readBack = await client.callTool({ name: 'get_content', arguments: { id: ids[0] } })
const readBackText = textOf(readBack)
check(
	'get_content renders the metadata block for MCP-created records',
	readBackText.includes('**Metadata**') && readBackText.includes('"rating": 4'),
	readBackText.slice(0, 300),
)
check(
	'get_content structuredContent carries metadata',
	readBack.structuredContent?.metadata?.rating === 4 && readBack.structuredContent?.id === ids[0],
	JSON.stringify(readBack.structuredContent)?.slice(0, 200),
)

// --- 17. Project stamping ------------------------------------------------------
check(
	'list_content stamps the active project',
	textOf(listed).includes('(project: ') && typeof listed.structuredContent?.projectId === 'string',
	textOf(listed).slice(0, 80),
)
const useProj = await client.callTool({ name: 'use_project', arguments: { slug: 'mcp-e2e' } })
check(
	'use_project echoes project name and slug',
	textOf(useProj).includes('MCP E2E') && textOf(useProj).includes('slug: mcp-e2e'),
	textOf(useProj).slice(0, 150),
)

// --- 18. Slug handling ----------------------------------------------------------
const snake = await client.callTool({
	name: 'create_content',
	arguments: {
		collectionId: colId,
		slug: 'snake_case_slug_kept',
		markdown: '# Snake',
		metadata: { title: 'Snake', category: 'news' },
	},
})
check(
	'snake_case slug is preserved verbatim',
	snake.isError !== true &&
		textOf(snake).includes('Slug: snake_case_slug_kept') &&
		!textOf(snake).includes('normalized'),
	textOf(snake).slice(0, 200),
)
const fancy = await client.callTool({
	name: 'create_content',
	arguments: {
		collectionId: colId,
		slug: 'My Fancy Slug!',
		markdown: '# Fancy',
		metadata: { title: 'Fancy', category: 'news' },
	},
})
check(
	'invalid slug is normalized with an explicit note',
	fancy.isError !== true &&
		textOf(fancy).includes('Slug: my-fancy-slug') &&
		textOf(fancy).includes('normalized from "My Fancy Slug!"'),
	textOf(fancy).slice(0, 250),
)

// --- 20. Locale awareness ---------------------------------------------------------
// Give the test project a second locale via REST, then exercise discovery,
// validation, and the script-mismatch warning.
const projText = textOf(proj)
const projId = projText.match(/ID: ([0-9a-f-]{36})/)?.[1]
const restResp = await fetch(`http://127.0.0.1:3101/api/v1/projects/${projId}`, {
	method: 'PUT',
	headers: {
		'Content-Type': 'application/json',
		Authorization: `Bearer ${JWT}`,
		'X-Project-Id': projId,
	},
	body: JSON.stringify({ settings: { locales: ['en', 'uk'], defaultLocale: 'en' } }),
})
check('project locales configured via REST', restResp.ok, `status ${restResp.status}`)

const useProj2 = await client.callTool({ name: 'use_project', arguments: { slug: 'mcp-e2e' } })
check(
	'use_project surfaces project locales',
	textOf(useProj2).includes('Locales: en, uk (default: en)'),
	textOf(useProj2).slice(0, 200),
)

const badLocale = await client.callTool({
	name: 'create_content',
	arguments: {
		collectionId: colId,
		slug: 'locale-de-rejected',
		markdown: '# Hallo Welt',
		metadata: { title: 'Hallo', category: 'news' },
		locale: 'de',
	},
})
check(
	'unconfigured locale is rejected with the allowed list',
	badLocale.isError === true &&
		textOf(badLocale).includes('not configured') &&
		textOf(badLocale).includes('en'),
	textOf(badLocale).slice(0, 200),
)

const UK_TEXT =
	'Це стаття про приготування борщу. Борщ — традиційна українська страва, яку готують з буряка, капусти та інших овочів. Подавайте зі сметаною та пампушками.'
const ukAsEn = await client.callTool({
	name: 'create_content',
	arguments: {
		collectionId: colId,
		slug: 'borshch-default-locale',
		markdown: `# Борщ\n\n${UK_TEXT}`,
		metadata: { title: 'Борщ', category: 'news' },
	},
})
const ukAsEnText = textOf(ukAsEn)
check(
	'Cyrillic content under default locale gets a language warning suggesting "uk"',
	ukAsEn.isError !== true &&
		ukAsEnText.includes('Language check') &&
		ukAsEnText.includes('"uk"') &&
		ukAsEnText.includes('Locale: en'),
	ukAsEnText.slice(0, 300),
)

const ukProper = await client.callTool({
	name: 'create_content',
	arguments: {
		collectionId: colId,
		slug: 'borshch-uk-proper',
		markdown: `# Борщ\n\n${UK_TEXT}`,
		metadata: { title: 'Борщ', category: 'news' },
		locale: 'uk',
	},
})
check(
	'matching locale produces no warning',
	ukProper.isError !== true && !textOf(ukProper).includes('Language check'),
	textOf(ukProper).slice(0, 200),
)

// --- 21. Optional markdown + frontmatter normalization ---------------------------
const dataOnly = await client.callTool({
	name: 'create_content',
	arguments: {
		collectionId: colId,
		slug: 'data-only-record',
		metadata: { title: 'Data Only', category: 'news', rating: 2 },
	},
})
check(
	'create_content works without markdown (data-only record)',
	dataOnly.isError !== true && textOf(dataOnly).includes('Slug: data-only-record'),
	textOf(dataOnly).slice(0, 200),
)

const fmCreate = await client.callTool({
	name: 'create_content',
	arguments: {
		collectionId: colId,
		slug: 'frontmatter-normalized',
		markdown: '---\ntitle: FM Title\nrating: 3\n---\n\n# Body heading\n\nProse.',
		metadata: { category: 'news' },
	},
})
const fmId = textOf(fmCreate).match(/ID: ([0-9a-f-]{36})/)?.[1]
check(
	'frontmattered create succeeds',
	fmCreate.isError !== true && !!fmId,
	textOf(fmCreate).slice(0, 200),
)
const fmRead = await client.callTool({ name: 'get_content', arguments: { id: fmId } })
const fmText = textOf(fmRead)
check(
	'frontmatter was stripped from body and merged into metadata',
	!fmText.includes('title: FM Title') &&
		fmText.includes('"title": "FM Title"') &&
		fmText.includes('"rating": 3') &&
		fmText.includes('# Body heading'),
	fmText.slice(0, 400),
)

// --- 19. report_feedback saves to the DB ----------------------------------------
const fb = await client.callTool({
	name: 'report_feedback',
	arguments: {
		type: 'suggestion',
		tool: 'get_content',
		summary: 'E2E test feedback entry',
		details: 'Filed by the automated suite to verify persistence.',
	},
})
check(
	'report_feedback saves and returns an id',
	fb.isError !== true && /Feedback saved \(id: [0-9a-f-]{36}\)/.test(textOf(fb)),
	textOf(fb).slice(0, 150),
)

await client.close()

// --- 14. Read-only mode: write tools not registered ---------------------------
const roClient = await connect({ INNOLOPE_MCP_READ_ONLY: '1' })
const roTools = (await roClient.listTools()).tools.map((t) => t.name)
check(
	'read-only mode hides write tools',
	!roTools.includes('create_content') &&
		!roTools.includes('delete_content') &&
		!roTools.includes('bulk_update') &&
		roTools.includes('list_content') &&
		roTools.includes('get_collection_schema'),
	roTools.join(','),
)
check('read-only mode still offers report_feedback', roTools.includes('report_feedback'))
await roClient.close()

// --- 15. Disabled-tools list ---------------------------------------------------
const dtClient = await connect({ INNOLOPE_MCP_DISABLED_TOOLS: 'delete,export_collection' })
const dtTools = (await dtClient.listTools()).tools.map((t) => t.name)
check(
	'disabled list removes by name and operation type',
	!dtTools.includes('delete_content') &&
		!dtTools.includes('export_collection') &&
		dtTools.includes('create_content'),
	dtTools.join(','),
)
await dtClient.close()

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed > 0 ? 1 : 0)
