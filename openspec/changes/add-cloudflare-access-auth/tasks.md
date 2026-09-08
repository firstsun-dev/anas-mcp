# Tasks: Cloudflare Access authentication

## OpenSpec and project rules
- [x] Record Cloudflare Access Managed OAuth as the production `/mcp` authentication decision.
- [x] Update the baseline analytics MCP spec with Access authentication requirements.
- [x] Reject shared static bearer tokens and client-identification heuristics as the normal interactive MCP auth path.
- [x] Record that Access owns MCP OAuth state/tokens and no application OAuth datastore is required solely for authentication.

## Cloudflare Access configuration
- [ ] Select the production MCP hostname and path.
- [ ] Create a Cloudflare Access self-hosted application protecting the production `/mcp` resource.
- [ ] Enable Managed OAuth on the Access application.
- [ ] Configure the approved identity provider(s).
- [ ] Configure a default-deny Access policy with explicit allowed Firstsun users/groups/attributes.
- [ ] Confirm denied identities cannot reach the Worker `/mcp` handler.

## Worker integration
- [ ] Verify the existing stateless `createMcpHandler()` continues to work unchanged behind Access.
- [ ] If authenticated identity is needed in application code, add minimal trusted Access identity extraction without exposing token/assertion material.
- [ ] Ensure no Access token, JWT assertion, security header, or identity-provider token is logged or returned in MCP tool results.
- [ ] Keep `/health` minimal; if left public, verify the Access application is scoped so `/health` is not unintentionally protected or exposed with sensitive details.

## Documentation
- [x] Add `docs/cloudflare-access.md` operator guidance.
- [ ] Record the actual production hostname/path once selected.
- [ ] Record the actual Access application/policy names once created; do not record secret material.
- [ ] Document how an operator adds/removes an authorized identity.

## Verification
- [ ] Verify an unauthenticated `/mcp` request is blocked before tool execution.
- [ ] Verify Access exposes OAuth discovery suitable for a non-browser MCP client.
- [ ] Verify MCP Inspector can start and complete the Access Managed OAuth flow.
- [ ] Verify an allowed user can initialize MCP and list tools.
- [ ] Verify a denied user cannot initialize MCP.
- [ ] Verify ChatGPT custom MCP can connect without manually pasting a shared bearer token.
- [ ] Verify `/health` behavior matches the documented public/protected choice.

## Non-goals / guardrails
- [ ] Do not add `@cloudflare/workers-oauth-provider` unless a future accepted OpenSpec change demonstrates that Access Managed OAuth is insufficient.
- [ ] Do not add `OAUTH_KV`, D1, Durable Objects, or PostgreSQL tables solely for MCP authentication state.
- [ ] Do not add OpenAI IP allowlisting, User-Agent matching, query-string tokens, or shared static bearer-token auth.
- [ ] Do not use an Access service token as the normal interactive ChatGPT authentication path.

## Verification evidence
Documentation decision recorded on 2026-09-08. Cloudflare dashboard configuration and end-to-end MCP/ChatGPT verification are still pending and must not be marked complete until actually tested.
