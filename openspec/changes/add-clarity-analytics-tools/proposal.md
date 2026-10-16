# Proposal: Microsoft Clarity read-only MCP tools (Phase 1)

Tracking issue: firstsun-dev/anas-mcp#13

## Why
`firstsun-dev/windmill-flows` already ingests Microsoft Clarity Data Export aggregates into `blog_analytics.clarity_fetch_runs` / `clarity_metric_rows`, but ChatGPT and other MCP clients cannot read them. Clarity's API is quota-limited (10 requests/day) and aggregate-only, so it must be served from PostgreSQL, never called from the Worker.

## What changes
- Add `src/services/clarity-analytics.ts` (read repository) and `src/tools/clarity.ts` with four read-only MCP tools: `clarity_overview`, `clarity_pages`, `clarity_acquisition`, `clarity_page`.
- Extract the Hyperdrive read-only session runner into `src/services/sql-session.ts`, shared by Bing and Clarity (behavior unchanged).
- Add the non-secret `CLARITY_PROJECT_KEYS` allowlist; Clarity tools fail closed (`missing_configuration`) until it is set.
- `health` gains `enabledSources` and keeps `plannedSources` (now `ga4`, `search-console`).

## Out of scope
GA4 and Search Console (separate phases), any Clarity API call, generic SQL tools, new credentials, schema/migration changes, HTTP surface or `openapi.yaml` changes, auth or CI/CD changes.
