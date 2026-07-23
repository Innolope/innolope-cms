/**
 * License key generator (signing side).
 *
 * Produces a signed `ink-lic_...` key that the API's license plugin
 * (src/plugins/license.ts) verifies against the matching public key.
 *
 * The private key NEVER ships with the product. Keep it out of this repo —
 * store it in the cloud/ops repository or a secret manager. Anyone with the
 * private key can mint valid licenses.
 *
 * Generate a keypair (one-time):
 *   tsx src/scripts/generate-license.ts --gen-keypair --out-dir ./keys
 *   # → keys/license-private.pem  (keep secret)
 *   # → keys/license-public.pem   (ship with product / set INNOLOPE_LICENSE_PUBLIC_KEY)
 *
 * Mint a license:
 *   tsx src/scripts/generate-license.ts \
 *     --private-key ./keys/license-private.pem \
 *     --org "Acme Inc" --email admin@acme.com \
 *     --plan enterprise --years 1
 *
 * Flags:
 *   --gen-keypair          Generate an RSA-2048 keypair and exit.
 *   --out-dir <dir>        Output dir for --gen-keypair (default: current dir).
 *   --private-key <path>   PEM file to sign with. Falls back to env
 *                          INNOLOPE_LICENSE_PRIVATE_KEY (PEM contents).
 *   --org <name>           Organization name (required).
 *   --email <email>        Contact email (required).
 *   --plan <pro|enterprise>  Default: enterprise.
 *   --features <a,b,c>     Override the plan's default feature set.
 *   --max-projects <n>     -1 = unlimited. Default: pro=1, enterprise=-1.
 *   --years <n>            Validity in years (default 1). Mutually exclusive
 *                          with --expires.
 *   --expires <ISO date>   Explicit expiry, e.g. 2027-01-01.
 *   --json                 Print the full payload + key as JSON.
 */
import { createSign, generateKeyPairSync } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { LicenseFeature, LicensePayload } from '../plugins/license.js'

const ALL_FEATURES: LicenseFeature[] = [
	'sso',
	'audit-log',
	'ai-assistant',
	'multiple-projects',
	'webhooks',
	'scheduling',
	'custom-roles',
	'white-label',
	'review-workflows',
	'media-integrations',
	'custom-domain',
	'remote-mcp',
]

// Pro is the lower paid tier — the features the API gates as "Pro".
const PRO_FEATURES: LicenseFeature[] = ['ai-assistant', 'media-integrations', 'remote-mcp']

function arg(name: string): string | undefined {
	const prefixed = `--${name}=`
	for (let i = 0; i < process.argv.length; i++) {
		const a = process.argv[i]
		if (a === `--${name}`) return process.argv[i + 1]
		if (a.startsWith(prefixed)) return a.slice(prefixed.length)
	}
	return undefined
}

function has(name: string): boolean {
	return process.argv.some((a) => a === `--${name}` || a.startsWith(`--${name}=`))
}

function die(msg: string): never {
	console.error(`Error: ${msg}`)
	process.exit(1)
}

if (has('gen-keypair')) {
	const outDir = resolve(arg('out-dir') || '.')
	mkdirSync(outDir, { recursive: true })
	const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
	const privPath = join(outDir, 'license-private.pem')
	const pubPath = join(outDir, 'license-public.pem')
	writeFileSync(privPath, privateKey.export({ type: 'pkcs1', format: 'pem' }) as string, {
		mode: 0o600,
	})
	writeFileSync(pubPath, publicKey.export({ type: 'spki', format: 'pem' }) as string)
	console.log(`Private key: ${privPath}  (keep secret — never commit)`)
	console.log(`Public key:  ${pubPath}   (ship with product / INNOLOPE_LICENSE_PUBLIC_KEY)`)
	process.exit(0)
}

const privateKeyPath = arg('private-key')
let privateKeyPem = process.env.INNOLOPE_LICENSE_PRIVATE_KEY
if (privateKeyPath) {
	try {
		privateKeyPem = readFileSync(resolve(privateKeyPath), 'utf-8')
	} catch {
		die(`could not read private key file: ${privateKeyPath}`)
	}
}
if (!privateKeyPem) {
	die('no private key — pass --private-key <path> or set INNOLOPE_LICENSE_PRIVATE_KEY')
}

const org = arg('org')
const email = arg('email')
if (!org) die('--org is required')
if (!email) die('--email is required')

const plan = (arg('plan') || 'enterprise') as 'pro' | 'enterprise'
if (plan !== 'pro' && plan !== 'enterprise') die('--plan must be "pro" or "enterprise"')

let features: LicenseFeature[]
const featuresArg = arg('features')
if (featuresArg) {
	features = featuresArg.split(',').map((f) => f.trim()) as LicenseFeature[]
	const invalid = features.filter((f) => !ALL_FEATURES.includes(f))
	if (invalid.length) die(`unknown feature(s): ${invalid.join(', ')}`)
} else {
	features = plan === 'enterprise' ? [...ALL_FEATURES] : [...PRO_FEATURES]
}

const maxProjectsArg = arg('max-projects')
const maxProjects = maxProjectsArg
	? Number.parseInt(maxProjectsArg, 10)
	: plan === 'enterprise'
		? -1
		: 1
if (Number.isNaN(maxProjects)) die('--max-projects must be a number')

if (has('years') && has('expires')) die('--years and --expires are mutually exclusive')
let expiresAt: string
const expiresArg = arg('expires')
if (expiresArg) {
	const d = new Date(expiresArg)
	if (Number.isNaN(d.getTime())) die(`--expires is not a valid date: ${expiresArg}`)
	expiresAt = d.toISOString()
} else {
	const years = Number.parseInt(arg('years') || '1', 10)
	if (Number.isNaN(years) || years <= 0) die('--years must be a positive number')
	const d = new Date()
	d.setFullYear(d.getFullYear() + years)
	expiresAt = d.toISOString()
}

const payload: LicensePayload = {
	org,
	email,
	plan,
	features,
	maxProjects,
	expiresAt,
	issuedAt: new Date().toISOString(),
}

const payloadStr = JSON.stringify(payload)
const signature = createSign('SHA256').update(payloadStr).sign(privateKeyPem, 'base64')
const inner = JSON.stringify({ payload: payloadStr, signature })
const key = `ink-lic_${Buffer.from(inner).toString('base64')}`

if (has('json')) {
	console.log(JSON.stringify({ payload, key }, null, 2))
} else {
	console.log(`Org:      ${org}`)
	console.log(`Plan:     ${plan}`)
	console.log(`Features: ${features.join(', ')}`)
	console.log(`Projects: ${maxProjects === -1 ? 'unlimited' : maxProjects}`)
	console.log(`Expires:  ${expiresAt}`)
	console.log('')
	console.log(key)
}
