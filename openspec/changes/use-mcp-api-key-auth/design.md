> **Status: superseded by concurrent dual-mode Access authentication (2026-10-07).** The Worker-local bearer API-key implementation from PR #8 is transitional. The active architecture uses Managed OAuth and Cloudflare Access Service Tokens simultaneously, with Worker validation of the Access assertion. See `openspec/changes/support-dual-access-auth/`.

# Design: dedicated bearer API-key authentication

## Architecture

```text
ChatGPT / MCP client
        |
        | Authorization: Bearer <dedicated anas-mcp key>
        v
Cloudflare Worker: anas-mcp
        |
        | validate bearer credential
        v
stateless createMcpHandler() at /mcp
        |
        v
read-only analytics tools
```

## Credential ownership

Cloudflare Secrets Store is the production source of truth. Intended binding: `ANAS_MCP_API_KEY`.

Rules:
- generate a high-entropy random credential outside source control
- never place it in source, Wrangler `vars`, `.env`, `.dev.vars`, logs, fixtures, or documentation
- never reuse `CLOUDFLARE_API_TOKEN` or provider/database/deployment credentials
- use independent staging/production credentials when both environments exist

## Request handling

For production `/mcp`:
1. Read `Authorization`.
2. Require the Bearer scheme.
3. Compare the supplied credential with the Secrets Store value.
4. Reject missing/invalid credentials before MCP initialization or tool execution.
5. Never log the raw header, supplied token, configured token, or comparison material.
6. Continue to the existing stateless MCP handler only after authentication succeeds.

A timing-safe comparison SHOULD be used where practical.

## Authorization semantics

The credential grants service-level access to the existing read-only MCP surface. It does not represent an individual user and does not provide per-user audit, revocation, delegated authorization, or per-tool scopes.

## Health endpoint

`/health` may remain unauthenticated but must not disclose authentication configuration, secret-binding state, provider credentials, database details, or analytics data.

## OpenAPI

Represent `/mcp` with an HTTP bearer security scheme whose bearer value is the dedicated `anas-mcp` API key. Do not publish OAuth endpoints or embed a real credential.

## Rotation

Rotate by generating a new high-entropy key, updating Secrets Store, updating approved clients, verifying the new key, and confirming the old key no longer authenticates. If zero-downtime dual-key rotation becomes necessary, specify it explicitly rather than retaining permanent multiple credentials.

## Future migration

OAuth or another identity-aware mechanism requires a future accepted OpenSpec change when per-user identity/authorization becomes necessary.
