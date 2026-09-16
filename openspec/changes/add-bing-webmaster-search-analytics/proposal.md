# Proposal: add Bing Webmaster search analytics

## Why
`anas-mcp` needs first-party Bing Webmaster Tools data so ChatGPT can analyze Bing search performance without relying on a paid third-party SEO app. The existing project already plans direct Google Search Console access, but the current tool naming is provider-specific (`gsc_search_analytics`). Adding Bing as another independent provider-specific tool family would make cross-engine analysis harder and would expose upstream API differences directly to MCP clients.

This change adds Bing Webmaster as a direct read-only datasource and introduces a provider-neutral search analytics tool surface shared by Google Search Console and Bing Webmaster. The goal is to let clients ask the same questions—site overview, top queries, top pages, page-to-query drilldown, and query-to-page drilldown—while the service handles provider-specific API mapping and data normalization.

## What changes
- Add direct Bing Webmaster Tools access to `anas-mcp` using Microsoft's supported JSON/HTTP API surface over HTTPS.
- Use Bing Webmaster OAuth 2.0 with the minimum read-only scope (`webmaster.read`).
- Store the Bing OAuth client credential and refresh token as one Secrets Store JSON binding; derived access tokens remain runtime-only.
- Do not use the retired SOAP or POX transports.
- Add a provider adapter boundary for search analytics with `gsc` and `bing` implementations.
- Replace the planned provider-specific `gsc_search_analytics` public surface with provider-neutral MCP tools before the GSC implementation ships.
- Keep provider-specific capabilities separate when there is no clean cross-provider equivalent; for example, Google URL Inspection remains `gsc_url_inspection`.
- Normalize common metrics such as clicks, impressions, CTR, date, query, page, and average position while preserving Bing's optional average click position.
- Return source freshness metadata so clients do not assume Google and Bing have the same update cadence or completeness.
- Keep all search analytics operations read-only and bounded.

## Initial Bing API coverage
The first implementation SHALL cover the Bing Webmaster capabilities needed for search-performance analysis:

- `GetUserSites` — sites available to the authenticated Bing Webmaster account.
- `GetRankAndTrafficStats` — site-level traffic/rank time series.
- `GetQueryStats` — top query traffic statistics.
- `GetPageStats` — top page traffic statistics.
- `GetPageQueryStats` — queries associated with a specific page.
- `GetQueryPageStats` — pages associated with a specific query.

`GetQueryPageDetailStats` is intentionally deferred until repeated use shows that a separate query+page detail tool is needed. The provider service MAY implement it internally later without changing the public MCP surface if it can improve an existing normalized response without changing semantics.

## Scope
### In scope
- Bing Webmaster OAuth 2.0 read-only authentication.
- Bing Webmaster JSON/HTTP API client and response normalization.
- Provider-neutral MCP tools for search sites, overview, queries, pages, page queries, and query pages.
- GSC adapter mapping for the same provider-neutral tool contracts.
- Date-range filtering and result limits with provider capability metadata.
- Safe aggregation of common metrics when the upstream provider returns dated rows.
- Mocked tests for provider clients, normalization, error handling, and MCP tool contracts.
- Documentation of credential ownership and configuration.

### Out of scope
- Bing write operations such as URL submission, sitemap submission, site verification, crawl requests, or configuration changes.
- Bing `webmaster.manage` OAuth scope.
- API-key authentication as the normal production credential model.
- SOAP or POX Bing transports.
- Persisting Bing or GSC analytics into PostgreSQL, D1, KV, Durable Objects, or another warehouse.
- Cross-engine score/ranking formulas that claim Google and Bing positions are directly equivalent.
- A generic arbitrary Bing API passthrough tool.
- Replacing `gsc_url_inspection` with a fake cross-provider equivalent.
- New HTTP routes; the MCP transport remains `/mcp`.

## Success criteria
- ChatGPT can invoke the same search analytics tool names against either `gsc` or `bing` by selecting a provider.
- Bing calls use OAuth 2.0 read-only credentials from Cloudflare Secrets Store and never expose credential material in responses or logs.
- Search tools return predictable normalized rows and explicit provider/freshness metadata.
- Date ranges, limits, and filters are bounded and validated before upstream calls or local aggregation.
- GSC and Bing provider differences are handled inside adapters rather than leaking separate API method names into the primary MCP surface.
- No write-capable Bing method is exposed.
- No OpenAPI change is required unless the HTTP transport surface itself changes.