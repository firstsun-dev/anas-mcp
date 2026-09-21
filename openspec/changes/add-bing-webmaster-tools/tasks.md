# Tasks: Bing Webmaster ingestion and PostgreSQL serving

## Architecture
- [x] Record Bing as an analytics source.
- [x] Record REST/JSON-only provider access and prohibit legacy SOAP/POX.
- [x] Record write operations as out of scope.
- [x] Record the architectural change from direct Worker access to Windmill ingestion + PostgreSQL serving.
- [x] Record `bing_url_info` as deferred from the initial implementation.
- [x] Record the live `ErrorCode: 17 / ThrottleIP` observation that motivated the ingestion boundary.

## Windmill credential and provider ownership
- [ ] Move/remove Bing provider credential ownership from `anas-mcp`.
- [ ] Configure the Bing Webmaster API key in the protected Windmill credential path.
- [ ] Ensure the credential is never written to PostgreSQL, logs, raw payloads, or MCP output.
- [ ] Verify rotation can occur without deploying `anas-mcp`.

## PostgreSQL migration
- [ ] Add a Windmill-owned migration for Bing fetch-run/provenance storage.
- [ ] Add a normalized Bing site read model.
- [ ] Add a normalized Bing query/page search-performance read model.
- [ ] Define indexes/constraints for site, dimension, stat date, and latest-success lookup.
- [ ] Ensure failed/throttled runs cannot masquerade as successful/fresh data.
- [ ] Add migration tests/verification using the repository's normal Atlas workflow.

## Windmill ingestion
- [ ] Implement a scheduled Bing sync job in `firstsun-dev/windmill-flows`.
- [ ] Fetch authorized sites with `GetUserSites`.
- [ ] Fetch query statistics with `GetQueryStats`.
- [ ] Fetch page statistics with `GetPageStats`.
- [ ] Classify HTTP 400 / `ErrorCode: 17 / ThrottleIP` as provider throttling.
- [ ] Add bounded exponential backoff/retry behavior.
- [ ] Persist failed/throttled fetch-run evidence without replacing the last successful dataset.
- [ ] Preserve safe raw/fetch-run evidence sufficient for reprocessing.
- [ ] Normalize provider rows into PostgreSQL.
- [ ] Add deterministic mocked tests for provider responses, throttling, malformed data, normalization, and secret redaction.
- [ ] Run the sync against a real authorized Bing site from the Windmill runtime and record sanitized evidence.

## anas-mcp data access
- [ ] Remove direct Bing HTTP/provider client code from the Worker.
- [ ] Remove `BING_WEBMASTER_TOKEN` / Bing Secrets Store binding from `anas-mcp`.
- [ ] Add/read the existing read-only Hyperdrive binding used for analytics PostgreSQL.
- [ ] Implement constrained parameterized PostgreSQL query paths for Bing.
- [ ] Implement `bing_list_sites` from the PostgreSQL read model.
- [ ] Implement `bing_search_performance` from the PostgreSQL read model.
- [ ] Remove/defer `bing_url_info` from the initial registered MCP surface.
- [ ] Add bounded inputs/outputs and date/site validation.
- [ ] Return `fetchedAt`, `dataThrough`, and staleness metadata.
- [ ] Ensure no generic SQL execution tool is introduced.

## Tests
- [ ] Add repository/query-layer tests for latest-success selection.
- [ ] Add site-list bounds and safe-field tests.
- [ ] Add query/page search-performance filtering and pagination tests.
- [ ] Add freshness/staleness metadata tests.
- [ ] Add no-data-yet and database-failure tests.
- [ ] Add tests proving no direct Bing fetch/API-key code remains in `anas-mcp`.
- [ ] Add tests proving `bing_url_info` is not exposed in the initial tool list.

## Verification
- [ ] Run `npm run check` in `anas-mcp`.
- [ ] Validate the resulting MCP tool list with MCP Inspector.
- [ ] Verify `bing_list_sites` reads persisted Windmill-ingested data.
- [ ] Verify query and page dimensions against a real ingested dataset.
- [ ] Verify a throttled Windmill fetch leaves the last successful MCP dataset available and reports correct freshness.
- [ ] Verify production MCP access still passes through Cloudflare Access Managed OAuth.

## Superseded implementation evidence
The earlier direct-Worker implementation demonstrated that the Worker could read the Cloudflare-bound Bing secret and reach Bing, but the provider returned HTTP 400 `{"ErrorCode":17,"Message":"ERROR!!! ThrottleIP"}` from Cloudflare egress. That direct provider implementation is now superseded by this ingestion architecture and must not be merged as the final runtime design.
