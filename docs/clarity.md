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
Common response fields: `projectKey`, `queryKey`, `freshness {fetchedAt, dataThrough, stale}`, `coverage {logicalDate, windowStart, windowEnd, numDays, status, complete, normalizerVersion}`, `rows`, `rowCount`, `truncated` (source export hit its 1000-row ceiling). `dataThrough` is the window end. `projectKey` is optional when exactly one project is approved.

| Tool | Input | Rows |
| --- | --- | --- |
| `clarity_overview` | `projectKey?` | `site_overall`: `{metric, values}` per metric |
| `clarity_pages` | `limit` (1-100, default 25), `offset` (0-100000), `pagePrefix?`, `projectKey?` | `page`: `{page, metrics: {name: [values...]}}`, ordered by page path; `hasMore`, `offset` |
| `clarity_acquisition` | `limit`, `offset`, `projectKey?` | `acquisition`: `{source, medium, campaign, channel, metrics}`; null attribution kept; nulls last |
| `clarity_page` | `page` (path or URL), `projectKey?` | `{page, observation, breakdowns: {device, source}}`, each with its own coverage, `null` when unavailable |

`metrics[name]` is an array because the same normalized page can have several raw URL variants; entries are never merged. Canonical run selection is documented in the design.

## Errors
`validation`, `missing_configuration`, `data_unavailable`, `database_unavailable` with fixed messages (no SQL, DSNs or driver text). Logs contain only operation, latency, status and SQLSTATE.

## Known limitations
- `technology` and `geo_device` runs are ingested but have no tool yet.
- Only the newest usable window per query is served (no history) and a truncated newest run is served as such rather than falling back to an older complete one.
- The window is the requested range; Clarity does not confirm its own coverage boundary.
