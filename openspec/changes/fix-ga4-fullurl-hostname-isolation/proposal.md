# Fix GA4 fullUrl hostname isolation
Follow-up to PR #22 / issue #23. `ga4_pages(groupBy="fullUrl")` requested only `pagePathPlusQueryString`, so Google merged identical path+query across hostnames (property 346676362, 2026-09-18..2026-10-15: `firstsun.heavenfortress.com` `/` = 96 views and `firstsun-blog.pages.dev` `/` = 4 were returned as one `/` row of 100).

- `fullUrl` now asks Google to aggregate by (`hostName`, `pagePathPlusQueryString`); `path` is unchanged.
- Intentional response-shape change: `fullUrl` rows gain `dimensions.hostName` and `dimensionHeaders` gains `hostName`.
- No local aggregation; `ga4_overview`, `ga4_acquisition`, `ga4_run_report` unchanged.
