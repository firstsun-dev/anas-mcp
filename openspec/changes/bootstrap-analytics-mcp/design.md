# Design: bootstrap analytics MCP

## Runtime
Use Cloudflare Workers with the Agents SDK stateless MCP handler. `/mcp` is the protocol endpoint and `/health` is a simple HTTP readiness endpoint.

## Module boundaries

```text
src/
├── index.ts              # Worker routing and MCP handler
├── server.ts             # MCP server construction and tool registration
├── tools/
│   ├── ga4.ts
│   ├── search-console.ts
│   └── clarity.ts
└── services/
    ├── google-auth.ts
    ├── ga4.ts
    ├── search-console.ts
    └── postgres.ts
```

The bootstrap only implements `index.ts`, `server.ts`, and a health tool. Data-source modules are added in subsequent tasks.

## Production MCP authentication

Production `/mcp` authentication is now specified by `openspec/changes/add-cloudflare-access-auth/`.

The accepted design is:

- Cloudflare Access self-hosted application protects the production `/mcp` resource.
- Access **Managed OAuth** provides standards-based OAuth discovery and authorization for ChatGPT and other MCP clients.
- Access policies are the primary identity/authorization boundary and should be default-deny with explicit approved identities/groups.
- The Worker remains stateless and keeps using `createMcpHandler()`.
- Do not introduce a shared static bearer token, OpenAI IP allowlist, User-Agent authentication, or application username/password database.
- Do not add `@cloudflare/workers-oauth-provider`, `OAUTH_KV`, D1, Durable Objects, or PostgreSQL OAuth tables solely to duplicate Access Managed OAuth.
- If caller identity is needed by a tool, consume only the minimum trusted Access-provided context and never expose token/assertion material.

`/health` may remain public when Access is scoped specifically to `/mcp`, but it must expose readiness only.

## Credential architecture

`anas-mcp` uses Cloudflare Secrets Store as the default production source of truth for every long-lived secret that the Worker consumes directly. The detailed policy lives in `docs/credentials.md`.

### Secrets Store first

Examples that belong in Secrets Store when used by this service:

- Google OAuth credential JSON
- future provider API tokens
- application-owned OAuth client secrets (if a future accepted design requires them)
- signing or encryption keys owned by this application

Production credential values must not be placed in Wrangler `vars`, committed files, `.env`, `.dev.vars`, source code, or logs. Do not use `wrangler secret` where a Secrets Store binding can serve the same credential. An exception requires an accepted OpenSpec change documenting the reason.

### Platform-owned and external-service exceptions

Secrets Store must not become a duplicate copy of credentials already owned by a platform integration or another service:

- Cloudflare Access Managed OAuth token/session material remains owned by Cloudflare Access and is not duplicated into application storage.
- PostgreSQL credentials are configured on the Hyperdrive connection; `anas-mcp` receives only the `ANALYTICS_DB` binding.
- The Microsoft Clarity API token remains in `firstsun-dev/windmill-flows` because `anas-mcp` does not call Clarity directly.
- Short-lived provider access tokens are derived at runtime and are not persisted.
- A CI/deployment bootstrap credential may use the CI provider's protected secret store when it is needed before Cloudflare resources can be accessed; prefer workload identity/OIDC where supported.

## Google credentials
Store one JSON document in Cloudflare Secrets Store under a binding such as `GOOGLE_OAUTH_CREDENTIALS`. The Worker retrieves it asynchronously and validates the expected fields before token exchange.

Expected logical shape:

```json
{
  "client_id": "...",
  "client_secret": "...",
  "refresh_token": "...",
  "token_uri": "https://oauth2.googleapis.com/token"
}
```

Credential contents must never be logged. Short-lived access tokens may be reused within a Worker isolate when safe, but are not persisted.

Non-secret Google identifiers such as GA4 property ID and Search Console site URL may remain Wrangler `vars`.

## GA4
Expose a small composable tool surface:
- `ga4_run_report`
- `ga4_realtime`
- `ga4_metadata`

The service validates allowed dimensions/metrics, dates, filters, and limits before issuing Google Analytics Data API calls.

## Search Console
Expose:
- `gsc_search_analytics`
- `gsc_url_inspection`
- `gsc_list_sites`

The service applies safe defaults and bounded row limits.

## Clarity
Clarity data comes only from PostgreSQL. `windmill-flows` remains responsible for Clarity API quota, raw response retention, normalization, retry handling, and historical snapshots.

The MCP service connects through Hyperdrive using a database role with SELECT-only privileges. The database password is configured in Hyperdrive and not duplicated into Secrets Store. Initial tools:
- `clarity_overview`
- `clarity_pages`
- `clarity_page`

Queries are parameterized and predefined. No generic SQL tool exists.

## Clarity data semantics
The Clarity export is aggregate and may represent rolling windows. Query code must select the intended successful fetch run(s) and must not blindly sum overlapping rolling-window snapshots. The MCP-facing query layer should either use dedicated read views or explicitly deduplicate/select canonical runs.

## Authentication layers
There are separate provider and client boundaries:

1. MCP client authentication to `anas-mcp`: Cloudflare Access Managed OAuth.
2. `anas-mcp` authentication to Google APIs: Google OAuth credential JSON from Secrets Store, exchanged for short-lived Google access tokens.
3. `anas-mcp` authentication to PostgreSQL: Hyperdrive-managed database credentials with a read-only role.

These credentials/tokens are owned by different systems and must not be conflated or copied between stores.

## Error handling
- Return validation errors without upstream calls when inputs are invalid.
- Do not include secrets, Access assertions, access tokens, database URLs, or raw provider responses in errors.
- Distinguish authentication, quota/upstream, database, and validation failures.

## Observability
Cloudflare Worker observability is enabled. Log operation names, latency, status class, and safe aggregate counts only. Do not log analytics row payloads, Access security headers/assertions, or credential material by default.
