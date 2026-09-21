# Design: Bing Webmaster Tools provider

## Runtime model
Bing Webmaster Tools is queried directly by `anas-mcp` at MCP request time. It does not flow through Windmill or PostgreSQL.

```text
ChatGPT / MCP client
        |
        v
Cloudflare Access
        |
        v
anas-mcp
        |
        +--> Bing Webmaster REST/JSON API
```

The exact upstream REST/JSON operation URLs must be verified against Microsoft documentation during implementation. Do not copy examples that depend on retired SOAP/POX protocols.

## Module boundaries

```text
src/
├── tools/
│   └── bing-webmaster.ts
└── services/
    ├── bing-auth.ts
    └── bing-webmaster.ts
```

- `tools/bing-webmaster.ts`: Zod/MCP schemas, validation, bounded output shaping.
- `services/bing-auth.ts`: Secrets Store credential loading and OAuth access-token refresh.
- `services/bing-webmaster.ts`: upstream REST/JSON requests and provider error normalization.

## Authentication
Use Bing Webmaster OAuth 2.0 with the least-privilege `Webmaster.read` scope.

Store one structured credential in Cloudflare Secrets Store, logically containing the fields required to refresh provider access, for example:

```json
{
  "client_id": "...",
  "client_secret": "...",
  "refresh_token": "...",
  "token_uri": "https://www.bing.com/webmasters/oauth/token"
}
```

The exact credential schema should be validated in code and may evolve if Microsoft changes its OAuth requirements.

Rules:
- Do not request `Webmaster.manage` for the initial integration.
- Do not use API keys as the normal production credential path.
- Do not commit or log credential values.
- Derived access tokens are runtime-only and must not be persisted to Secrets Store, KV, D1, logs, or source control.

## Initial MCP tools

### `bing_list_sites`
Return the Bing Webmaster sites visible to the configured credential.

Constraints:
- read-only
- bounded result count
- do not expose verification secrets/codes if the provider response contains them

### `bing_search_performance`
Expose the search-performance data needed for SEO analysis, including query/page-oriented traffic statistics available from the supported Bing API.

Constraints:
- require an authorized site URL
- bound rows and any provider-supported date/filter dimensions
- normalize impressions, clicks, and position-like fields without inventing unavailable metrics
- do not promise parity with Google Search Console where Bing semantics differ

### `bing_url_info`
Return provider-supported index/crawl information for a URL belonging to an authorized site.

Constraints:
- validate URL/site relationship
- read only
- return a stable normalized subset rather than raw provider payloads

## Write operations
The initial provider intentionally excludes URL submission, Sitemap mutation, site configuration changes, and every other write-capable operation.

Adding a Bing write tool requires a new accepted OpenSpec change covering:
- why write access is necessary
- whether `Webmaster.manage` is required
- authorization and audit controls
- tool confirmation/guardrails
- blast radius and rollback behavior

## Protocol compatibility
Microsoft documents retirement of the legacy SOAP and POX Bing Webmaster APIs as of 2026-08-31. The implementation must use the Microsoft-supported REST/JSON interface current at implementation time.

Do not build new code against:
- SOAP endpoints
- POX endpoints
- legacy SDK assumptions that require those protocols

Because Microsoft documentation contains historical samples, implementation work must verify the current REST/JSON endpoint and payload contract rather than blindly copying an old sample.

## Error handling
- Validate site URLs and tool limits before upstream calls.
- Normalize authorization, quota, validation, and upstream failures.
- Never include client secrets, refresh tokens, access tokens, or raw authorization headers in errors.
- Do not return raw provider payloads by default.

## Observability
Log only safe operation metadata such as tool name, upstream latency, status class, and bounded result counts. Do not log query rows, URL-level payloads, or credential material by default.
