# Change: Canonical page grouping for `ga4_pages`

## Why
`ga4_pages` used `pagePathPlusQueryString`, so share/UTM/click-id variants of one page appeared as separate rows (issue #21).

## What changes
- `ga4_pages` gains `groupBy: "path" | "fullUrl"`, default `path` (`hostName` + `pagePath`, aggregated by Google). `fullUrl` keeps the prior `pagePathPlusQueryString` behavior.
- Result includes the resolved `groupBy`; `dimensionHeaders` match the mode.
- No client-side aggregation or URL canonicalization. Other GA4 tools, auth, credentials and infrastructure are unchanged.

## Impact
`src/tools/google-analytics.ts`, `docs/ga4.md`, `README.md`, `tests/ga4-mcp.test.ts`. Behavior change: default rows of `ga4_pages` are now per host+path.
