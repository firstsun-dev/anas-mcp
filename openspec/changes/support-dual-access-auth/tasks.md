# Tasks: concurrent dual-mode Cloudflare Access authentication

## Decision
- [x] Define Mode A as Managed OAuth for interactive clients.
- [x] Define Mode B as Access Service Token for headless agents.
- [x] Require A and B to be enabled simultaneously on the same production `/mcp`.
- [x] Require identity Allow policy for OAuth users and `Service Auth` policy for Service Tokens.
- [x] Require Worker validation of `Cf-Access-Jwt-Assertion`.
- [x] Mark OAuth-only and Worker-local API-key-only decisions as superseded.
- [x] Synchronize active project/baseline OpenSpec.

## Cloudflare Access
- [ ] Confirm production hostname and `/mcp` path.
- [ ] Create/update the Access application protecting `/mcp`.
- [ ] Enable Managed OAuth.
- [ ] Configure approved IdP and default-deny interactive identity policy.
- [ ] Configure OAuth dynamic-client/redirect behavior required by ChatGPT and approved clients.
- [ ] Record team domain and application AUD without secret material.
- [ ] Confirm Mode A continues to work while Mode B is configured.

## Service Token mode
- [ ] Create a dedicated Service Token for an initial headless-agent integration.
- [ ] Create a `Service Auth` policy matching that token.
- [ ] Verify standard `CF-Access-Client-Id` + `CF-Access-Client-Secret` requests.
- [ ] Decide whether any target AI client actually requires single-header Service Token support.
- [ ] If required, configure a dedicated non-`Authorization` `read_service_tokens_from_header` header and test it.
- [ ] Verify invalid/expired/revoked Service Tokens fail with 401/403 and do not redirect to interactive login.

## Worker migration
- [x] Implement Access JWT validation for `Cf-Access-Jwt-Assertion` before MCP initialization.
- [x] Verify JWKS signature, issuer/team domain, application AUD, and time validity.
- [x] Remove `ANAS_MCP_API_KEY` production request authentication.
- [x] Remove its Secrets Store binding from Worker configuration.
- [x] Remove Worker-local bearer comparison from the production request path.
- [x] Ensure no OAuth token, Access assertion, Service Token Client ID/Secret, or security header is logged.
- [x] Keep `/health` minimal/public according to the selected Access path scope.

## Tests and docs
- [x] Add tests for missing/invalid Access assertion.
- [x] Add tests that a valid Access assertion reaches MCP.
- [x] Add regression test that MCP/tools/Hyperdrive do not execute before assertion validation.
- [x] Update `openapi.yaml`, `AGENTS.md`, `README.md`, auth docs, credentials docs, and CI smoke guidance.
- [x] Remove active documentation that presents the Worker-local API key as production auth.
- [x] Preserve historical OpenSpec/PR evidence without treating it as active architecture.

## E2E
- [ ] Managed OAuth: ChatGPT can authenticate, initialize, list tools, and call a read-only tool.
- [ ] Managed OAuth: denied identity cannot initialize MCP.
- [ ] Service Token: approved headless agent can initialize and list tools on the same endpoint.
- [ ] Service Token: invalid/revoked token cannot initialize MCP.
- [ ] Concurrency: verify a working Service Token configuration does not break a working OAuth flow, and vice versa.
- [ ] Inspect production logs and confirm no auth credential/assertion leakage.

## Verification evidence

2026-10-07: OpenSpec-only architecture update. The currently merged PR #8 still implements Worker-local API-key authentication and is transitional. Cloudflare Access configuration, Worker JWT validation, removal of `ANAS_MCP_API_KEY`, and dual-mode E2E remain pending.

2026-10-07 (issue #9, branch `feat/dual-access-auth`), Worker side only:
- Worker: `src/auth/cloudflare-access.ts` verifies `Cf-Access-Jwt-Assertion` with `jose` (RS256 only, Access team JWKS, issuer `https://<team>.cloudflareaccess.com`, application AUD, required `exp`/`iss`/`aud`, `nbf`, 5 s skew) before `createMcpHandler()`/`createServer()`/Hyperdrive. Missing or invalid -> generic `401`; missing `ACCESS_TEAM_DOMAIN`/`ACCESS_AUD` -> generic `503` (fail closed). `/health` unchanged and public.
- Removed: `src/auth/mcp-api-key.ts`, the `ANAS_MCP_API_KEY` Secrets Store binding in `wrangler.jsonc`, and API-key OpenAPI semantics. A guardrail test now fails if the API key, Secrets Store binding, or an `Authorization` read returns to `src/` or `wrangler.jsonc`.
- `npm run check` passes: typecheck clean; 49 tests passed, 5 skipped (existing Postgres integration tests that need a live DB). `tests/mcp-auth.test.ts` uses locally generated RSA keys and a local JWKS (no real credentials) to cover missing/malformed/bad-signature/tampered/`alg=none`/HS256/wrong-issuer/wrong-AUD/expired/not-yet-valid rejection, valid assertion reaching MCP (single and array AUD), no `pg` constructor call on any rejection, fail-closed 503, and no logging of assertions, OAuth bearer, Service Token headers, or the AUD.
- Local `wrangler dev` smoke (dummy local Hyperdrive string): `GET /health` -> 200 minimal body; `POST /mcp` with empty Access vars -> `503 {"error":"auth_unavailable"}`; logs contain only `{"event":"access_rejected","reason":"access_not_configured"}`. A real assertion cannot be minted locally, so the valid path is covered by the unit tests only. MCP Inspector was not run.
- `openapi.yaml` updated for Access (`CloudflareAccessOAuth`, `CloudflareAccessServiceToken`, `401`, `503`). `npx @redocly/cli lint` reports one structural error on the pre-existing `text/event-stream` `description` line and a missing `license`; no OpenAPI 3.2 validator is wired into `npm run check`, so OpenAPI validation is still NOT complete.
- Deployment behavior (verified): this repository has no `.github/workflows` caller, no Actions runs, and no GitHub deployments, so merging to `main` does not deploy; what is live in production and how it was deployed is unverified. Rollout ordering is in `docs/cloudflare-access.md`.
- NOT done and NOT claimed: every Cloudflare Access, Service Token, and E2E item above (blocked on `firstsun-dev/infra-config#59` being applied), filling `ACCESS_TEAM_DOMAIN`/`ACCESS_AUD` (values only exist after the Access application is applied), deleting the old `ANAS_PROD_MCP_API_KEY` secret from Secrets Store, ChatGPT OAuth E2E, Service Token production E2E, concurrent A+B validation, and production log inspection.
