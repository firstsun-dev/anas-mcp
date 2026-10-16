# Tasks: GA4 tools and shared Google authentication

## Contract
- [x] Review repo for an approved Google identity/service account (none found; `authorized_user` documented default).
- [ ] Operator: enable Analytics Data API, authorize the OAuth credential with `analytics.readonly` (+ `webmasters.readonly` for Phase 3), grant the identity Viewer on the GA4 property.
- [ ] Operator: create Secrets Store secret `ANAS_PROD_GOOGLE_OAUTH_CREDENTIALS`, add the `secrets_store_secrets` binding `GOOGLE_OAUTH_CREDENTIALS` with the real store ID, set `GA4_PROPERTY_IDS`.

## Implementation
- [x] `src/auth/google-oauth.ts`
- [x] `src/services/google-analytics.ts`
- [x] `src/tools/google-analytics.ts` and registration; `health` gating
- [x] Guardrails narrowed; no `openapi.yaml` change (no HTTP surface change)

## Verification
- [x] Unit/MCP tests with mocked Secrets Store and Google (`tests/google-oauth.test.ts`, `tests/google-analytics.test.ts`, `tests/ga4-mcp.test.ts`)
- [x] `pnpm run check`, `pnpm exec wrangler deploy --dry-run`
- [ ] MCP Inspector against `wrangler dev` (not run)
- [ ] Production GA4 query through Cloudflare Access (not claimed; issue #15 stays open until verified)
