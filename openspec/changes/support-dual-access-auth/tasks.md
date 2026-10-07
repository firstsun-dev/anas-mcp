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
- [ ] Implement Access JWT validation for `Cf-Access-Jwt-Assertion` before MCP initialization.
- [ ] Verify JWKS signature, issuer/team domain, application AUD, and time validity.
- [ ] Remove `ANAS_MCP_API_KEY` production request authentication.
- [ ] Remove its Secrets Store binding from Worker configuration.
- [ ] Remove Worker-local bearer comparison from the production request path.
- [ ] Ensure no OAuth token, Access assertion, Service Token Client ID/Secret, or security header is logged.
- [ ] Keep `/health` minimal/public according to the selected Access path scope.

## Tests and docs
- [ ] Add tests for missing/invalid Access assertion.
- [ ] Add tests that a valid Access assertion reaches MCP.
- [ ] Add regression test that MCP/tools/Hyperdrive do not execute before assertion validation.
- [ ] Update `openapi.yaml`, `AGENTS.md`, `README.md`, auth docs, credentials docs, and CI smoke guidance.
- [ ] Remove active documentation that presents the Worker-local API key as production auth.
- [ ] Preserve historical OpenSpec/PR evidence without treating it as active architecture.

## E2E
- [ ] Managed OAuth: ChatGPT can authenticate, initialize, list tools, and call a read-only tool.
- [ ] Managed OAuth: denied identity cannot initialize MCP.
- [ ] Service Token: approved headless agent can initialize and list tools on the same endpoint.
- [ ] Service Token: invalid/revoked token cannot initialize MCP.
- [ ] Concurrency: verify a working Service Token configuration does not break a working OAuth flow, and vice versa.
- [ ] Inspect production logs and confirm no auth credential/assertion leakage.

## Verification evidence

2026-10-07: OpenSpec-only architecture update. The currently merged PR #8 still implements Worker-local API-key authentication and is transitional. Cloudflare Access configuration, Worker JWT validation, removal of `ANAS_MCP_API_KEY`, and dual-mode E2E remain pending.
