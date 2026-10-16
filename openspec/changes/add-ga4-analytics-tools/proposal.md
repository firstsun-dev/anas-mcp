# Proposal: GA4 read-only MCP tools and shared Google authentication (Phase 2)

Tracking issue: firstsun-dev/anas-mcp#15

## Why
ChatGPT and other MCP clients can read Bing and Clarity data but not Google Analytics 4. GA4 is queried directly through the Google Analytics Data API, which needs a Google credential. Phase 3 (Search Console) needs the same credential, so the auth layer is built once and shared.

## What changes
- `src/auth/google-oauth.ts`: shared Google OAuth credential/token provider (one `authorized_user` credential JSON in Cloudflare Secrets Store, runtime-only access tokens).
- `src/services/google-analytics.ts`: fixed-endpoint Data API `runReport` client (timeout, bounded retry, bounded response).
- `src/tools/google-analytics.ts`: `ga4_overview`, `ga4_pages`, `ga4_acquisition`, `ga4_run_report`.
- Non-secret `GA4_PROPERTY_IDS` allowlist; Secrets Store binding `GOOGLE_OAUTH_CREDENTIALS` (secret `ANAS_PROD_GOOGLE_OAUTH_CREDENTIALS`).
- `health` lists `ga4` as enabled only when the binding and a valid allowlist exist; `search-console` stays planned.
- Guardrail tests narrowly allow `fetch` in the two Google modules only.

## Out of scope
Search Console (Phase 3), any change to Cloudflare Access authentication, OAuth callback/login UI, `openapi.yaml` (no HTTP surface change), CI/CD, creating real Google credentials, committing the Secrets Store ID or property IDs.

## Operator prerequisites (activation is gated on these)
Provision the Secrets Store secret, add the `secrets_store_secrets` binding with the real store ID, set `GA4_PROPERTY_IDS`, enable the Analytics Data API in the Google Cloud project. See `docs/ga4.md`.
