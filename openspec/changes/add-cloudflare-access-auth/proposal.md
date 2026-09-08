# Proposal: Cloudflare Access authentication

## Why

`anas-mcp` exposes operational analytics to MCP clients such as ChatGPT. The production `/mcp` endpoint must have a standards-based identity boundary without distributing a shared API key or making the Worker maintain its own user/token database.

Cloudflare Access Managed OAuth provides that boundary at the edge. It supports non-browser clients through OAuth discovery and authorization-code flow while reusing the organization's existing Access identity providers and policies.

## Decision

Use **Cloudflare Access Managed OAuth** as the required production authentication and authorization layer for `/mcp`.

The target flow is:

```text
ChatGPT / MCP client
        |
        | OAuth discovery + authorization code + PKCE
        v
Cloudflare Access
        |
        | Access identity provider + policy evaluation
        v
anas-mcp /mcp
```

## What changes

- Protect production `/mcp` with a Cloudflare Access self-hosted application.
- Enable Managed OAuth on that Access application.
- Use Access policies as the primary user authorization boundary.
- Keep the Worker stateless for MCP client authentication.
- Do not introduce application-managed OAuth token persistence solely for MCP authentication.
- Document how MCP Inspector and ChatGPT should connect through the Access OAuth flow.
- Keep `/health` minimal and optionally public if Access protection is scoped only to `/mcp`.

## Explicitly rejected alternatives

The normal interactive MCP authentication path must not use:

- a shared static bearer token
- query-string secrets
- OpenAI IP allowlisting
- User-Agent matching
- a custom application username/password database
- a Worker-hosted OAuth token database when Access Managed OAuth is sufficient

Machine-to-machine service-token access, if ever needed, must be proposed separately and must not replace the normal ChatGPT user-authentication flow.

## Scope

### In scope

- Cloudflare Access as production `/mcp` authentication.
- Managed OAuth enablement and policy requirements.
- Standards-based MCP client login behavior.
- Access identity propagation rules.
- Operational documentation and verification steps.

### Out of scope

- GA4 implementation.
- Search Console implementation.
- Clarity query implementation.
- Custom OAuth provider implementation in the Worker.
- Persisted application user accounts.
- Fine-grained per-tool scopes beyond the existing read-only service boundary.

## Success criteria

- Baseline OpenSpec states that production `/mcp` requires Cloudflare Access Managed OAuth.
- Unauthorized clients cannot invoke MCP tools.
- Authorized users can complete OAuth through Access and reach MCP initialization.
- Access policy remains default-deny with explicit approved identities/groups.
- No shared static token is required by ChatGPT.
- No application datastore is introduced solely for MCP OAuth state.
- Access token/assertion material is not exposed in tool output or logs.
