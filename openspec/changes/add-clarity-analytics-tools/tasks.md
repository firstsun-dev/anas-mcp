# Tasks: Clarity read-only MCP tools

## Contract
- [x] Read the windmill-flows ingestion code and migration (`clarity_sync.py`, `clarity_reprocess.py`, schedule, migration) and record the verified schema in `design.md`.
- [ ] Verify the production `project_key` value(s) against the live database / Windmill variable and set `CLARITY_PROJECT_KEYS` (operator step; see `docs/clarity.md`).
- [ ] Confirm which query keys have successful production ingestion (`site_overall`, `page`, `page_device`, `acquisition`, `page_source`).

## Implementation
- [x] Extract shared Hyperdrive read-only runner (`sql-session.ts`); Bing tests unchanged and green.
- [x] `ClarityAnalyticsRepository` with canonical run selection, project allowlist, page normalization.
- [x] Tools `clarity_overview`, `clarity_pages`, `clarity_acquisition`, `clarity_page` registered with read-only annotations.
- [x] `health` reports `enabledSources` vs `plannedSources`.
- [x] Gate 2: bounded per-group/overall detail SQL, `sourceTruncated` vs `responseTruncated` vs `responseComplete`, `metricsTruncated`/`metricRowTotal`, `nextOffset`; unit + real-SQL tests for >500-row ingestions and oversized single groups.
- [x] No HTTP surface change; `openapi.yaml` untouched.

## Verification
- [x] Unit tests (`tests/clarity-analytics.test.ts`) and MCP contract tests (`tests/clarity-mcp.test.ts`).
- [x] Real-SQL integration tests (`tests/clarity-postgres.integration.test.ts`) run against PostgreSQL 16 with the windmill-flows migration (run selection, failed-newer fallback, truncation, empty-newest fallback, project isolation, null preservation, pagination order, read-only enforcement).
- [ ] MCP Inspector against `wrangler dev` with a seeded local database.
- [ ] Production verification through Cloudflare Access once `CLARITY_PROJECT_KEYS` is set (not claimed; ChatGPT compatibility untested).

## Deferred
- `technology` / `geo_device` tools; per-day history; GA4 (Phase 2); Search Console (Phase 3).
