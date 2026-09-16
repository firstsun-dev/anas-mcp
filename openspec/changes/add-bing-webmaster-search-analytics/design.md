# Design: Bing Webmaster and unified search analytics

## Context
The repository currently has only the MCP foundation and `health` tool implemented. Search Console is specified as a future direct datasource, but its planned public tool names are provider-specific. Because Bing Webmaster is being added before the GSC tool surface is shipped, this is the right point to establish one search-analytics domain model instead of creating two parallel tool families.

The public MCP contract should represent user intent (overview, queries, pages, drilldowns), not upstream method names. Provider adapters translate those intents into Google Search Console or Bing Webmaster calls.

## Architecture

```text
ChatGPT / MCP client
        |
        | Cloudflare Access Managed OAuth
        v
Cloudflare Worker: anas-mcp
        |
        +--> unified search MCP tools
        |       |
        |       +--> GSC adapter --> Google Search Console API
        |       |
        |       +--> Bing adapter --> Bing Webmaster JSON/HTTP API
        |
        +--> provider-specific tools
                |
                +--> gsc_url_inspection
```

Suggested module boundaries:

```text
src/
├── search/
│   ├── types.ts
│   ├── normalize.ts
│   └── adapters/
│       ├── gsc.ts
│       └── bing.ts
├── services/
│   ├── google-auth.ts
│   ├── search-console.ts
│   ├── bing-auth.ts
│   └── bing-webmaster.ts
└── tools/
    ├── search.ts
    └── gsc.ts
```

The exact file split may follow the repository's implementation style, but provider authentication, upstream clients, normalization, and MCP registration should remain independently testable.

## Public provider identifier
Unified search tools use:

```ts
type SearchProvider = "gsc" | "bing";
```

The short values are intentional: the tool names already establish the search-analytics domain, and the enum remains easy for MCP clients to select reliably.

## Unified MCP tool surface

### `search_list_sites`
Lists sites available through one provider.

Input:

```ts
{
  provider: "gsc" | "bing"
}
```

Normalized site result:

```ts
{
  siteUrl: string;
  verified?: boolean;
  permissionLevel?: string;
}
```

Provider mapping:
- GSC: Search Console `sites.list`.
- Bing: `GetUserSites`.

### `search_overview`
Returns a bounded daily search-performance time series for one site.

Input:

```ts
{
  provider: "gsc" | "bing";
  siteUrl: string;
  startDate: "YYYY-MM-DD";
  endDate: "YYYY-MM-DD";
}
```

Provider mapping:
- GSC: Search Analytics query with date dimension and no query/page dimension.
- Bing: `GetRankAndTrafficStats`, followed by local date filtering to the provider-returned available range.

### `search_queries`
Returns top query performance for a site over the requested range.

Input:

```ts
{
  provider: "gsc" | "bing";
  siteUrl: string;
  startDate: "YYYY-MM-DD";
  endDate: "YYYY-MM-DD";
  limit?: number;
}
```

Provider mapping:
- GSC: Search Analytics query with `query` dimension.
- Bing: `GetQueryStats`, then filter/aggregate returned dated rows to the requested range.

### `search_pages`
Returns top page performance for a site over the requested range.

Input is the same shape as `search_queries`.

Provider mapping:
- GSC: Search Analytics query with `page` dimension.
- Bing: `GetPageStats`, then filter/aggregate returned dated rows to the requested range.

### `search_page_queries`
Returns query performance for one page.

Input:

```ts
{
  provider: "gsc" | "bing";
  siteUrl: string;
  page: string;
  startDate: "YYYY-MM-DD";
  endDate: "YYYY-MM-DD";
  limit?: number;
}
```

Provider mapping:
- GSC: Search Analytics query with a page filter and query dimension.
- Bing: `GetPageQueryStats`.

### `search_query_pages`
Returns page performance for one query.

Input:

```ts
{
  provider: "gsc" | "bing";
  siteUrl: string;
  query: string;
  startDate: "YYYY-MM-DD";
  endDate: "YYYY-MM-DD";
  limit?: number;
}
```

Provider mapping:
- GSC: Search Analytics query with a query filter and page dimension.
- Bing: `GetQueryPageStats`.

## Provider-specific tools
Some provider capabilities are not semantically equivalent and should not be forced into the common surface.

Keep or add provider-specific tools only where needed, including:

- `gsc_url_inspection` for Google URL Inspection.

The planned `gsc_search_analytics` and `gsc_list_sites` tools should not become the primary public contracts if the unified tools are implemented first. Because those tools are not currently shipped on `main`, no backward-compatibility alias is required.

## Normalized metric model
Common performance rows use a stable shape:

```ts
type SearchPerformanceRow = {
  date?: string;
  query?: string;
  page?: string;
  clicks: number;
  impressions: number;
  ctr: number;
  avgPosition?: number;
  avgClickPosition?: number;
};
```

Semantics:
- `ctr` is represented as a ratio in the range `0..1` and is derived as `clicks / impressions` when the provider does not return it directly.
- `avgPosition` maps to Search Console `position` for GSC and Bing `AvgImpressionPosition` for Bing.
- `avgClickPosition` is optional and is populated from Bing `AvgClickPosition` when available; it is omitted for GSC.
- Missing metrics remain absent rather than being invented as zero unless zero is the provider's actual value.

Position metrics are provider-native measurements. The service SHALL NOT claim that a GSC average position and Bing average impression position are directly interchangeable ranking measurements.

## Aggregation rules
When an upstream API returns multiple dated rows that need to be summarized across a requested period:

- clicks = sum of clicks
- impressions = sum of impressions
- CTR = total clicks / total impressions
- average impression position = impression-weighted average of available position values
- average click position = click-weighted average of available click-position values

Rows with no usable weight SHALL NOT distort weighted averages. The implementation should keep aggregation logic in the shared normalization layer and cover it with deterministic unit tests.

## Response envelope and freshness
All unified search tools return structured content with provider metadata rather than bare row arrays.

Logical shape:

```ts
{
  provider: "gsc" | "bing";
  siteUrl?: string;
  requestedRange?: {
    startDate: string;
    endDate: string;
  };
  effectiveRange?: {
    startDate: string;
    endDate: string;
  };
  dataThrough?: string;
  freshness: {
    cadence: "provider-defined" | "daily" | "weekly";
    complete: boolean | "unknown";
    note?: string;
  };
  rows: SearchPerformanceRow[];
  truncated: boolean;
}
```

Bing query/page statistics are documented as updating weekly, so the Bing adapter should report weekly/provider-defined freshness rather than pretending that recent dates have GSC-like completeness. `dataThrough` should be derived from the newest returned source date when available.

A requested range outside the rows made available by a provider is not silently treated as a complete zero-traffic period. The response should expose the effective range and completeness as unknown/partial where appropriate.

## Bing API client
Use Microsoft's supported HTTPS JSON/HTTP surface. Current Microsoft documentation demonstrates the JSON methods under:

```text
https://www.bing.com/webmaster/api.svc/json/<METHOD>
```

or the documented equivalent Bing host. Implementation tests must confirm the currently supported production host before considering the integration complete.

Do not implement SOAP or POX. Microsoft retired the legacy SOAP/POX protocols on 2026-08-31. Upstream method names are isolated inside `bing-webmaster.ts` so a future Microsoft endpoint migration does not require changing MCP tool contracts.

Initial read-only methods:

```text
GetUserSites
GetRankAndTrafficStats
GetQueryStats
GetPageStats
GetPageQueryStats
GetQueryPageStats
```

No generic method-name passthrough is exposed to MCP clients.

## Bing OAuth 2.0
Use Bing Webmaster OAuth 2.0 because Microsoft recommends OAuth and the service should use least-privilege delegated read access.

Request only:

```text
webmaster.read
```

Do not request `webmaster.manage` for this read-only service.

Store one Secrets Store JSON document under a binding such as `BING_WEBMASTER_OAUTH_CREDENTIALS`:

```json
{
  "client_id": "...",
  "client_secret": "...",
  "refresh_token": "...",
  "token_uri": "https://www.bing.com/webmasters/oauth/token",
  "scope": "webmaster.read"
}
```

The initial user-consent/bootstrap flow may be performed out of band. Runtime behavior only needs to exchange the refresh token for short-lived access tokens. Credential contents and refresh tokens must never be returned or logged. Access tokens remain runtime-only and may be reused within an isolate only until safely before expiry.

API-key authentication remains out of scope for the normal production path. Adding it later requires an explicit design decision so the project does not accumulate multiple credential models without need.

## GSC adapter
The GSC adapter continues using the project's existing Google OAuth credential policy. It maps the provider-neutral intents onto Search Console APIs instead of exposing the raw Google request schema directly.

The adapter may keep an internal generic Search Analytics client for implementation reuse, but the MCP-facing tools remain intent-specific and bounded.

`gsc_url_inspection` remains a separate provider-specific tool because Bing's index inspection capabilities do not have an identical contract.

## Validation and bounds
- `siteUrl`, `page`, and date inputs must be valid bounded strings.
- `startDate <= endDate`.
- Date range must have a configured maximum; initial default SHOULD be no more than 16 months unless a provider-specific lower limit requires less.
- `limit` uses a safe default and hard maximum; initial values SHOULD be `100` default and `1000` maximum.
- Provider adapters may clamp to a lower upstream limit but must report truncation.
- Page/query filters are exact-match by default. Do not introduce regex or arbitrary provider filter expressions in the first version.

## Errors
Return safe, categorized errors without raw upstream bodies or credentials. At minimum distinguish:

- validation failure
- provider authentication/authorization failure
- site unavailable/not accessible
- upstream throttling/quota failure
- provider service failure
- requested range not available from returned provider data

Error messages may contain provider name, operation, and safe HTTP/status context, but never OAuth credentials, bearer tokens, Access assertions, or private analytics rows unrelated to the request.

## Observability
Log only safe operational metadata:
- provider
- normalized operation name
- latency
- success/failure class
- returned row count
- truncated flag

Do not log queries, pages, row payloads, refresh tokens, access tokens, or raw provider responses by default.

## OpenAPI impact
This change adds MCP tools only. It does not add or modify the HTTP route/method/auth/media-type surface, so `openapi.yaml` does not need a semantic route change. If implementation changes `/mcp`, `/health`, or another HTTP contract, update OpenAPI in that same implementation change.

## Testing strategy
Use mocked upstream HTTP and deterministic fixtures. Tests should cover:

- Bing OAuth refresh exchange and expiry handling.
- Bearer-token attachment without token leakage.
- Bing JSON wrapper parsing and Microsoft date conversion.
- Each initial Bing method mapping.
- GSC and Bing adapter mapping into the same normalized contracts.
- weighted position aggregation and derived CTR.
- date-range filtering, effective range, and freshness metadata.
- safe defaults and hard row limits.
- validation failure before upstream calls.
- upstream 401/403, throttling, malformed payload, and 5xx handling.
- MCP tool registration and input/output schemas.

Live production verification should be separate from unit tests and must not use committed credentials.