## ADDED Requirements

### Requirement: Clarity MCP tools
The service SHALL expose read-only `clarity_overview`, `clarity_pages`, `clarity_acquisition`, and `clarity_page` MCP tools backed by Windmill-ingested PostgreSQL data, with read-only annotations and bounded Zod-validated inputs.

#### Scenario: Newer ingestion failed
- WHEN the newest Clarity fetch run for a query failed or is pending
- THEN the tools SHALL serve the newest usable `success`/`truncated` run with rows
- AND SHALL NOT sum, merge, or combine rows from different runs, windows, or dimension breakdowns

#### Scenario: Truncated source dataset
- WHEN the served run is truncated at ingestion
- THEN the response SHALL set `sourceTruncated: true`, `coverage.sourceComplete: false`, preserve the original `coverage.status`, and set `responseComplete: false`

#### Scenario: Locally truncated response
- WHEN a response omits metric rows or whole pages/cells because of the per-call (500) or per-group (100) row bounds, even though ingestion succeeded
- THEN the response SHALL set `responseTruncated: true` and `responseComplete: false` while `sourceTruncated` stays `false`
- AND each clipped page/cell/group SHALL carry `metricsTruncated: true` with its true size in `metricRowTotal`
- AND `hasMore` SHALL remain independent of truncation

#### Scenario: Oversized single page or acquisition cell
- WHEN one page or acquisition cell has more metric rows than the per-group cap
- THEN the detail read SHALL be bounded in SQL (per-group row number and overall LIMIT, both parameterized and deterministically ordered) and the group SHALL be flagged incomplete, never represented as complete

#### Scenario: Row budget exceeded across a result page
- WHEN the pages/cells of one result page together exceed the response row budget
- THEN only whole pages/cells that fit SHALL be returned, `hasMore` SHALL be `true`, and `nextOffset` SHALL give the stable offset to continue from

#### Scenario: No ingestion data
- WHEN no usable run exists
- THEN the tool SHALL return `data_unavailable`, never zero metrics

### Requirement: Clarity project isolation
Clarity tools SHALL only read projects listed in the non-secret `CLARITY_PROJECT_KEYS` allowlist and SHALL fail closed with `missing_configuration` when it is unset or malformed.

### Requirement: Health distinguishes enabled and planned sources
`health` SHALL report `enabledSources` (sources whose tools and configuration are valid) separately from `plannedSources`, and SHALL NOT list Clarity as enabled until `CLARITY_PROJECT_KEYS` and `ANALYTICS_DB` are configured.
