# Tasks: add Bing Webmaster and unified search analytics

## 1. Contract and configuration
- [x] Add the search-provider requirements as an OpenSpec delta under `openspec/changes/add-bing-webmaster-search-analytics/specs/analytics-mcp/spec.md`.
- [ ] Merge the accepted delta into `openspec/specs/analytics-mcp/spec.md` only when the change is accepted/archived according to the project OpenSpec workflow.
- [ ] Update `openspec/project.md` data-source strategy and roadmap to include Bing Webmaster and the provider-neutral search tool surface.
- [ ] Document `BING_WEBMASTER_OAUTH_CREDENTIALS` ownership and bootstrap procedure in `docs/credentials.md` without including real values.
- [x] Confirm the supported Bing Webmaster JSON/HTTP API and read-only OAuth model against current Microsoft documentation.
- [x] Confirm `webmaster.read` is the intended read-only OAuth scope; live verification remains required before marking the integration complete.

## 2. Shared search analytics domain
- [ ] Add shared provider/type definitions for `gsc | bing`.
- [ ] Add normalized site and `SearchPerformanceRow` types.
- [ ] Add common response envelope with requested/effective ranges, `dataThrough`, freshness, rows, and truncation metadata.
- [ ] Implement and unit-test CTR derivation and weighted position aggregation.
- [ ] Implement common validation for dates, site/page/query strings, limits, and exact-match drilldown inputs.

## 3. Bing OAuth service
- [ ] Add a Secrets Store binding for the Bing OAuth credential JSON without committing values or resource secrets.
- [ ] Validate required credential fields at runtime.
- [ ] Implement refresh-token exchange using the currently documented Bing Webmaster OAuth token endpoint.
- [ ] Request/use only `webmaster.read`; reject configuration that requires a write-capable scope for the read-only tools.
- [ ] Keep derived access tokens runtime-only and avoid logging token/credential content.
- [ ] Add mocked tests for successful refresh, expiry, 401/403, malformed token responses, and redaction.

## 4. Bing Webmaster client
- [ ] Implement a constrained JSON/HTTP client; do not implement SOAP, POX, or arbitrary method passthrough.
- [ ] Implement `GetUserSites`.
- [ ] Implement `GetRankAndTrafficStats`.
- [ ] Implement `GetQueryStats`.
- [ ] Implement `GetPageStats`.
- [ ] Implement `GetPageQueryStats`.
- [ ] Implement `GetQueryPageStats`.
- [ ] Parse Bing JSON wrappers and Microsoft date values into normalized internal values.
- [ ] Map Bing authentication, throttling, provider errors, and malformed responses into safe categorized service errors.
- [ ] Add mocked fixtures/tests for each method and error class.

## 5. Provider adapters
- [ ] Implement the Bing adapter for sites, overview, queries, pages, page queries, and query pages.
- [ ] Implement the GSC adapter using Search Console `sites.list` and Search Analytics queries/filters.
- [ ] Keep Google URL Inspection outside the common adapter as `gsc_url_inspection`.
- [ ] Verify both adapters produce the same normalized envelope for equivalent tool intents.
- [ ] Verify Bing freshness is reported as provider-defined/weekly where appropriate rather than GSC-like daily completeness.
- [ ] Verify unavailable date ranges are surfaced as partial/unknown instead of fabricated zero rows.

## 6. MCP tool registration
- [ ] Register `search_list_sites`.
- [ ] Register `search_overview`.
- [ ] Register `search_queries`.
- [ ] Register `search_pages`.
- [ ] Register `search_page_queries`.
- [ ] Register `search_query_pages`.
- [ ] Use bounded Zod input schemas with safe defaults and hard limits.
- [ ] Return structured content using the normalized response envelope plus concise text content where useful.
- [ ] Do not register `gsc_search_analytics`/`gsc_list_sites` as competing primary tools if the unified surface ships first.
- [ ] Do not expose Bing write methods or a generic Bing API passthrough.

## 7. Verification
- [ ] Run `npm install`.
- [ ] Run `npm run check` and record the result.
- [ ] Run all new unit tests with mocked upstream calls.
- [ ] Run the Worker locally and verify all unified tools with MCP Inspector.
- [ ] Verify invalid inputs fail before provider calls.
- [ ] Verify logs do not contain query/page row payloads or OAuth/Access secrets.
- [ ] Verify `openapi.yaml` remains correct because the HTTP transport surface is unchanged; if implementation changes the HTTP surface, update and validate OpenAPI in the same change.
- [ ] Perform an explicit live Bing smoke test with a verified site using non-committed credentials.
- [ ] Perform an explicit live GSC smoke test with an accessible Search Console property using non-committed credentials.
- [ ] Verify ChatGPT compatibility only after the deployed Cloudflare Access-protected MCP endpoint is tested end-to-end.

## 8. Documentation and completion evidence
- [ ] Update README datasource/tool documentation after implementation is verified.
- [ ] Document any provider limitation discovered during live verification, especially Bing retention/update cadence and row limits.
- [ ] Mark tasks complete only with concrete test or live-verification evidence.
- [ ] Do not mark the change complete if OAuth, MCP Inspector, or live provider behavior has only been inferred from mocks.
