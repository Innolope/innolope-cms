# Innolope CMS

Agentic-native, markdown-first headless CMS. AI agents write content directly via MCP — no format conversion needed.

## Features

- **Markdown-native** — content stored as plain markdown, not proprietary JSON
- **MCP server** — Claude, Cursor, and AI agents connect directly via `@innolope/mcp-server`
- **AI writing assistant** — multi-provider chat panel (Anthropic, OpenAI, Google, OpenRouter) with text selection quick actions
- **Multi-project** — manage multiple websites from one instance with per-project roles and isolation
- **Cloudflare media** — Images, Stream (video), and R2 (files) out of the box
- **Role-based auth** — per-project roles (owner / admin / editor / viewer) + granular API key permissions
- **Visual editor** — TipTap WYSIWYG that imports/exports markdown
- **Auto-save drafts** — edits are saved locally every 5 seconds and can be restored after page reload or browser crash
- **Content versioning** — full history with diff view and one-click revert
- **Localization** — multi-locale content with translation coverage tracking
- **REST API** — versioned API at `/api/v1/*` for any frontend framework
- **Real-time events** — SSE stream for content changes and agent activity
- **Self-hostable** — Docker Compose with PostgreSQL, deploy anywhere
- **TypeScript SDK** — `@innolope/sdk` for consuming content in your app

## Supported Databases

Innolope CMS uses a built-in PostgreSQL database by default. You can also connect an external database to import and manage existing content:

| Provider | Type | Connection |
|----------|------|------------|
| **Built-in** | PostgreSQL | Managed by Innolope CMS |
| **MongoDB** | NoSQL | Atlas or self-hosted |
| **PostgreSQL** | SQL | Direct connection |
| **MySQL** | SQL | Direct connection |
| **Supabase** | SQL | Managed Postgres |
| **CockroachDB** | SQL | Distributed SQL |
| **Firebase** | NoSQL | Firestore via service account |
| **Neon** | SQL | Serverless Postgres |
| **Vercel Postgres** | SQL | Serverless SQL |

External databases support full CRUD or read-only mode. Content is cached as markdown for AI agent retrieval. Edits are synced to the external database on save, with local auto-save drafts for recovery.

## Quick Start

```bash
# Clone and install
git clone https://github.com/Innolope/innolope-cms
cd innolope-cms
pnpm install

# Set up environment
cp .env.example .env
# Edit .env with your DATABASE_URL and AUTH_SECRET (min 32 chars)

# Generate and run database migrations
pnpm db:generate
pnpm db:migrate

# Seed default admin + project + collections
ADMIN_PASSWORD=your-secure-password DATABASE_URL=your-db-url pnpm --filter @innolope/db db:seed

# Start dev servers
pnpm dev
# API: http://localhost:3001
# Admin: http://localhost:5173
```

## Architecture

```
innolope-cms/
├── apps/
│   ├── api/           Fastify REST API + auth + media adapters
│   └── admin/         Vite + React 19 admin UI
├── packages/
│   ├── types/         Shared TypeScript types
│   ├── db/            Drizzle ORM schemas + migrations
│   ├── config/        Zod validation + CMS config
│   ├── mcp-server/    MCP server for AI agents
│   └── sdk/           Published SDK for frontend consumers
```

## Connect Claude

1. Create an API key in **Settings > API Keys**
2. Add to your Claude config:

```json
{
  "mcpServers": {
    "innolope": {
      "command": "npx",
      "args": ["@innolope/mcp-server"],
      "env": {
        "INNOLOPE_API_URL": "http://localhost:3001",
        "INNOLOPE_API_KEY": "ink_your-key-here"
      }
    }
  }
}
```

3. Claude can now create, read, update, publish, and search content.

## API Routes

| Prefix | Description | Auth |
|--------|-------------|------|
| `/api/v1/health` | Health check | Public |
| `/api/v1/auth` | Login, register, API keys | Mixed |
| `/api/v1/projects` | Project CRUD + member management | User-scoped |
| `/api/v1/content` | Content CRUD + versioning + revert | Project-scoped |
| `/api/v1/collections` | Collection CRUD | Project-scoped |
| `/api/v1/media` | Media upload, list, delete | Project-scoped |
| `/api/v1/ai` | AI completion, settings, models | Project-scoped |
| `/api/v1/locales` | Locale info, translations, coverage | Project-scoped |
| `/api/v1/stats` | Dashboard stats, analytics, MCP usage tracking | Project-scoped |
| `/api/v1/stream` | SSE real-time events | Project-scoped |
| `/api/v1/license` | License info + feature flags | Public |

## Docker (Self-Hosted)

```bash
docker-compose up
# API: http://localhost:3001
# Admin: http://localhost:8080
# PostgreSQL: localhost:5432
```

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `DATABASE_URL` | Yes | PostgreSQL connection string |
| `AUTH_SECRET` | Yes | JWT secret (min 32 chars) |
| `API_PORT` | No | API port (default: 3001) |
| `API_HOST` | No | API host (default: 0.0.0.0) |
| `ADMIN_URL` | No | Admin origin for CORS |
| `MEDIA_ADAPTER` | No | `local` (default) or `cloudflare` |
| `CLOUDFLARE_ACCOUNT_ID` | No | For Cloudflare media |
| `CLOUDFLARE_API_TOKEN` | No | For Cloudflare media |
| `CLOUDFLARE_IMAGES_ACCOUNT_HASH` | No | For image delivery |
| `CLOUDFLARE_R2_BUCKET` | No | R2 bucket name |
| `POSTHOG_API_KEY` | No | PostHog project API key (enables analytics) |
| `POSTHOG_HOST` | No | PostHog instance URL (default: `https://us.i.posthog.com`) |
| `POSTHOG_DISABLED` | No | Set to `true` to force-disable PostHog |
| `INNOLOPE_LICENSE_KEY` | No | Enterprise license key (enables AI, multi-project, etc.) |

## Analytics (PostHog)

Innolope CMS ships with optional PostHog integration for tracking content lifecycle events and MCP server usage. Set two environment variables and every CMS event flows into your PostHog instance — no code changes required.

### Setup

```bash
POSTHOG_API_KEY=phc_your_key_here
POSTHOG_HOST=https://us.i.posthog.com   # or your self-hosted PostHog URL
```

When `POSTHOG_API_KEY` is not set, analytics are completely disabled — no dependencies loaded, no network calls, no performance impact.

To force-disable even when the key is present:

```bash
POSTHOG_DISABLED=true
```

### Events Tracked

**Content lifecycle** (automatic via event bus — no per-route instrumentation):

| Event | Fired when |
|-------|-----------|
| `cms_content_created` | Content item created |
| `cms_content_updated` | Content item updated |
| `cms_content_published` | Content item published |
| `cms_content_deleted` | Content item deleted |
| `cms_content_submitted` | Content submitted for review |
| `cms_content_approved` | Content approved |
| `cms_content_rejected` | Content rejected |
| `cms_media_uploaded` | Media file uploaded |
| `cms_media_deleted` | Media file deleted |

**Auth events:**

| Event | Fired when |
|-------|-----------|
| `cms_user_login` | User logs in |
| `cms_user_registered` | New user registered |
| `cms_user_logout` | User logs out |
| `cms_user_password_changed` | Password changed |

**MCP server usage** (automatic — every tool call is instrumented):

| Event | Properties |
|-------|-----------|
| `cms_mcp_tool_called` | `tool`, `duration_ms`, `success`, `error`, `project_id`, `params` |
| `cms_mcp_content_read` | `content_id`, `project_id` |
| `cms_mcp_search_hit` | `query`, `project_id` |
| `cms_mcp_search_miss` | `query`, `project_id` |

MCP tool call parameters are sanitized before sending — large fields like `markdown` are replaced with character counts, and bulk `items` arrays are replaced with item counts. No content body data is sent to PostHog.

### Architecture

The integration works as a Fastify plugin that subscribes to the existing event bus (the same mechanism webhooks use). The MCP server reports tool usage back to the API via `POST /api/v1/stats/mcp-usage`, which forwards to PostHog server-side using `posthog-node`. All PostHog calls are fire-and-forget — they never block API responses or MCP tool execution.

### Example PostHog Dashboards

With this data you can build:

- **MCP adoption** — which tools are used most, average response times, error rates
- **Content funnel** — created → submitted → approved → published conversion
- **Search quality** — hit/miss ratio, most common queries with no results
- **User engagement** — login frequency, active projects, content velocity

## Enterprise Features

The Community edition is free and includes core CMS, MCP server, API, SDK, basic roles, and content versioning. Enterprise features require a license key:

| Feature | Community | Pro | Enterprise |
|---------|-----------|-----|-----------|
| Content CRUD + API + MCP | Yes | Yes | Yes |
| Visual editor + versioning | Yes | Yes | Yes |
| 1 project | Yes | Yes | Yes |
| Multiple projects | — | Up to 10 | Unlimited |
| AI writing assistant | — | Yes | Yes |
| Webhooks | — | Yes | Yes |
| Content scheduling | — | Yes | Yes |
| Audit logs | — | — | Yes |
| SSO / SAML | — | — | Yes |
| Custom roles | — | — | Yes |
| White-labeling | — | — | Yes |

## Tech Stack

Fastify, Drizzle ORM, PostgreSQL, React 19, Vite, TanStack Router, TipTap, Tailwind CSS v4, Turborepo, Biome, Docker

## License

**Core CMS** — [Business Source License 1.1](LICENSE). Free for self-hosting, internal use, client projects. Cannot be offered as a hosted service. Converts to Apache 2.0 on 2029-04-09.

**Enterprise features** (`/ee/`) — [Commercial license](apps/api/src/ee/LICENSE). Requires Pro or Enterprise license key for production use.
