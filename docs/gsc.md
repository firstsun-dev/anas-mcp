# Google Search Console MCP tools

Phase 3 of the analytics MCP (issue #16). OpenSpec: `openspec/changes/add-gsc-analytics-tools/`.

Search Console is queried directly through the **Search Console API** (`https://www.googleapis.com/webmasters/v3`, fixed). Everything is read-only. It reuses the same `GoogleTokenProvider`, Secrets Store credential (`GOOGLE_OAUTH_CREDENTIALS` -> `ANAS_PROD_GOOGLE_OAUTH_CREDENTIALS`), token cache and rotation as GA4 (`docs/ga4.md`); there is no second credential, OAuth client or refresh workflow. MCP clients are authenticated only by Cloudflare Access, and Google is never contacted before the Access assertion is validated.

## Status: configured, unverified

`GSC_ALLOWED_SITES` in `wrangler.jsonc` is set to `https://firstsun.heavenfortress.com/` and `sc-domain:heavenfortress.com`. These were supplied by the operator as the intended properties but **have not been verified against the authorized Google account**. After deploy, `gsc_list_sites` shows whether each is accessible (`approvedButNotAccessible` lists any that are not). Correct the identifiers exactly as shown in Search Console if needed. Removing the var (or making it malformed) disables Search Console again (`configuration_missing`).

## Tools

| Tool | Purpose |
| --- | --- |
| `gsc_list_sites` | Properties accessible to the Google identity **and** on the allowlist, with Google's exact `siteUrl` and `permissionLevel` |
| `gsc_search_analytics` | Clicks, impressions, ctr, position for one allowlisted property, grouped by 1-3 of `query`, `page`, `date`, `country`, `device` |

Both carry `readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false` and return `structuredContent` plus the same JSON as text. URL inspection is out of scope.

### `gsc_list_sites`
No input. Response: `{ sites: [{ siteUrl, permissionLevel, queryable }], count, approvedButNotAccessible: string[], source: "google-search-console", note }`. Sorted by `siteUrl` (code-unit order). `queryable: false` marks `siteUnverifiedUser`. An allowlisted property that Google does not return (no access, not verified, wrong identifier) appears in `approvedButNotAccessible`. Properties outside the allowlist are never shown. An empty result is valid.

### `gsc_search_analytics`

| Input | Default | Bounds |
| --- | --- | --- |
| `siteUrl` | required | exact allowlisted identifier |
| `startDate`, `endDate` | previous 28 completed days (America/Los_Angeles) | both or neither; real `YYYY-MM-DD` dates; max 366 days |
| `dimensions` | `["query"]` | 1-3 of `query`, `page`, `date`, `country`, `device`; no duplicates |
| `type` | `web` | `web`, `image`, `video`, `news`, `discover`, `googleNews` (the last two have no query data: `query` dimension/filter rejected locally) |
| `dataState` | `final` | `final`, `all` |
| `limit` / `offset` | 50 / 0 | 1-200 / 0-10000 |
| `pageFilter`, `queryFilter` | none | 1-512 printable chars; operator `pageFilterOperator`/`queryFilterOperator` = `contains` (default) or `equals` |

The request body is built only from these fields (`aggregationType: "auto"`, at most one `dimensionFilterGroups` entry with `groupType: "and"`). No regular expressions, arbitrary filters, raw request JSON, API URLs or hostnames are accepted. `siteUrl` is `encodeURIComponent`-encoded as one path component.

Response: `siteUrl`, `dateRange {startDate, endDate, timeZone: "America/Los_Angeles"}`, `dimensions`, `type`, `dataState`, `rows [{dimensions: {<name>: value}, clicks, impressions, ctr, position}]`, `returnedRowCount`, `pagination {limit, offset, nextOffset, hasMorePossible}`, `responseAggregationType`, `metadata` (Google's, e.g. `first_incomplete_date`), `source`, `note`.

## Data semantics and limits

- **Timezone.** Search Console reports in `America/Los_Angeles`. The default range ends on Pacific "yesterday" and spans 28 calendar days; it is computed with the runtime tz database, so DST transitions are correct. Explicit dates are Pacific calendar dates; Asia/Taipei and UTC are never assumed.
- **Not exhaustive.** Google omits anonymized queries and returns only top rows. An empty response does not prove zero traffic; totals need not match the Search Console UI or GA4.
- **No total row count.** `hasMorePossible` is true when a full page came back and is **advisory**; `nextOffset` is the next offset to try. Rows with equal clicks are ordered arbitrarily by Google, so offset paging can skip or repeat rows. Nothing claims completeness.
- **Values are Google's.** `ctr` is a ratio (0.05 = 5%), `position` is the average result position; neither is recalculated, summed or averaged across rows. Absent metrics are `null`, never `0`; missing dates are not backfilled.
- **Impressions are not GA4 page views.** The two are different measures from different systems.
- **Freshness.** `dataState: "final"` excludes recent, still-changing data (the newest days can be empty). `dataState: "all"` includes fresh data; Google reports `metadata.first_incomplete_date` only when `dataState` is `all` **and** the report is grouped by `date` (include `date` in `dimensions`); other `all` reports carry no such field, so its absence there does not mean the data is complete. When present it is returned unchanged. `responseAggregationType` is preserved as returned.

## Errors

`{"error":{"code","message"}}` with `isError: true`. Messages are fixed; Google error bodies are never forwarded.

| Code | Meaning |
| --- | --- |
| `configuration_missing` | `GSC_ALLOWED_SITES` missing/malformed |
| `invalid_property` / `property_not_allowed` | malformed identifier / not on the allowlist (rejected before any token or Google call) |
| `invalid_request` | bad dates, dimensions, filters, bounds or combination (also Google HTTP 400) |
| `google_auth_not_configured`, `google_auth_invalid`, `google_auth_revoked`, `google_auth_unavailable` | shared token provider failures (as in `docs/ga4.md`) |
| `google_auth_scope_missing` | the authorization lacks `webmasters.readonly` (operator action below) |
| `permission_denied` | identity lacks access to the property (HTTP 403/404) |
| `api_disabled` | Search Console API not enabled in the Google Cloud project |
| `quota_exceeded` / `rate_limited` | Google quota exhausted / rate limiting (`retryAfterSeconds` when given) |
| `timeout`, `malformed_response` (also when a row's `keys` do not match the requested dimensions), `response_too_large`, `provider_unavailable` | transport and provider failures |

On HTTP 401 the token is force-refreshed and the request retried exactly once. 5xx, network errors and timeouts are retried at most twice (exponential backoff, or exactly the `Retry-After` when it is <= 5 s; a longer `Retry-After` on a 5xx is never slept — the call fails with `provider_unavailable` and `retryAfterSeconds`). Rate limits with `Retry-After` <= 5 s are retried likewise; quota exhaustion is never retried. 10 s per-attempt timeout; responses are capped at 2 MiB. Logs carry only `{event, operation, attempt, status, outcome, durationMs}` — never queries, URLs, tokens, headers or bodies.

## Configuration

| Item | Where | Value |
| --- | --- | --- |
| `GSC_ALLOWED_SITES` | `wrangler.jsonc` `vars` (non-secret) | JSON-encoded string array of exact property identifiers, e.g. `"[\"https://example.com/\",\"sc-domain:example.org\"]"` (placeholders). URL-prefix properties must end in `/`. Any malformed entry, an empty list or more than 50 entries disables Search Console (fail closed). |
| `GOOGLE_OAUTH_CREDENTIALS` | Secrets Store binding | already configured for GA4 |

A URL-prefix property is never widened to its domain: `https://example.com/` and `sc-domain:example.com` are different identifiers and each must be listed separately.

## Operator checklist

1. In the Google Cloud project that owns the OAuth client, confirm the **Google Search Console API** is enabled (otherwise `api_disabled`).
2. Confirm the existing refresh token includes `https://www.googleapis.com/auth/webmasters.readonly`. If it does not, tools return `google_auth_scope_missing`: re-authorize the same OAuth client with the additional read-only scope outside this repository and rotate the Secrets Store secret (no redeploy). Do not request broader scopes and do not edit the secret by hand in tickets or chat.
3. Confirm the authorized Google account has access to each intended Search Console property (owner/full/restricted user; unverified access is reported as `queryable: false`). Copy each identifier exactly from the Search Console property selector.
4. Check `GSC_ALLOWED_SITES` in `wrangler.jsonc` `vars` holds the verified identifiers (already set; fix if wrong) and merge; the central workflow deploys. `health` then lists `search-console` under `enabledSources` — **configuration readiness only; it does not prove live Google authorization**.
5. Verify live access by calling `gsc_list_sites` through Cloudflare Access, then `gsc_search_analytics`. Production verification has not been performed.

Rotation/revocation: identical to GA4 (`docs/ga4.md`); `invalid_grant` surfaces as `google_auth_revoked`.
