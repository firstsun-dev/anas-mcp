# Tasks: bootstrap analytics MCP

## Foundation
- [x] Initialize repository and package manifest.
- [x] Add Cloudflare Worker configuration.
- [x] Add stateless `/mcp` handler and `/health` endpoint.
- [x] Add initial MCP `health` tool.
- [x] Add project instructions and baseline OpenSpec documents.
- [x] Add `docs/credentials.md` with the Secrets Store first credential policy.

## Credential platform
- [ ] Create or select the production Cloudflare Secrets Store used by `anas-mcp`.
- [ ] Create separate staging/production secrets and verify independent rotation.
- [ ] Define the exact Secrets Store binding in `wrangler.jsonc` after the real store/secret IDs are available.
- [ ] Verify no production Worker-consumed credential is sourced from Wrangler `vars`, committed config, `.env`, `.dev.vars`, or source code.
- [ ] Add a CI/static check that rejects likely plaintext credential material and documents allowed non-secret `vars`.
- [ ] Document any credential that cannot use Secrets Store as an explicit OpenSpec exception before implementation.

## Google authentication
- [ ] Store the complete Google OAuth JSON credential in Cloudflare Secrets Store.
- [ ] Implement `services/google-auth.ts` to load the Secrets Store binding and validate the OAuth JSON credential.
- [ ] Exchange refresh token for short-lived Google access tokens.
- [ ] Keep derived Google access tokens runtime-only; do not persist them to Secrets Store, KV, D1, logs, or source control.
- [ ] Add tests for malformed credential JSON and token endpoint errors.

## GA4
- [ ] Implement `ga4_run_report` with bounded dates, dimensions, metrics, filters, and row limits.
- [ ] Implement `ga4_realtime`.
- [ ] Implement `ga4_metadata`.
- [ ] Add contract tests for request validation and provider error mapping.

## Search Console
- [ ] Implement `gsc_search_analytics` with bounded row limits and pagination rules.
- [ ] Implement `gsc_url_inspection`.
- [ ] Implement `gsc_list_sites`.
- [ ] Add contract tests for Search Console request validation and provider error mapping.

## Clarity / PostgreSQL
- [ ] Create a dedicated read-only PostgreSQL role for `anas-mcp`.
- [ ] Create/configure Cloudflare Hyperdrive and bind it as `ANALYTICS_DB`.
- [ ] Keep the database password only in the Hyperdrive connection; do not duplicate it into Secrets Store or Worker config.
- [ ] Define canonical MCP-facing Clarity views or canonical-run selection logic that prevents rolling-window double counting.
- [ ] Implement `clarity_overview`.
- [ ] Implement `clarity_pages`.
- [ ] Implement `clarity_page`.
- [ ] Add tests ensuring SQL is parameterized and no arbitrary SQL input is exposed.

## Production security and deployment
- [ ] Add MCP client authentication/authorization as a separate OpenSpec change.
- [ ] Store any long-lived MCP authentication secret consumed by the Worker in Cloudflare Secrets Store.
- [ ] Prefer workload identity/OIDC for CI-to-Cloudflare authentication where supported; otherwise document the protected CI bootstrap-secret exception and least-privilege scope.
- [ ] Configure production domain/route.
- [ ] Add CI checks for `npm run check`.
- [ ] Validate the deployed `/mcp` endpoint with MCP Inspector.

## Verification evidence
Bootstrap repository structure and documentation were created on 2026-09-08. The Secrets Store first credential policy was added on 2026-09-08. Runtime/typecheck verification remains pending until dependencies are installed by CI or a development environment.
