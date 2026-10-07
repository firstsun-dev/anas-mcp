# Proposal: dedicated bearer API-key authentication

## Why

`anas-mcp` is currently a private, read-only analytics MCP service with a small trusted-client surface. It does not currently need per-user identity, delegated authorization, user-specific scopes, or an application user lifecycle.

Cloudflare Access Managed OAuth adds an identity-provider and browser authorization flow that is not required for this service model. A dedicated application API key provides the required production boundary with less operational complexity while preserving the existing stateless Worker architecture.

## Decision

Use a **dedicated bearer API key** as the production authentication boundary for `/mcp`.

Clients send:

```http
Authorization: Bearer <ANAS_MCP_API_KEY>
```

The secret value is application-owned and stored in Cloudflare Secrets Store. It is only an `anas-mcp` access credential: it must not be a Cloudflare API token and must not be reused for Google, Bing, Clarity, PostgreSQL, CI/CD, or another system.

This decision supersedes `openspec/changes/add-cloudflare-access-auth/`.

## Scope

In scope:
- production `/mcp` bearer authentication
- Secrets Store ownership of the MCP credential
- missing/invalid credential rejection before MCP execution
- credential isolation and rotation expectations
- OpenAPI/documentation/client verification updates

Out of scope:
- per-user accounts/scopes
- custom OAuth provider implementation
- Cloudflare Access Managed OAuth rollout
- unrelated datasource implementation

## Future OAuth trigger

A new OpenSpec decision should evaluate OAuth or another identity-aware mechanism when requirements include multiple independently authorized users, per-user revocation/audit, delegated third-party access, SSO, or per-user/per-tool authorization.

## Success criteria

- Missing or invalid credentials cannot reach MCP initialization/tool execution.
- A valid dedicated credential can initialize MCP and invoke the existing read-only tools.
- The credential is stored in Cloudflare Secrets Store and absent from source, Wrangler `vars`, logs, and responses.
- The credential is not a Cloudflare API token or another reused system secret.
- The service remains stateless for MCP client authentication.
