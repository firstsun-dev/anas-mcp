## ADDED Requirements

### Requirement: Shared Google OAuth token provider
The service SHALL obtain Google access tokens from one Zod-validated `authorized_user` credential JSON read from the asynchronous Secrets Store binding `GOOGLE_OAUTH_CREDENTIALS`, via the fixed Google token endpoint, caching tokens only in isolate memory.

#### Scenario: Missing or invalid credential
- WHEN the binding is absent, unreadable, empty, or not valid credential JSON
- THEN no Google request SHALL be made and the caller SHALL receive a sanitized error that never contains credential material

#### Scenario: Concurrent refresh
- WHEN several requests need a token at the same time
- THEN exactly one token request SHALL be sent

#### Scenario: Rotation and revocation
- WHEN the stored credential changes
- THEN the next request SHALL use the new credential without redeploy
- AND `invalid_grant` SHALL surface as `authorization_revoked`

### Requirement: GA4 MCP tools
The service SHALL expose read-only `ga4_overview`, `ga4_pages`, `ga4_acquisition`, and `ga4_run_report` tools with bounded inputs, read-only annotations and `structuredContent`.

#### Scenario: Property allowlist
- WHEN a requested property is not in `GA4_PROPERTY_IDS`, or several are approved and none is given
- THEN the tool SHALL fail before any Google call

#### Scenario: Controlled reports
- WHEN `ga4_run_report` is called with fields outside the catalog, duplicates, too many fields, an over-long range, or mixed session/first-user dimensions
- THEN it SHALL be rejected without calling Google
- AND no arbitrary request JSON, filters or endpoints SHALL be accepted

#### Scenario: Provider semantics preserved
- WHEN Google returns thresholding, sampling, other-row, empty-reason or quota information
- THEN the response SHALL carry it, SHALL NOT zero-fill missing data, and SHALL NOT invent `dataThrough`

#### Scenario: Provider failures
- WHEN Google returns 401/403/429/5xx, times out, or exceeds the response size cap
- THEN the tool SHALL return a distinct sanitized error code (`google_auth_*`, `permission_denied`, `quota_exceeded`, `provider_unavailable`, `response_too_large`)

### Requirement: Health reports GA4 only when configured
`health` SHALL list `ga4` in `enabledSources` only when the credential binding and a valid property allowlist are present, SHALL keep `search-console` planned, and SHALL NOT call Google.
