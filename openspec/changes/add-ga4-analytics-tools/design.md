# Design: GA4 tools and shared Google authentication

## Credential decision
No existing approved Google identity/service account was found in this repository, `docs/`, or prior OpenSpec changes, so the documented default is used: an operator-authorized OAuth2 `authorized_user` credential (`client_id`, `client_secret`, `refresh_token`, optional `scopes`), stored as one JSON string in Secrets Store secret `ANAS_PROD_GOOGLE_OAUTH_CREDENTIALS`, bound as `GOOGLE_OAUTH_CREDENTIALS`. Service-account JWT flow is deliberately not implemented. The operator may still choose a service account later via a new OpenSpec change (access to both GA4 and GSC would need verifying first).

Scopes: `analytics.readonly` (GA4) and `webmasters.readonly` (Phase 3). The refresh-token grant never sends a `scope` parameter (Google rejects widening); the scope contract is checked instead: the optional credential `scopes` must be a subset of these two read-only scopes, and the token response `scope` must contain the scope the caller requires.

## Token provider
- Secret is read through the async binding on every token request (cheap; makes rotation immediate). Parsed with Zod; failure → `credentials_invalid`/`credentials_not_configured`.
- Cache: module-level (per isolate), keyed by SHA-256 fingerprint of the credential string; entry dropped when the fingerprint changes (rotation) or within 60 s of expiry. Tokens are never persisted or logged.
- Single-flight refresh per fingerprint.
- Fixed endpoint `https://oauth2.googleapis.com/token`; never from input. `invalid_grant` → `authorization_revoked`; 400/401 other → `credentials_rejected`; 429/5xx/network/timeout → `unavailable` (not cached).
- Cloudflare Access remains the only MCP client authentication; Google tokens are a downstream concern.

## GA4 client
POST `https://analyticsdata.googleapis.com/v1beta/properties/{id}:runReport`, `id` digits only and allowlisted before any network call. 10 s timeout per attempt, max 2 retries for 500/502/503/504/network/timeout and short (<=5 s) `Retry-After`/429; one forced token refresh on 401; 403 → `permission_denied`; quota exhaustion (429/RESOURCE_EXHAUSTED) → `quota_exceeded` with `retryAfterSeconds` when known. Body read is capped at 2 MiB. Google error messages are never forwarded verbatim.

## Tools
Fixed catalogs of dimensions/metrics; fixed `orderBys` for deterministic paging; limit <=200, offset <=10000; range <=366 days. Defaults use GA4 relative dates `28daysAgo`..`yesterday`, which Google resolves in the property timezone; responses echo the requested range and Google's `metadata.timeZone`. `ga4_run_report` rejects duplicate fields, mixing session-scoped and first-user-scoped dimensions, and anything outside the catalog; it accepts no filters/expressions.

Response semantics: provider `rowCount`, returned count, `hasMore`/`nextOffset`, `responseTruncated` (local), thresholding/sampling/`dataLossFromOtherRow`/`emptyReason` from Google metadata, sanitized `propertyQuota`. No `dataThrough`; no zero-filling.

## Configuration gating
Enabled iff binding present AND `GA4_PROPERTY_IDS` parses to >=1 valid ID. Tools are always registered and fail closed with `configuration_missing`. Readiness is not verified API access; `/health` makes no Google call.
