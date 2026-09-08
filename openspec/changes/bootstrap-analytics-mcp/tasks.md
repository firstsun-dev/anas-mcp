# Tasks: bootstrap analytics MCP

## Foundation
- [x] Initialize repository and package manifest.
- [x] Add Cloudflare Worker configuration.
- [x] Add stateless `/mcp` handler and `/health` endpoint.
- [x] Add initial MCP `health` tool.
- [x] Add project instructions and baseline OpenSpec documents.

## Google authentication
- [ ] Define the exact Secrets Store binding in `wrangler.jsonc` after the real store/secret IDs are available.
- [ ] Implement `services/google-auth.ts` to load and validate the OAuth JSON credential.
- [ ] Exchange refresh token for short-lived Google access tokens.
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
- [ ] Define canonical MCP-facing Clarity views or canonical-run selection logic that prevents rolling-window double counting.
- [ ] Implement `clarity_overview`.
- [ ] Implement `clarity_pages`.
- [ ] Implement `clarity_page`.
- [ ] Add tests ensuring SQL is parameterized and no arbitrary SQL input is exposed.

## Production security and deployment
- [ ] Add MCP client authentication/authorization as a separate OpenSpec change.
- [ ] Configure production domain/route.
- [ ] Add CI checks for `npm run check`.
- [ ] Validate the deployed `/mcp` endpoint with MCP Inspector.

## Verification evidence
Bootstrap repository structure and documentation were created on 2026-09-08. Runtime/typecheck verification remains pending until dependencies are installed by CI or a development environment.
