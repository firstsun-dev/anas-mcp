# Change: Detect invalid Clarity page ingestion datasets

## Why
Production fetch run 292 stored 286 `page` rows with zero `url_normalized` (windmill-flows normalizer read `URL`, Clarity sends `Url`). `clarity_pages` selected keys with `url_normalized IS NOT NULL` and returned a successful empty list; `clarity_page` returned `data_unavailable` for known pages. An empty success reads as "no pages / no traffic".

## What changes
- New fixed error code `data_quality` for `clarity_pages` / `clarity_page` when the selected non-empty page run has no normalized URLs at all.
- Detection is one parameterized `EXISTS` probe on the selected run, only when a page read is empty. Legitimate empty filters/offsets stay empty collections; an unknown page stays `data_unavailable`.
- No change to canonical run selection, truncation/completeness fields, project isolation, auth, or read-only transactions. No URL inference from other metrics.

## Impact
`src/services/clarity-analytics.ts`, `docs/clarity.md`, tests. Companion: firstsun-dev/windmill-flows `fix/clarity-url-normalization`.
