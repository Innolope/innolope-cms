# IndexNow

> Tier: Community (no license feature required)

[IndexNow](https://www.indexnow.org) lets a site tell search engines — Bing, Yandex, Seznam, Naver and the others that share submissions — which URLs changed, so they recrawl them within minutes instead of whenever they next pass by. Innolope submits for every site connected to it: when content is published, edited while published, unpublished, archived or deleted, the CMS works out the public URLs that changed and sends them. A site does not build its own submitter; it only has to serve one small key file.

This page covers the two settings that make it work, what gets submitted and when, the key-file contract for site builders, and how to read the results.

## Setup

1. **Give each public collection a URL template.** In the admin, open the collection → **Edit** → **Public URL**, e.g. `https://example.com/blog/{slug}/`. Collections without a template are never submitted (authors, tags and other collections that have no pages of their own).
2. **Turn IndexNow on for the project.** **Settings → Developer → IndexNow** → tick *Submit changed pages to search engines* → **Save**. A 32-character key is generated on the first save.
3. **Make the site serve the key file** (see [Key file](#key-file)). The panel shows the exact URL and content; **Check key file** fetches it the way a search engine would.
4. **Submit what is already published** — **Submit all** next to each collection. From then on, changes are submitted automatically.

The same steps through the API or an agent:

| Step | REST | MCP tool |
| --- | --- | --- |
| URL template | `PUT /api/v1/collections/:id` with `{ "settings": { "publicUrlTemplate": "https://example.com/blog/{slug}/" } }` | `update_collection` |
| Enable, key, key location | `PUT /api/v1/indexnow` | `configure_indexnow` |
| Check the key file | `POST /api/v1/indexnow/verify` | `get_indexnow_status` (shows held URLs) |
| Submit everything published | `POST /api/v1/indexnow/collections/:id/resubmit` | `resubmit_to_indexnow` |
| Status and recent results | `GET /api/v1/indexnow` | `get_indexnow_status` |

## Where the settings live, and why

- **The public URL template is per collection** (`collections.settings.publicUrlTemplate`). A collection is the thing with a URL shape: a blog's posts and its docs pages live under different paths, or on different hosts.
- **IndexNow itself is per project** (`projects.settings.indexNow = { enabled, key, keyLocation }`). In Innolope a project is one site — it owns the custom domain, the webhooks and the API keys a site builder uses — and IndexNow proves ownership per site: one key file on the site covers every collection of it. A collection takes part exactly when the project has IndexNow on and the collection has a template, so no second switch per collection is needed.

The IndexNow block of the project settings is owned by `/api/v1/indexnow`: `PUT /api/v1/projects/:id` keeps the stored value whatever its body says, so a settings form holding a stale copy can never switch IndexNow off or swap its key.

## URL templates

A template is an absolute `https://` (or `http://`) URL with placeholders:

| Placeholder | Value |
| --- | --- |
| `{slug}` | The record's slug. Slashes in a slug are kept as path separators (`docs/getting-started`); every segment is percent-encoded. |
| `{locale}` | The record's locale code (`en`, `uk`, `pt-BR`). |
| `{id}` | The record's id. |

Rules, checked on save:

- The template must contain `{slug}` or `{id}` — otherwise every record would share one URL.
- The host must be literal (`https://{locale}.example.com/…` is refused): IndexNow submits per host, and the host goes through the CMS's outbound URL guard, which refuses private and internal addresses.
- Unknown placeholders (`{title}`) are refused, naming the token.

A record whose slug is empty has no `{slug}` URL and is skipped.

**Languages.** A collection with translatable fields keeps every language in one record. If its template has `{locale}`, each record yields one URL per project locale (`https://example.com/en/blog/x/`, `https://example.com/uk/blog/x/`). A collection without translatable fields has one record per language, and each record yields the URL in its own locale.

## What is submitted, and when

Submission rides on the content events every write path already emits — the editor, `PUT/POST /api/v1/content/bulk`, the list view's bulk actions, approve, revert, scheduling, the scheduled publisher and every MCP write tool (`publish_content` included). Events carry the record's state before and after the write, and the URLs are derived from both:

| Change | URLs submitted |
| --- | --- |
| Publish (any path, including a scheduled publish) | The record's URL |
| Edit of a published record | Its URL |
| Slug or locale change of a published record | The new URL and the old one |
| Unpublish, archive, schedule a published record | Its URL — engines recrawl and see it gone |
| Delete a published record | Its URL (the page now answers 404) |
| Delete a collection | Every published record's URL |
| Anything that never touches a published state (draft edits, submit for review, reject) | Nothing |

Edits made to an external database directly, outside the CMS, are not seen and not submitted.

### Batching, retries and the key-file check

- **Debounce.** A queued URL waits 60 seconds (`INDEXNOW_DEBOUNCE_MS`). When the oldest URL of a site is due, every URL queued for that collection and host goes in the same request, so a burst of edits leaves as one submission. A URL already queued is not queued twice.
- **Batches.** At most 10,000 URLs per request, the protocol's limit; a bigger resubmit goes out as several requests.
- **Durable.** The queue is a Postgres table (`indexnow_queue`). A deploy right after a publish does not lose the submission, and several API instances share the queue without sending a URL twice.
- **Key file first.** Before each request the CMS fetches the key file on the site's host. When it is missing or wrong, nothing is sent: the URLs are **held** and rechecked every 5 minutes, and the admin shows why. They go out as soon as the site serves the file. URLs held for 7 days are given up.
- **Retries.** `429` and `5xx` responses and network failures are retried with backoff — 1 min, 5 min, 30 min, 2 h, then 6 h, or the endpoint's `Retry-After` when it sends one — and given up after 6 attempts. `400`, `403` and `422` need a settings fix rather than a retry: the batch is logged as failed with the response text.

## Key file

IndexNow verifies a submission by fetching a text file on the site whose only content is the key. By default the file is `https://<host>/<key>.txt`. When the site can only serve files under a sub-path, set **Key file URL** (`keyLocation`), e.g. `https://example.com/news/<key>.txt`. On any other host the project submits for, the same path is used on that host.

### Contract for site builders

A static site builder can write the key file itself on every build. It needs only a **read-only** API key (any `*:read` permission):

```
GET /api/v1/indexnow/key
Authorization: Bearer ink_…
```

```json
{
  "enabled": true,
  "key": "3f8a1c0d9e7b4a2f8c6d5e4b3a2f1e0d",
  "keyLocation": "https://example.com/news/3f8a1c0d9e7b4a2f8c6d5e4b3a2f1e0d.txt",
  "keyFile": {
    "path": "/news/3f8a1c0d9e7b4a2f8c6d5e4b3a2f1e0d.txt",
    "content": "3f8a1c0d9e7b4a2f8c6d5e4b3a2f1e0d"
  },
  "hosts": [
    {
      "host": "example.com",
      "keyLocation": "https://example.com/news/3f8a1c0d9e7b4a2f8c6d5e4b3a2f1e0d.txt"
    }
  ]
}
```

| Field | Meaning |
| --- | --- |
| `enabled` | Whether the CMS is submitting. A builder can write the file either way — serving it early makes switching on instant. |
| `key` | The key; `null` when none has been generated yet. |
| `keyLocation` | The configured key-file URL, or `null` for the default `https://<host>/<key>.txt`. |
| `keyFile` | Write `content` (exactly, no trailing text) to `path` on the site, served as `text/plain`. `null` when there is no key. |
| `hosts` | Every host the project submits for (the hosts of its collections' URL templates and of `keyLocation`), with the key-file URL used on that host. |

With no key configured the response is `{ "enabled": false, "key": null, "keyLocation": null, "keyFile": null, "hosts": [] }`. The JS SDK wraps it as `cms.getIndexNowKey()`.

Rules for the builder:

- Serve the file at `keyFile.path` on every host in `hosts`, unauthenticated, without redirects to another host. Cloudflare and similar front doors must let search-engine bots fetch it.
- Re-read it on every build: the key changes when an admin regenerates it, and submissions are held until the new file is live.
- Keep serving an old key file for a while after a key change — it does no harm.

## Results

`GET /api/v1/indexnow` (viewer+) returns the settings, the key files per host, each collection with a template — `pending` (queued URLs), `waiting` (held for the key file) and its `lastSubmission` — and the 20 most recent submissions. Each submission records the host, URL count, the first URLs, the IndexNow status code and response text, and a status:

| Status | Meaning |
| --- | --- |
| `success` | IndexNow answered `200` (submitted) or `202` (received, key still being validated). |
| `retrying` | A transient failure; the URLs stay queued with backoff. |
| `waiting` | Held because the key file is missing or wrong; logged once when the hold starts. |
| `failed` | Given up: a `4xx` that needs a settings fix, a host the URL guard refuses, or retries exhausted. |

The log keeps 30 days. The same view is in **Settings → Developer → IndexNow** and behind the `get_indexnow_status` MCP tool.

## Settings API

```
PUT /api/v1/indexnow
```

Auth: `admin` role on the project.

| Field | Notes |
| --- | --- |
| `enabled` | `true` submits changes; `false` stops and drops anything still queued. |
| `key` | Use this key (8–128 letters, digits, dashes). Normally omitted: one is generated when the project has none. |
| `keyLocation` | Absolute URL of the key file on the site, screened by the outbound URL guard. `null` or `''` restores the default. |
| `regenerateKey` | `true` replaces the key. A key location whose file name is the old key (`…/<old>.txt`) follows to `…/<new>.txt`. |

The response is the same body as `GET /api/v1/indexnow`.

```
POST /api/v1/indexnow/collections/:id/resubmit
```

Auth: `admin`. Queues every published record of the collection, due at once, and answers `{ "queued": <urls>, "skipped": <published records without a URL> }`. `400` when IndexNow is off or the collection has no template.

```
POST /api/v1/indexnow/verify
```

Auth: `admin`. Fetches the key file on every host now and answers `{ "results": [{ "host", "keyLocation", "ok", "statusCode", "message" }] }`.

## Environment

| Variable | Default | Description |
| --- | --- | --- |
| `INDEXNOW_ENDPOINT` | `https://api.indexnow.org/indexnow` | Where submissions are sent. The shared endpoint forwards to every participating engine. |
| `INDEXNOW_DEBOUNCE_MS` | `60000` | How long a changed URL waits for others to join its request. |
| `INDEXNOW_TICK_MS` | `15000` | How often the queue is checked. `0` turns the background sender off (tests). |

## Limits

- Changing a collection's URL template does not resubmit anything by itself; use **Submit all** once the site serves the new URLs.
- Only changes made through the CMS are submitted. Rows edited directly in a connected external database are not.
- Search engines decide what to crawl and index; a `200` means the submission was accepted, not that a page was indexed.
