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
- [ ] Bind it as `ANAS_MCP_API_KEY` or the final reviewed binding name.
- [ ] Add a `/mcp` auth gate before MCP initialization/tool execution.
- [ ] Reject missing, malformed, or invalid bearer credentials.
- [ ] Prevent credential/header leakage in logs and responses.
- [ ] Use timing-safe comparison where practical.
- [ ] Keep `/health` minimal and free of auth/credential state.

## Tests
- [ ] Test missing Authorization header.
- [ ] Test wrong auth scheme.
- [ ] Test invalid bearer credential.
- [ ] Test valid authentication reaches MCP initialization.
- [ ] Test invalid authentication cannot execute a tool.
- [ ] Add regression coverage preventing credential/header logging.

## Contract and docs
- [ ] Update `openapi.yaml` bearer security description without embedding a real key.
- [ ] Update `AGENTS.md`.
- [ ] Update `README.md`.
- [ ] Replace/rewrite `docs/cloudflare-access.md` with current API-key operator/client guidance.
- [ ] Update `docs/credentials.md`.
- [ ] Ensure CI/deployment docs no longer assume Managed OAuth.

## E2E verification
- [ ] Verify missing and invalid credentials cannot initialize MCP.
- [ ] Verify MCP Inspector can initialize and list tools with the valid key.
- [ ] Verify the approved ChatGPT MCP connection can initialize and call a read-only tool with the valid key.
- [ ] Verify logs contain no raw Authorization header or credential material.
- [ ] Verify rotation invalidates the old key.

## Verification evidence

2026-10-07: OpenSpec-only decision update. Runtime authentication, secret provisioning, OpenAPI/application documentation, and deployed-client verification remain pending.
