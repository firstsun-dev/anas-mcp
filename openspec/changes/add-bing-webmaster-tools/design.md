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
    └── bing-webmaster.ts
```

- `tools/bing-webmaster.ts`: Zod/MCP schemas, validation, bounded output shaping.
- `services/bing-webmaster.ts`: Secrets Store token loading, upstream REST/JSON requests, and provider error normalization.

## Authentication
Use a long-lived Bing Webmaster provider token/API key for the initial Firstsun server-side integration.

The production source of truth is a Cloudflare Secrets Store secret bound to the Worker, for example:

```text
BING_WEBMASTER_TOKEN
```

Treat the value as opaque credential material. The Worker retrieves it only at runtime and attaches it only to Bing Webmaster upstream requests using the authentication mechanism required by the verified REST/JSON endpoint.

Rules:
- Do not commit or log the Bing provider token.
- Do not copy the token into Wrangler `vars`, `.env`, `.dev.vars`, GitHub Actions, KV, D1, PostgreSQL, or source code.
- Do not add an OAuth authorization-code/refresh-token flow for the initial Bing integration unless a future accepted OpenSpec change requires delegated user authorization.
- Keep the MCP tool surface read-only even if the configured provider credential is technically capable of write operations.

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
- what additional upstream credential capability is required
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
- Never include the Bing provider token or raw authorization material in errors.
- Do not return raw provider payloads by default.

## Observability
Log only safe operation metadata such as tool name, upstream latency, status class, and bounded result counts. Do not log query rows, URL-level payloads, or credential material by default.
