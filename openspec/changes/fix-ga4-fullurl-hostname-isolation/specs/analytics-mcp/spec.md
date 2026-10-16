## MODIFIED Requirements

### Requirement: GA4 page grouping modes
`ga4_pages` SHALL isolate rows by hostname in every grouping mode.

#### Scenario: Full URL grouping
- WHEN `groupBy` is `fullUrl`
- THEN the Data API request SHALL use dimensions `hostName` and `pagePathPlusQueryString`, ordered by `screenPageViews` desc then both dimensions
- AND the same path and query string on different hosts SHALL remain distinct rows, and distinct query strings on one host SHALL remain distinct rows
- AND all aggregation SHALL be done by Google; the service SHALL NOT sum rows

#### Scenario: Path grouping unchanged
- WHEN `groupBy` is omitted or `path`
- THEN the request SHALL use `hostName` and `pagePath`
