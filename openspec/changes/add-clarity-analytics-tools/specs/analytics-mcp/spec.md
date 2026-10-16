## ADDED Requirements

### Requirement: Clarity MCP tools
The service SHALL expose read-only `clarity_overview`, `clarity_pages`, `clarity_acquisition`, and `clarity_page` MCP tools backed by Windmill-ingested PostgreSQL data, with read-only annotations and bounded Zod-validated inputs.

#### Scenario: Newer ingestion failed
- WHEN the newest Clarity fetch run for a query failed or is pending
- THEN the tools SHALL serve the newest usable `success`/`truncated` run with rows
- AND SHALL NOT sum, merge, or combine rows from different runs, windows, or dimension breakdowns

#### Scenario: Truncated dataset
- WHEN the served run is truncated
- THEN the response SHALL set `truncated: true` and `coverage.complete: false`

#### Scenario: No ingestion data
- WHEN no usable run exists
- THEN the tool SHALL return `data_unavailable`, never zero metrics

### Requirement: Clarity project isolation
Clarity tools SHALL only read projects listed in the non-secret `CLARITY_PROJECT_KEYS` allowlist and SHALL fail closed with `missing_configuration` when it is unset or malformed.

### Requirement: Health distinguishes enabled and planned sources
`health` SHALL report `enabledSources` (sources whose tools and configuration are valid) separately from `plannedSources`, and SHALL NOT list Clarity as enabled until `CLARITY_PROJECT_KEYS` and `ANALYTICS_DB` are configured.
