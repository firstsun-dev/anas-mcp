# Tasks: Bing Webmaster ingestion and PostgreSQL serving

## Architecture
- [x] Record Bing as an analytics source.
- [x] Record REST/JSON-only provider access and prohibit legacy SOAP/POX.
- [x] Record write operations as out of scope.
- [x] Record the architectural change from direct Worker access to Windmill ingestion + PostgreSQL serving.
- [x] Record `bing_url_info` as deferred from the initial implementation.
- [x] Record the live `ErrorCode: 17 / ThrottleIP` observation that motivated the ingestion boundary.

## Windmill credential and provider ownership
- [x] Move/remove Bing provider credential ownership from `anas-mcp`.
- [ ] Configure the Bing Webmaster API key in the protected Windmill credential path.
- [x] Ensure the credential is never written to PostgreSQL, logs, raw payloads, or MCP output.
- [ ] Verify rotation can occur without deploying `anas-mcp`.

## PostgreSQL migration
- [x] Add a Windmill-owned migration for Bing fetch-run/provenance storage.
- [x] Add a normalized Bing site read model.
- [x] Add a normalized Bing query/page search-performance read model.
- [x] Define indexes/constraints for site, dimension, stat date, and latest-success lookup.
- [x] Ensure failed/throttled runs cannot masquerade as successful/fresh data.
- [ ] Add migration tests/verification using the repository's normal Atlas workflow.

## Windmill ingestion
- [x] Implement a scheduled Bing sync job in `firstsun-dev/windmill-flows`.
- [x] Fetch authorized sites with `GetUserSites`.
- [x] Fetch query statistics with `GetQueryStats`.
- [x] Fetch page statistics with `GetPageStats`.
- [x] Classify HTTP 400 / `ErrorCode: 17 / ThrottleIP` as provider throttling.
- [x] Add bounded exponential backoff/retry behavior.
- [x] Persist failed/throttled fetch-run evidence without replacing the last successful dataset.
- [x] Preserve safe raw/fetch-run evidence sufficient for reprocessing.
- [x] Normalize provider rows into PostgreSQL.
- [x] Add deterministic mocked tests for provider responses, throttling, malformed data, normalization, and secret redaction.
- [ ] Run the sync against a real authorized Bing site from the Windmill runtime and record sanitized evidence.

## anas-mcp data access
- [x] Remove direct Bing HTTP/provider client code from the Worker.
- [x] Remove `BING_WEBMASTER_TOKEN` / Bing Secrets Store binding from `anas-mcp`.
- [x] Add/read the existing read-only Hyperdrive binding used for analytics PostgreSQL.
- [x] Implement constrained parameterized PostgreSQL query paths for Bing.
- [x] Implement `bing_list_sites` from the PostgreSQL read model.
- [x] Implement `bing_search_performance` from the PostgreSQL read model.
- [x] Remove/defer `bing_url_info` from the initial registered MCP surface.
- [x] Add bounded inputs/outputs and date/site validation.
- [x] Return `fetchedAt`, `dataThrough`, and staleness metadata.
- [x] Ensure no generic SQL execution tool is introduced.

## Tests
- [x] Add repository/query-layer tests for latest-success selection.
- [x] Add site-list bounds and safe-field tests.
- [x] Add query/page search-performance filtering and pagination tests.
- [x] Add freshness/staleness metadata tests.
- [x] Add no-data-yet and database-failure tests.
- [x] Add tests proving no direct Bing fetch/API-key code remains in `anas-mcp`.
- [x] Add tests proving `bing_url_info` is not exposed in the initial tool list.

## Verification
- [x] Run `npm run check` in `anas-mcp`.
- [ ] Validate the resulting MCP tool list with MCP Inspector.
- [ ] Verify `bing_list_sites` reads persisted Windmill-ingested data.
- [ ] Verify query and page dimensions against a real ingested dataset.
- [ ] Verify a throttled Windmill fetch leaves the last successful MCP dataset available and reports correct freshness.
- [ ] Verify production MCP access still passes through Cloudflare Access Managed OAuth.

## Superseded implementation evidence
The earlier direct-Worker implementation demonstrated that the Worker could read the Cloudflare-bound Bing secret and reach Bing, but the provider returned HTTP 400 `{"ErrorCode":17,"Message":"ERROR!!! ThrottleIP"}` from Cloudflare egress. That direct provider implementation is now superseded by this ingestion architecture and must not be merged as the final runtime design.

## Implementation evidence (2026-09-21)
- **Windmill (`firstsun-dev/windmill-flows`, branch `feat/bing-webmaster-ingestion`, Issue #10):** forward-only migration `20260921030000_blog_analytics_bing.sql` (`bing_fetch_runs`, `bing_sites`, `bing_search_stats`, views `bing_latest_sites`, `bing_latest_search_runs`, `bing_latest_search_stats`). `atlas migrate hash`/`validate` pass and the full migration history applies cleanly to a scratch PostgreSQL 16. `f/blog_analytics/bing_webmaster_sync.py` runs daily (`0 30 2 * * *`, Asia/Taipei), sequentially, with 3 attempts and jittered exponential backoff. 199 tests pass, including persistence tests against real PostgreSQL. The secret is mapped through `secrets.blog_analytics.map` as `f/blog_analytics/bing_webmaster_api_key`; the value is **not** provisioned yet.
- **anas-mcp:** `npm run check` passes (typecheck + tests). Repository SQL was also exercised against real PostgreSQL through a role granted `SELECT` on only the three `bing_latest_*` views (`BING_TEST_DATABASE_URL`, `tests/bing-postgres.integration.test.ts`): latest-success selection over a newer throttled run, `dataThrough`, date filter, pagination, `data_unavailable`, and denial of base-table reads.
- **Staleness threshold:** `stale = true` when the served run was fetched more than 72h ago. Ingestion is daily and Bing refreshes weekly, so a healthy dataset is <24h old; 72h tolerates two consecutive failed/throttled daily runs plus skew. `stale = "unknown"` when `fetchedAt` is missing/unparseable.
- **Not verified yet:** live Bing ingestion (no API key available in the implementation environment), MCP Inspector, production migration/Hyperdrive, and Access. The Hyperdrive `id` in `wrangler.jsonc` is a placeholder the operator must replace; the Hyperdrive PostgreSQL role needs `USAGE` on schema `blog_analytics` and `SELECT` on the three `bing_latest_*` views only.
