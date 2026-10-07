# Tasks: dedicated bearer API-key authentication

## OpenSpec decision
- [x] Record dedicated `Authorization: Bearer` API-key authentication for production `/mcp`.
- [x] Record Cloudflare Secrets Store as the credential source of truth.
- [x] Prohibit reuse of Cloudflare/provider/database/deployment credentials.
- [x] Record service-level authorization semantics and future OAuth triggers.
- [x] Mark `add-cloudflare-access-auth` as superseded historical rationale.
- [x] Synchronize the active project and baseline spec with this decision.

## Runtime
- [ ] Provision a high-entropy production key in Cloudflare Secrets Store.
- [ ] Bind it as `ANAS_MCP_API_KEY` or the final reviewed binding name. (Binding declared in `wrangler.jsonc`; stays open until the secret exists in production Secrets Store and the deployed Worker is verified.)
- [x] Add a `/mcp` auth gate before MCP initialization/tool execution.
- [x] Reject missing, malformed, or invalid bearer credentials.
- [x] Prevent credential/header leakage in logs and responses.
- [x] Use timing-safe comparison where practical.
- [x] Keep `/health` minimal and free of auth/credential state.

## Tests
- [x] Test missing Authorization header.
- [x] Test wrong auth scheme.
- [x] Test invalid bearer credential.
- [x] Test valid authentication reaches MCP initialization.
- [x] Test invalid authentication cannot execute a tool.
- [x] Add regression coverage preventing credential/header logging.

## Contract and docs
- [x] Update `openapi.yaml` bearer security description without embedding a real key.
- [x] Update `AGENTS.md`.
- [x] Update `README.md`.
- [x] Replace/rewrite `docs/cloudflare-access.md` with current API-key operator/client guidance.
- [x] Update `docs/credentials.md`.
- [x] Ensure CI/deployment docs no longer assume Managed OAuth.

## E2E verification
- [ ] Verify missing and invalid credentials cannot initialize MCP.
- [ ] Verify MCP Inspector can initialize and list tools with the valid key.
- [ ] Verify the approved ChatGPT MCP connection can initialize and call a read-only tool with the valid key.
- [ ] Verify logs contain no raw Authorization header or credential material.
- [ ] Verify rotation invalidates the old key.

## Verification evidence

2026-10-07: OpenSpec-only decision update. Runtime authentication, secret provisioning, OpenAPI/application documentation, and deployed-client verification remain pending.

2026-10-07 (issue #7, branch `feat/mcp-api-key-auth`):
- `npm run typecheck` and `npm test` (via `npm run check`) pass; new `tests/mcp-auth.test.ts` covers missing/wrong-scheme/malformed/empty/invalid bearer, fail-closed on missing/throwing/empty binding, no Hyperdrive (`pg`) access on rejection, valid key reaching MCP, no credential logging, and unauthenticated `/health`.
- Local `wrangler dev` with a locally simulated Secrets Store secret (random key, not printed or committed) via curl: no auth, wrong token, and Basic scheme -> `401`; valid key -> MCP `initialize` and `tools/list` (health, bing_list_sites, bing_search_performance); `GET /health` -> `{"service":"anas-mcp","status":"ok"}`; key absent from dev logs. MCP Inspector itself was not run (curl used).
- NOT done (operator follow-ups): production key provisioning in Secrets Store (`ANAS_PROD_MCP_API_KEY`, command in `docs/mcp-authentication.md`; must exist before deploy), deployed-endpoint verification, deployed ChatGPT E2E, production log inspection, and rotation verification. OpenAPI automated validation is still not wired into CI (YAML parses; no 3.2 validator run).
