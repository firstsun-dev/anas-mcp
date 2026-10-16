## ADDED Requirements

### Requirement: Search Console property allowlist
The service SHALL read approved Search Console properties from the non-secret `GSC_ALLOWED_SITES` JSON string array and SHALL disable Search Console when it is missing or malformed.

#### Scenario: Unapproved property
- WHEN `gsc_search_analytics` is called with a `siteUrl` not exactly in the allowlist
- THEN it SHALL return `property_not_allowed` before any token exchange or Google request

#### Scenario: Not configured
- WHEN the allowlist is missing, empty or malformed
- THEN both tools SHALL return `configuration_missing` and `health` SHALL keep `search-console` planned

### Requirement: gsc_list_sites
The service SHALL expose a read-only `gsc_list_sites` returning Google's `siteUrl` and `permissionLevel` verbatim for properties that are both accessible to the Google identity and allowlisted, deterministically ordered, with `count` and `source: "google-search-console"`.

#### Scenario: Inaccessible or unverified property
- WHEN an allowlisted property is not returned by Google, or is `siteUnverifiedUser`
- THEN it SHALL be reported (`approvedButNotAccessible`, `queryable: false`) and no property outside the allowlist SHALL ever appear

### Requirement: gsc_search_analytics
The service SHALL expose a read-only `gsc_search_analytics` with bounded validated inputs, a fixed endpoint, a fixed filter structure (`contains`/`equals` on page and query only) and `aggregationType: "auto"`.

#### Scenario: Pacific-time defaults
- WHEN no dates are given
- THEN the range SHALL be the previous 28 completed calendar days in `America/Los_Angeles`, including across DST transitions

#### Scenario: Provider semantics preserved
- WHEN Google returns rows, `responseAggregationType` or `metadata` such as `first_incomplete_date`
- THEN they SHALL be returned unchanged; CTR SHALL stay a ratio, missing metrics SHALL be `null`, no totals or row counts SHALL be fabricated, and pagination SHALL be labelled advisory

#### Scenario: Provider failures
- WHEN Google or the token provider fails
- THEN a sanitized code SHALL be returned (scope missing, revoked, permission denied, API disabled, quota, rate limit, timeout, malformed or oversized response, unavailable); 401 SHALL trigger exactly one token refresh and retry

### Requirement: Health reports Search Console only when configured
`health` SHALL list `search-console` in `enabledSources` only when the credential binding and a valid allowlist exist, without calling Google, and without reclassifying other sources.
