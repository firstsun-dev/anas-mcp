# Design: Clarity read model serving

## Verified ingestion contract (windmill-flows `clarity_sync.py`, migration `20260904003000`)
- One immutable `clarity_fetch_runs` row per API request; `window_start_at/window_end_at` = `now - num_days .. now` (UTC, rolling, `num_days` 1–3). `logical_date` is the Taipei-local date of the window start, only an attribution label.
- Statuses written with data: `success`, `truncated` (>= 1000 rows, `truncated_suspected = true`). Others: `pending`, `fetch_failed`, `auth_failed`, `rate_limited`, `normalize_failed`; `partial` is allowed by the CHECK but never written per run.
- `clarity_metric_rows`: one row per metric per dimension combination; typed dimension columns (`url_normalized`, `device`, `source`, `medium`, `campaign`, `channel`, ...) plus `metric_values` JSONB holding every non-dimension field of the Clarity record unchanged. Rows are deleted/rebuilt by `clarity_reprocess.py` from stored raw payloads.
- Query keys: `site_overall`, `page`, `page_device`, `acquisition`, `technology`, `geo_device`, `page_source`.

## Canonical run selection
Per `(project_key, query_key)` pick exactly one run:

```
status IN ('success','truncated') AND fetched_at IS NOT NULL AND window_*_at IS NOT NULL AND row_count > 0
  AND query definition enabled
ORDER BY window_end_at DESC, fetched_at DESC, id DESC LIMIT 1
```

- A newer failed/pending/rate-limited run is not eligible, so it cannot replace a valid dataset.
- A newer run that normalized zero rows is not eligible (an empty observation is indistinguishable from an ingestion anomaly and must never read as zero traffic).
- A `truncated` run is served, flagged `truncated: true` / `coverage.complete: false`; it is never presented as complete and an older `success` run is not substituted (the newest window wins; mixing runs is forbidden).
- Rows are read only with `fetch_run_id = <selected> AND project_key AND query_key`. Different runs, windows, query keys and dimension breakdowns are never summed, merged or combined into totals; duplicate observations of the same page/metric stay separate array entries.
- The run lookup and row lookups share one `REPEATABLE READ READ ONLY` snapshot.

## Semantics exposed to clients
- `coverage.windowStart/windowEnd` = the requested rolling window; `freshness.dataThrough = windowEnd` (Clarity gives no stronger boundary; not the Taipei logical date). `freshness.stale` uses the same 72 h threshold as Bing.
- `metric_values` is passed through unchanged. Units, field names and numeric formats are Clarity's and are not interpreted or converted; no GA4-compatible users/sessions are invented. Non-object JSONB becomes `null`.
- `truncated` = source export ceiling reached; `hasMore` = another result page exists.
- No usable run -> `data_unavailable` ("does not mean there was no traffic").

## Project isolation
`CLARITY_PROJECT_KEYS` (comma-separated, each `[A-Za-z0-9._-]{1,64}`; any malformed entry invalidates the whole value) is the allowlist. One approved key is the default; with several, `projectKey` is required. A key outside the list is a `validation` error before any database access. Unset/invalid -> `missing_configuration`. Every statement filters on `project_key`.

The production value is the Windmill variable `f/blog_analytics/clarity_project_key`, which cannot be read from this repository; it is **not** invented here and `wrangler.jsonc` is unchanged. See `docs/clarity.md`.

## Page identity
`clarity_page`/`pagePrefix` use the stored `url_normalized`. `normalizePageUrl()` ports `normalize_url()` (path with trailing slash, `utm_*`/click-id params removed, remaining params sorted, `share` pages collapse to the path). Percent-decoded twins are tried too, since Clarity may store raw Unicode. Prefix filtering uses `starts_with()` (no LIKE wildcards).

## Page breakdowns
`clarity_page` returns the `page` observation plus `page_device` and `page_source` breakdowns, each from its own canonical run and coverage, `null` when absent. `technology` and `geo_device` have no tool yet (no page key; deferred).

## Safety
Fixed statements, all input bound as parameters, `COLLATE "C"` ordering, bounded limits (<= 100 pages, <= 500 detail rows), `raw_payload` never selected, driver errors reduced to SQLSTATE in logs and fixed messages to clients.
