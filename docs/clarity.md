# Microsoft Clarity MCP tools

`anas-mcp` serves Clarity data that `firstsun-dev/windmill-flows` ingests into PostgreSQL (`blog_analytics.clarity_*`). The Worker never calls the Clarity API and never reads `raw_payload`. All tools are read-only (`readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false`) and are reached only through the Access-protected `/mcp` endpoint. Design rationale: `openspec/changes/add-clarity-analytics-tools/`.

## Data semantics (read this before interpreting numbers)
Clarity Data Export is an **aggregate rolling window**, not a session/event store. Each ingestion run covers `coverage.windowStart..windowEnd` (1-3 days ending when the request was made). Runs overlap, so values from different runs are never added; `coverage.logicalDate` is only a Taipei-local label; site, page, device, source and acquisition breakdowns are separate cuts and must not be summed together. Metric values are returned exactly as Clarity reported them (names, units, number formats are Clarity's). A missing metric is absent or `null`, never `0`, and `data_unavailable` never means zero traffic.

## Configuration
| Name | Kind | Purpose |
| --- | --- | --- |
| `ANALYTICS_DB` | Hyperdrive binding (existing) | read-only PostgreSQL |
| `CLARITY_PROJECT_KEYS` | non-secret Worker var | comma-separated approved `clarity_metric_rows.project_key` values |

Until `CLARITY_PROJECT_KEYS` is set the tools return `missing_configuration` and `health` does not list `clarity` as enabled. The value must equal the Windmill variable `f/blog_analytics/clarity_project_key` (verify with `SELECT DISTINCT project_key FROM blog_analytics.clarity_fetch_runs`). To enable: add `"CLARITY_PROJECT_KEYS": "<verified key>"` to `vars` in `wrangler.jsonc` (and extend the `repo-guardrails` vars allowlist test) in a reviewed PR; deployment then follows the normal main-branch pipeline. It is an identifier, not a credential.

## Tools
Common response fields: `projectKey`, `queryKey`, `freshness {fetchedAt, dataThrough, stale}`, `coverage {logicalDate, windowStart, windowEnd, numDays, status, sourceComplete, normalizerVersion}`, `rows`, `rowCount`, plus three completeness flags (see below). `dataThrough` is the window end. `projectKey` is optional when exactly one project is approved.

### Source vs response completeness
| Field | Meaning |
| --- | --- |
| `sourceTruncated` | The **ingestion** hit Clarity's 1000-row export ceiling; rows may be missing at the source. `coverage.status` keeps the original ingestion status (`success`/`truncated`) and `coverage.sourceComplete` is its boolean form. |
| `responseTruncated` | **This response** omitted metric rows or whole pages/cells because of the local bounds below, even though ingestion succeeded. |
| `responseComplete` | `true` only when neither of the above applies. Treat `false` as "do not present as complete". |
| `hasMore` | Another result page exists. Independent of both truncation flags (a last page can be `responseTruncated`; a clean page can have `hasMore`). |

Local bounds: at most 500 metric rows per tool call (`clarity_overview` keeps the first 500 rows) and at most 100 metric rows per page / acquisition cell / breakdown group. A group clipped by the per-group cap is returned with `metricsTruncated: true` and its real size in `metricRowTotal`, and the retained rows are the deterministic prefix in (`metric_name`, `row_hash`) order. For `clarity_pages` and `clarity_acquisition`, whole pages/cells that do not fit the 500-row budget are deferred (never half-returned): the response is shorter than `limit`, `responseTruncated` is `true`, `hasMore` is `true` and **`nextOffset`** is where to continue (`offset + rowCount`; use it rather than `offset + limit`). `nextOffset` is `null` when there is nothing more. `clarity_page` reports the same flags per section (`observation`, `breakdowns.device`, `breakdowns.source`) and aggregated at the top level. A clipped group is never reported as complete.

| Tool | Input | Rows |
| --- | --- | --- |
| `clarity_overview` | `projectKey?` | `site_overall`: `{metric, values}` per metric |
| `clarity_pages` | `limit` (1-100, default 25), `offset` (0-100000), `pagePrefix?`, `projectKey?` | `page`: `{page, metrics: {name: [values...]}, metricsTruncated, metricRowTotal}`, ordered by page path; `hasMore`, `offset`, `nextOffset` |
| `clarity_acquisition` | `limit`, `offset`, `projectKey?` | `acquisition`: `{source, medium, campaign, channel, metrics, metricsTruncated, metricRowTotal}`; null attribution kept; nulls last; `hasMore`, `nextOffset` |
| `clarity_page` | `page` (path or URL), `projectKey?` | `{page, observation, breakdowns: {device, source}}`, each with its own coverage, `null` when unavailable |

`metrics[name]` is an array because the same normalized page can have several raw URL variants; entries are never merged. Canonical run selection is documented in the design.

## Errors
`validation`, `missing_configuration`, `data_unavailable`, `data_quality`, `database_unavailable` with fixed messages (no SQL, DSNs or driver text). Logs contain only operation, latency, status and SQLSTATE.

### Page data quality (`data_quality`)
`clarity_pages` and `clarity_page` return `data_quality` (never an empty success) when the selected `page` / `page_device` / `page_source` run is non-empty but none of its rows carry a normalized page URL, i.e. page URL dimensions are missing from the ingested dataset. The message states this is an ingestion problem, not an absence of pages or traffic; the dataset must be reprocessed from its stored raw payload (windmill-flows `clarity_reprocess`).
- The check is a single parameterized `EXISTS` on the selected run (indexed by `fetch_run_id`), executed only when a page read came back empty, so healthy reads pay nothing.
- A filter or offset that legitimately matches no pages on a dataset that has URLs still returns an empty collection; an unknown single page remains `data_unavailable`.
- `data_quality` is independent of `sourceTruncated`/`responseTruncated`/`hasMore`; page URLs are never inferred from `PopularPages`, `PageTitle` or acquisition rows.
- `overview` and `acquisition` are unaffected.

## Known limitations
- `technology` and `geo_device` runs are ingested but have no tool yet.
- Only the newest usable window per query is served (no history) and a truncated newest run is served as such rather than falling back to an older complete one.
- The window is the requested range; Clarity does not confirm its own coverage boundary.
