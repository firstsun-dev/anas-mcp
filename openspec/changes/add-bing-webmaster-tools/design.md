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

## Verified REST/JSON contract (2026-09-21)
Verified against Microsoft Learn (`bingwebmaster/api-protocols`, `getting-started`, and the `IWebmasterApi` method pages). The design's token/API-key assumption holds; no OAuth is needed. Microsoft states SOAP/POX are retired 2026-08-31 and JSON/HTTP is the supported replacement with the same API key.

- Base: `https://ssl.bing.com/webmaster/api.svc/json/<Method>`; token passed as query parameter `apikey` (no header mechanism is documented). Because the token is in the URL, the service never logs URLs and redacts `apikey=` from all error text.
- Success: HTTP 200 `{"d": ...}`. Provider error: HTTP 400 `{"ErrorCode": n, "Message": "..."}` (documented sample: `{"ErrorCode":3,"Message":"InvalidApiKey"}`).
- Dates use the WCF format `/Date(ms-offset)/`.

| MCP tool | Bing method | Params | Result fields used |
| --- | --- | --- | --- |
| `bing_list_sites` | `GetUserSites` | none | `Url`, `IsVerified` (`AuthenticationCode`, `DnsVerificationCode` are dropped) |
| `bing_search_performance` (`dimension=query`) | `GetQueryStats` | `siteUrl` | `Query`, `Date`, `Impressions`, `Clicks`, `AvgClickPosition`, `AvgImpressionPosition` |
| `bing_search_performance` (`dimension=page`) | `GetPageStats` | `siteUrl` | same fields; page URL is in `Query` |
| `bing_url_info` | `GetUrlInfo` | `siteUrl`, `url` (JSON string literal per samples) | `Url`, `IsPage`, `HttpStatus`, `DocumentSize`, `AnchorCount`, `TotalChildUrlCount`, `DiscoveryDate`, `LastCrawledDate` |

Findings that shape the tools:
- The provider has no pagination, row-limit, or date parameters on these methods and refreshes data roughly weekly. `limit`/`offset` and the optional `startDate`/`endDate` are therefore applied by the service after retrieval (documented in the tool description); the service also caps provider rows processed.
- Bing reports separate click and impression positions; both are preserved and missing values are `null`, not `0`.
- Provider error `ErrorCode` names beyond `InvalidApiKey` are not documented on the pages consulted; mapping to auth/rate-limit also uses HTTP status and `Throttle`/`Quota` message patterns and should be confirmed against a live credential.
- Not verified against a live Bing API: exact `GetUrlInfo` URL-parameter quoting and live error bodies.

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
Bing Webmaster API key is transmitted as a query parameter by the upstream API contract; automatic outbound fetch URL/query tracing must remain disabled unless the credential transport changes (`observability.traces.enabled: false` in `wrangler.jsonc`, enforced by `tests/repo-guardrails.test.ts`).

Log only safe operation metadata such as tool name, upstream latency, status class, and bounded result counts. Do not log query rows, URL-level payloads, or credential material by default.
