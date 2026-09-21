# Proposal: ingest Bing Webmaster analytics through Windmill

## Why
Firstsun needs Bing search-performance visibility alongside GA4, Google Search Console, and Clarity, but direct request-time Bing access from Cloudflare Workers has proven operationally fragile. A live Worker call reached Bing successfully with the configured API key but returned `ErrorCode: 17 / ThrottleIP`, demonstrating that Cloudflare egress IP throttling can make MCP availability depend on the provider's IP-rate-limit behavior.

Bing search-performance data is also provider-refreshed on a relatively slow cadence, so request-time API access provides little freshness benefit while adding latency, quota, egress-IP, and provider-availability risk.

The integration should therefore follow the same separation already used for Clarity: scheduled ingestion in `firstsun-dev/windmill-flows`, persistence in PostgreSQL, and read-only serving from `anas-mcp` through Cloudflare Hyperdrive.

## What changes
- Move Bing Webmaster API ownership from `anas-mcp` to `firstsun-dev/windmill-flows`.
- Store the Bing Webmaster provider token/API key with the Windmill ingestion runtime rather than in `anas-mcp` Cloudflare Secrets Store.
- Add scheduled, bounded Bing ingestion that preserves fetch-run evidence and normalizes search-performance rows into PostgreSQL.
- Make PostgreSQL the serving source for Bing MCP tools.
- Keep `anas-mcp` read-only and query Bing data through Hyperdrive using constrained parameterized SQL.
- Keep `bing_list_sites` and `bing_search_performance` as the initial MCP surface.
- Defer `bing_url_info` from the initial scope because arbitrary URL lookup is inherently request-driven and would reintroduce provider throttling if naively proxied.
- Expose freshness metadata so callers can distinguish stored Bing data from request-time provider data.
- Preserve the existing prohibition on Bing write operations and legacy SOAP/POX integrations.

## Scope

### In scope
- Windmill-owned Bing API credential and provider calls.
- Scheduled site/query/page statistics ingestion.
- Raw-first or equivalent fetch-run evidence sufficient to diagnose provider failures and safely reprocess normalization.
- PostgreSQL normalized read model under the existing analytics database/schema convention.
- Hyperdrive-backed read-only MCP queries.
- Bounded `bing_list_sites` and `bing_search_performance` responses.
- Freshness metadata such as last successful fetch time and newest provider data date.
- Explicit handling of provider throttling, including `ErrorCode: 17 / ThrottleIP`, in the ingestion layer.

### Out of scope
- Direct Bing Webmaster API calls from `anas-mcp`.
- A Bing API credential in `anas-mcp` Cloudflare Secrets Store.
- `bing_url_info` in the initial MCP implementation.
- On-demand Windmill-to-Bing calls from MCP requests.
- URL submission, Sitemap mutation, site configuration, or other Bing write operations.
- Legacy SOAP or POX integrations.
- Treating unavailable/stale provider data as fresh or fabricating zero-valued rows.

## Success criteria
- Bing provider failures or IP throttling do not make normal MCP reads fail when previously ingested data is available.
- `anas-mcp` has no Bing provider credential and does not call Bing directly.
- Windmill owns the Bing credential, retries/backoff, provider parsing, and persistence.
- PostgreSQL contains enough provenance to identify the latest successful Bing fetch and the data date represented by normalized rows.
- `bing_list_sites` and `bing_search_performance` read only from PostgreSQL through Hyperdrive.
- MCP responses are bounded and include freshness metadata.
- `bing_url_info` remains deferred until a separate accepted design defines caching/on-demand behavior without recreating the current throttling risk.
