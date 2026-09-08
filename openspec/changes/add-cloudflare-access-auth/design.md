# Design: Cloudflare Access authentication

## Architecture

Production MCP authentication terminates at Cloudflare Access before requests reach the Worker.

```text
ChatGPT / MCP client
        |
        | OAuth 2.x discovery + authorization code + PKCE
        v
Cloudflare Access Managed OAuth
        |
        | IdP authentication + Access policy
        v
Cloudflare Worker: anas-mcp
        |
        +--> stateless createMcpHandler() at /mcp
```

The Worker remains stateless for MCP client authentication. It does not issue its own long-lived MCP credentials or maintain an OAuth token database.

## Access application

Create a Cloudflare Access self-hosted application covering the production MCP resource, preferably the `/mcp` path on the production hostname.

Enable **Managed OAuth** in the Access application advanced settings so standards-compliant non-browser clients can discover OAuth metadata, launch the user's browser for login, complete authorization code + PKCE, and receive an Access-managed token for subsequent requests.

Access policy is authoritative. Use default deny and explicitly allow approved Firstsun users, groups, or identity-provider attributes.

## MCP server implementation

Preserve the existing runtime:

- Cloudflare Workers
- stateless Streamable HTTP
- `/mcp`
- `createMcpHandler()`
- fresh `McpServer` construction per request

Do not migrate to `McpAgent` or Durable Objects for authentication.

Do not add `@cloudflare/workers-oauth-provider` merely to duplicate Managed OAuth. If future MCP requirements cannot be satisfied by Access Managed OAuth, that must be a separate OpenSpec decision.

## OAuth state ownership

Cloudflare Access owns the client-facing OAuth authorization state and access tokens.

Therefore this design does **not** require:

- `OAUTH_KV`
- D1
- Durable Objects
- PostgreSQL OAuth tables
- application-issued shared bearer tokens

`anas-mcp` must not copy Access-managed token material into Secrets Store or another datastore.

## Identity propagation

If the Worker needs caller identity for audit or future authorization logic, consume the minimum trusted identity/context that Cloudflare Access forwards with an authenticated request.

Rules:

- never return raw Access bearer tokens or JWT assertions in MCP results
- never log raw security headers or token bodies
- avoid persisting identity unless a future accepted requirement needs it
- Access policy remains the primary authorization decision

## Health endpoint

`/health` may remain unauthenticated if the Access application is scoped to `/mcp` only.

The endpoint must return readiness only, for example:

```json
{"status":"ok"}
```

It must not expose Access configuration, secret bindings, Google token state, Hyperdrive configuration, or analytics data.

## Credential interaction

This authentication design does not change the project's Secrets Store first policy.

Cloudflare Access Managed OAuth is a platform-managed authentication layer, so its client/session/token material is not duplicated into the Worker's Secrets Store.

Secrets Store remains required for long-lived credentials consumed directly by `anas-mcp`, such as the Google OAuth JSON credential.

## Rejected patterns

Do not use the following as the normal ChatGPT authentication path:

- shared static token
- API key in URL/query string
- OpenAI IP allowlist
- User-Agent matching
- Cloudflare Access service token for an interactive user flow
- Worker-local username/password authentication

A service-token based machine-to-machine path may be added only through a separate accepted change with an explicit use case.

## Verification

Verify the production boundary in this order:

1. Unauthenticated request to `/mcp` cannot reach MCP tool execution.
2. The response exposes the Access Managed OAuth discovery path expected by an OAuth-capable client.
3. MCP Inspector can initiate the OAuth flow.
4. The user can authenticate through the configured Access identity provider.
5. A user allowed by policy can initialize MCP and list tools.
6. A user denied by policy cannot reach `/mcp`.
7. ChatGPT custom MCP can connect without manually pasting a shared bearer token.
8. `/health`, if public, returns only minimal readiness.

## Operational references

Use current Cloudflare documentation when implementing or configuring this design:

- Cloudflare Agents MCP authorization: https://developers.cloudflare.com/agents/model-context-protocol/protocol/authorization/
- Cloudflare Access Managed OAuth: https://developers.cloudflare.com/changelog/post/2026-03-20-managed-oauth/
- Secure MCP servers with Access: https://developers.cloudflare.com/cloudflare-one/access-controls/ai-controls/secure-mcp-servers/
