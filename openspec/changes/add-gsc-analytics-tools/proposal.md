# Proposal: Google Search Console read-only MCP tools (Phase 3)

Tracking issue: firstsun-dev/anas-mcp#16

## Why
GA4, Bing and Clarity are live. Search Console (organic queries, pages, clicks, impressions, CTR, average position) is the remaining planned source. Phase 2 built the shared Google OAuth token provider, which already supports `webmasters.readonly`.

## What changes
- `src/services/google-search-console.ts`: fixed-endpoint Search Console API client (`sites.list`, `searchAnalytics.query`), property allowlist parsing, Pacific-time date resolution, bounded retry/timeout/response size, sanitized error mapping.
- `src/tools/google-search-console.ts`: `gsc_list_sites`, `gsc_search_analytics`.
- Non-secret `GSC_ALLOWED_SITES` (JSON string array of exact Search Console property identifiers). **Not set in `wrangler.jsonc`**: GSC stays disabled in production until the operator supplies verified identifiers.
- `server.ts`: reuse the single `GoogleTokenProvider`; `health` lists `search-console` as enabled only when the credential binding and a valid allowlist exist, otherwise planned.
- Tests with mocked Google only; `docs/gsc.md`; README, credentials and guardrail updates.

## Out of scope
`gsc_url_inspection` (separate accepted design), any new Google credential/OAuth client/scope, Cloudflare Access changes, `openapi.yaml` (no HTTP surface change), CI/CD, guessing production property identifiers, sitemaps or any write endpoint.

## Operator prerequisites (activation is gated on these)
Enable the Search Console API in the Google Cloud project; confirm the existing refresh token includes `webmasters.readonly`; confirm the authorized account can access each property; set `GSC_ALLOWED_SITES` to verified identifiers. See `docs/gsc.md`.
