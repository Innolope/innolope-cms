import { createDb } from './index.js'
import { users } from './schema/users.js'
import { projects, projectMembers } from './schema/projects.js'
import { collections } from './schema/collections.js'
import { sql } from 'drizzle-orm'
import bcrypt from 'bcrypt'

export async function seed(databaseUrl: string) {
	const db = createDb(databaseUrl)

	const [{ count }] = await db.select({ count: sql<number>`count(*)` }).from(users)

	if (Number(count) > 0) {
		console.log('Database already seeded. Skipping.')
		return
	}

	console.log('Seeding database...')

	// Create default admin
	const adminPassword = process.env.ADMIN_PASSWORD
	if (!adminPassword) {
		console.error('ADMIN_PASSWORD environment variable is required for seeding')
		process.exit(1)
	}
	const passwordHash = await bcrypt.hash(adminPassword, 12)

	const [admin] = await db
		.insert(users)
		.values({ email: 'admin@innolope.local', name: 'Admin', passwordHash, role: 'admin' })
		.returning()

	console.log(`Created admin user: ${admin.email}`)

	// Create default project
	const [project] = await db
		.insert(projects)
		.values({
			name: 'My Website',
			slug: 'my-website',
			ownerId: admin.id,
			settings: { locales: ['en'], defaultLocale: 'en', mediaAdapter: 'local' },
		})
		.returning()

	console.log(`Created project: ${project.name} (${project.id})`)

	// Add admin as owner of project
	await db.insert(projectMembers).values({
		projectId: project.id,
		userId: admin.id,
		role: 'owner',
	})

	// Create default "Articles" collection
	const [articles] = await db
		.insert(collections)
		.values({
			projectId: project.id,
			name: 'Articles',
			slug: 'articles',
			description: 'Blog posts and articles',
			fields: [
				{ name: 'title', type: 'text', required: true, localized: true },
				{ name: 'excerpt', type: 'text', localized: true },
				{ name: 'tags', type: 'array' },
				{ name: 'featuredImage', type: 'text' },
				{ name: 'author', type: 'text' },
			],
		})
		.returning()

	console.log(`Created collection: ${articles.name}`)

	// Create default "Pages" collection
	const [pages] = await db
		.insert(collections)
		.values({
			projectId: project.id,
			name: 'Pages',
			slug: 'pages',
			description: 'Static pages',
			fields: [
				{ name: 'title', type: 'text', required: true, localized: true },
				{ name: 'description', type: 'text', localized: true },
			],
		})
		.returning()

	console.log(`Created collection: ${pages.name}`)
	console.log('Seed complete.')
}

const url = process.env.DATABASE_URL
if (url) {
	seed(url).catch(console.error).finally(() => process.exit(0))
} else {
	console.error('DATABASE_URL not set')
	process.exit(1)
}
