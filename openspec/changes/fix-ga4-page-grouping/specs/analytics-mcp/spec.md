## ADDED Requirements

### Requirement: GA4 page grouping modes
`ga4_pages` SHALL accept `groupBy` of `path` (default) or `fullUrl`.

#### Scenario: Default path grouping
- WHEN `groupBy` is omitted or `path`
- THEN the Data API request SHALL use dimensions `hostName` and `pagePath`, ordered by `screenPageViews` desc then those dimensions
- AND metrics SHALL be Google's values, never summed or averaged by the service

#### Scenario: Full URL grouping
- WHEN `groupBy` is `fullUrl`
- THEN the request SHALL use `pagePathPlusQueryString` and distinct query strings SHALL remain distinct rows

#### Scenario: Prefix filter
- WHEN `pagePath` is given in either mode
- THEN a `BEGINS_WITH` filter on `pagePath` SHALL be applied by Google before pagination
