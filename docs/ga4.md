# GA4 MCP tools and Google authentication

Phase 2 of the analytics MCP (issue #15). OpenSpec: `openspec/changes/add-ga4-analytics-tools/`. Search Console (Phase 3) reuses `src/auth/google-oauth.ts`.

GA4 is queried directly through the **Google Analytics Data API** (`POST https://analyticsdata.googleapis.com/v1beta/properties/{id}:runReport`). It is read-only. Google API authorization is separate from Cloudflare Access: MCP clients are still authenticated only by Access (`docs/mcp-authentication.md`), and Google is never contacted before the Access assertion is validated.

## Tools

| Tool | Purpose |
| --- | --- |
| `ga4_overview` | Property totals: active/total users, sessions, engaged sessions, engagement rate, screen/page views, average session duration |
| `ga4_pages` | Per `pagePathPlusQueryString` (distinct query strings stay distinct); optional `pagePath` prefix; ordered by `screenPageViews` desc |
| `ga4_acquisition` | Session-scoped channel group / source / medium (not first-user acquisition) |
| `ga4_run_report` | Catalog-controlled report: max 4 dimensions, 6 metrics, 366 days, 200 rows; no filters/expressions/raw JSON |

All carry `readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false` and return `structuredContent` plus the same JSON as text.

Inputs: `propertyId` (optional when exactly one property is approved), `startDate`/`endDate` (`YYYY-MM-DD`; default is GA4 relative `28daysAgo`..`yesterday`, resolved by Google in the property timezone), `limit` (1-200, default 50), `offset` (0-10000).

Response fields: `propertyId`, `dateRange`, `propertyTimeZone`, `dimensionHeaders`, `metricHeaders` (Google names/types), `rows`, `rowCount` (Google's total), `returnedRowCount`, `empty`/`emptyReason`, `pagination {limit, offset, hasMore, nextOffset}`, `responseTruncated` (local) / `responseComplete`, `metadata {subjectToThresholding, samplingMetadatas, dataLossFromOtherRow, schemaRestrictionResponse}`, `propertyQuota`. Missing values are `null`, never `0`; there is no `dataThrough`. GA4 metrics are not interchangeable with Clarity or Bing metrics, and GA4 is never silently replaced by Clarity.

Error codes (`{"error":{"code","message"}}`, `isError: true`): `configuration_missing`, `property_required`, `property_not_allowed`, `invalid_request`, `permission_denied`, `quota_exceeded` (with `retryAfterSeconds` when Google gave one), `provider_unavailable`, `response_too_large`, `google_auth_not_configured`, `google_auth_invalid`, `google_auth_revoked`, `google_auth_unavailable`.

`ga4_run_report` catalog (extend only with a justified change): dimensions `date, country, deviceCategory, browser, operatingSystem, hostName, pagePath, pagePathPlusQueryString, pageTitle, landingPagePlusQueryString, session{DefaultChannelGroup,Source,Medium,SourceMedium,CampaignName}, firstUser{DefaultChannelGroup,Source,Medium,SourceMedium,CampaignName}`; metrics `activeUsers, totalUsers, newUsers, sessions, engagedSessions, engagementRate, bounceRate, screenPageViews, screenPageViewsPerSession, averageSessionDuration, userEngagementDuration, eventCount`. Session-scoped and first-user-scoped dimensions cannot be combined; other incompatible combinations are rejected by Google and reported as `invalid_request`.

## Configuration

| Item | Where | Value |
| --- | --- | --- |
| `GA4_PROPERTY_IDS` | `wrangler.jsonc` `vars` (non-secret) | Comma-separated numeric property IDs, e.g. `123456789`. Any malformed entry disables GA4 (fail closed). With several IDs every call must pass `propertyId`. |
| `GOOGLE_OAUTH_CREDENTIALS` | Secrets Store binding | Secret `ANAS_PROD_GOOGLE_OAUTH_CREDENTIALS` (staging: `ANAS_STAGING_...`) |

Both are committed: `GA4_PROPERTY_IDS` = `346676362,269121931` (so `propertyId` is required on every call) and the `secrets_store_secrets` binding `GOOGLE_OAUTH_CREDENTIALS` -> `ANAS_PROD_GOOGLE_OAUTH_CREDENTIALS` in the account's default Secrets Store (store ID is an identifier, not a credential).

## Credential

One JSON secret, OAuth2 `authorized_user` (operator-authorized; no Worker login/callback UI exists):

```json
{ "type": "authorized_user", "client_id": "…", "client_secret": "…", "refresh_token": "…", "scopes": ["…optional, documentation only…"] }
```

Scope contract: `https://www.googleapis.com/auth/analytics.readonly` (GA4) and `https://www.googleapis.com/auth/webmasters.readonly` (Phase 3 only). The optional `scopes` array must be a subset of these; the token response's `scope` must include the scope the caller needs. The refresh grant sends no `scope` parameter.

Why `authorized_user`: no existing Google identity or service account approved for both GA4 and Search Console is recorded in this repository. A service account is a possible alternative if its access to both is verified; switching requires a new OpenSpec change.

Runtime behavior: the Worker reads the secret asynchronously, validates it with Zod, exchanges the refresh token at `https://oauth2.googleapis.com/token` (fixed), and caches the access token only in isolate memory until 60 s before expiry; concurrent refreshes are coalesced. Tokens and credentials are never stored elsewhere or logged.

## Operator runbook

1. In the Google Cloud project that owns the OAuth client, enable **Google Analytics Data API** (Search Console API later for Phase 3).
2. Authorize the intended Google identity with the read-only scope(s) (e.g. OAuth consent for `analytics.readonly`) and obtain the refresh token outside this repository.
3. Grant that identity **Viewer** (or higher read access) on each approved GA4 property.
4. Create Secrets Store secret `ANAS_PROD_GOOGLE_OAUTH_CREDENTIALS` with the JSON above (do not paste it into logs, tickets or chat).
5. Merge the PR (binding and `GA4_PROPERTY_IDS` are already in `wrangler.jsonc`) and let the central workflow deploy. `health` then lists `ga4` in `enabledSources` — configuration readiness only; verify real access by calling `ga4_overview` through Cloudflare Access.
6. **Rotation:** update the secret value in Secrets Store; the next request picks it up (no redeploy). **Revocation:** revoke at Google; tools return `google_auth_revoked` until a new credential is stored. Re-authorize and rotate.

## Quotas and limits

Google applies per-property token quotas (see `propertyQuota` in responses); 429/`RESOURCE_EXHAUSTED` surfaces as `quota_exceeded`. The Worker retries at most twice (5xx, timeouts, `Retry-After` ≤ 5 s), uses a 10 s per-attempt timeout, and caps response bodies at 2 MiB. Thresholding, sampling and the `(other)` row are reported, not hidden. Standard GA4 data can take 24-48 h to finalize; no freshness claim is made.
