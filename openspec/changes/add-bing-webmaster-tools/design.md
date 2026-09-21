# Design: Bing Webmaster ingestion and PostgreSQL read model

## Runtime model
Bing Webmaster Tools is **not** queried by `anas-mcp` at MCP request time.

The architecture is:

```text
Scheduled Windmill job
        |
        | Bing Webmaster API key
        v
Bing Webmaster REST/JSON API
        |
        | raw/fetch-run evidence + normalized rows
        v
PostgreSQL (blog_analytics)
        ^
        |
Cloudflare Hyperdrive
        ^
        |
anas-mcp
        ^
        |
ChatGPT / MCP client
```

This separates provider ingestion from query serving. Bing throttling, retries, provider latency, and upstream outages are ingestion concerns; normal MCP reads use the latest successfully persisted data.

A live Cloudflare Worker attempt on 2026-09-21 reached Bing but received HTTP 400 with:

```json
{"ErrorCode":17,"Message":"ERROR!!! ThrottleIP"}
```

That observation is architectural evidence for moving Bing provider calls away from Cloudflare Worker request paths.

## Ownership boundaries

### `firstsun-dev/windmill-flows`
Owns:
- Bing Webmaster API key/token.
- Bing REST/JSON requests.
- rate-limit handling, including `ThrottleIP`.
- retry/backoff policy.
- scheduled ingestion.
- raw/fetch-run evidence.
- normalization and PostgreSQL writes.
- schema migrations required for the Bing read model.

### `firstsun-dev/anas-mcp`
Owns:
- read-only Hyperdrive access.
- constrained SQL/query repository logic.
- MCP input validation.
- bounded response shaping.
- freshness metadata returned to clients.

`anas-mcp` SHALL NOT own or bind the Bing Webmaster provider credential.

## Ingestion cadence
Bing search-performance data does not require per-request refresh.

Default behavior:
- run no more frequently than daily unless provider behavior demonstrates a need for a different cadence;
- one scheduled job may cover all enabled/authorized sites;
- failed/throttled runs must be observable and must not overwrite the last successful normalized dataset as though it were fresh.

The exact schedule is an operational Windmill setting and does not change the MCP contract.

## Provider contract
Windmill should use the Microsoft-supported REST/JSON interface current at implementation time.

Initial read operations:
- `GetUserSites`
- `GetQueryStats`
- `GetPageStats`

Legacy SOAP/POX interfaces remain prohibited.

Observed live provider failure:
- HTTP 400
- `ErrorCode: 17`
- `Message: ERROR!!! ThrottleIP`

The ingestion layer should classify that as provider throttling/rate limiting and apply bounded retry/backoff rather than treating it as an invalid credential.

## Credential ownership
The Bing Webmaster API key belongs to the Windmill ingestion service because Windmill is the component that consumes it.

Rules:
- do not store the Bing API key in `anas-mcp` Cloudflare Secrets Store;
- do not bind `BING_WEBMASTER_TOKEN` to the Worker;
- do not copy the key into PostgreSQL, logs, analytics payloads, or MCP responses;
- store the credential using the protected Windmill/GitHub-to-Windmill credential convention already used by other ingestion pipelines;
- rotate the Windmill-owned credential independently from `anas-mcp` deployment.

Google GA4/Search Console credentials remain unrelated and continue to use `anas-mcp` Cloudflare Secrets Store because those APIs are still queried directly by the Worker.

## PostgreSQL model
Follow the existing `blog_analytics` ingestion pattern used by Clarity: preserve provider-fetch evidence and derive normalized query-serving rows.

The exact migration belongs in `firstsun-dev/windmill-flows`, but the logical contract should provide equivalent concepts to:

### Fetch runs
A source-of-truth/fetch-run table, logically similar to:

```text
blog_analytics.bing_fetch_runs
```

Useful fields include:
- fetch run id
- site URL / operation
- scheduled/fetched timestamps
- status
- HTTP status
- provider error code/class
- safe error message
- row count
- payload hash
- raw payload or an equivalent immutable raw-storage reference
- normalizer version where applicable

Raw payload storage must never contain the API key.

### Site read model
A normalized site read model, logically similar to:

```text
blog_analytics.bing_sites
```

It should expose only safe fields required by MCP, such as:
- site URL
- verified status when available
- source fetch id
- fetched timestamp

Verification/authentication codes from Bing must not be exposed.

### Search-performance read model
A normalized table, logically similar to:

```text
blog_analytics.bing_search_stats
```

Logical fields:
- source fetch id
- site URL
- dimension: `query | page`
- key: query text or page URL
- provider stat date
- impressions
- clicks
- average click position
- average impression position
- fetched timestamp

A view or constrained query SHOULD make it straightforward for `anas-mcp` to select only rows belonging to the latest successful dataset for a site/dimension.

## Freshness contract
Because Bing data is ingested asynchronously, MCP responses must expose freshness.

At minimum `bing_search_performance` should return metadata equivalent to:

```ts
{
  fetchedAt: string | null;
  dataThrough: string | null;
  stale: boolean | "unknown";
}
```

Semantics:
- `fetchedAt`: timestamp of the latest successful ingestion represented by the result.
- `dataThrough`: newest provider stat date in the returned/current dataset when known.
- `stale`: based on a documented service threshold, or `"unknown"` when freshness cannot be established safely.

Do not interpret missing/newer dates as zero traffic.

## Initial MCP tools

### `bing_list_sites`
Reads the normalized site read model through Hyperdrive.

Constraints:
- read-only
- bounded result count
- no verification/authentication codes
- include latest ingestion timestamp when useful

### `bing_search_performance`
Reads normalized query/page statistics through Hyperdrive.

Inputs may include:
- `siteUrl`
- `dimension: query | page`
- `startDate`
- `endDate`
- bounded `limit`
- bounded `offset`

Constraints:
- validate inputs before SQL execution
- use parameterized predefined query paths
- return bounded rows
- preserve separate Bing click/impression position semantics
- return freshness metadata
- never accept arbitrary SQL

### `bing_url_info`
Deferred from the initial implementation.

Reason:
- `GetUrlInfo` is naturally an arbitrary URL lookup rather than a bulk analytics feed;
- proxying it directly from `anas-mcp` recreates Cloudflare egress/IP-throttle risk;
- pre-fetching every site URL would create unnecessary provider traffic.

A future accepted OpenSpec change may add URL information using a bounded cache, curated URL ingestion, or an on-demand Windmill workflow with explicit rate-limit/caching behavior.

## Failure behavior
- A failed Windmill fetch must be recorded as a failed/throttled run.
- Failed ingestion must not delete or silently replace the last successful read model.
- MCP reads should continue serving the latest successful data when available.
- MCP should surface freshness/staleness metadata rather than the upstream Bing error for historical stored reads.
- If no successful dataset exists, the MCP tool should return a safe data-unavailable error.
- Database failures should be normalized separately from provider-ingestion freshness.

## Observability
Windmill may log only safe operational metadata:
- operation
- site identifier if policy allows
- latency
- HTTP status class
- provider error code/class
- result count
- retry count

Do not log the API key or raw request URL containing `apikey`.

`anas-mcp` should log only safe database/query operation metadata and bounded result counts, not row payloads by default.

## Write operations
The integration remains read-only end to end from the MCP perspective.

Adding URL submission, Sitemap mutation, site configuration changes, or another Bing write operation requires a separate accepted OpenSpec change.

## OpenAPI impact
This architecture changes only backend data sourcing for MCP tools. It adds no HTTP route or method, so `openapi.yaml` does not require a route-level change.
