# MCP authentication (dedicated bearer API key)

Decision: `openspec/changes/use-mcp-api-key-auth/`. This replaces the superseded Cloudflare Access Managed OAuth design (`docs/cloudflare-access.md`).

```text
MCP client --Authorization: Bearer <key>--> Worker anas-mcp
                                              | authenticate (src/auth/mcp-api-key.ts)
                                              v
                                       createMcpHandler() -> read-only tools
```

## Behavior

- `/mcp` requires `Authorization: Bearer <ANAS_MCP_API_KEY>`. Authentication runs before MCP initialization, `createServer()`, and any tool or database access.
- Missing header, non-Bearer scheme, malformed or empty token, wrong token, or an unavailable/empty Secrets Store binding all return the same generic response: `401 {"error":"unauthorized"}` with `WWW-Authenticate: Bearer`. It never reveals prefix/length matches or binding state.
- The comparison hashes both values with SHA-256 and compares digests in constant time; nothing is logged.
- `GET /health` is public and returns only `{"service":"anas-mcp","status":"ok"}`.
- The key is service-level: no per-user identity, audit, or per-tool scope.

## Provisioning (operator)

Production binding in `wrangler.jsonc`: store `a2a4a60a04b142d3a0c7d482542e67fc`, secret `ANAS_PROD_MCP_API_KEY`, binding `ANAS_MCP_API_KEY`. The secret **must exist before deploy**; the value is never committed.

```bash
KEY=$(openssl rand -hex 32)          # 256-bit; do not echo it
CLOUDFLARE_ACCOUNT_ID=<account that owns the Worker> \
  npx wrangler secrets-store secret create a2a4a60a04b142d3a0c7d482542e67fc \
  --name ANAS_PROD_MCP_API_KEY --scopes workers --remote --value "$KEY"
# store $KEY in the operator's password manager / ChatGPT connection, then: unset KEY
```

## Local development

`wrangler dev` simulates the binding locally (no `--remote`):

```bash
npx wrangler secrets-store secret create a2a4a60a04b142d3a0c7d482542e67fc \
  --name ANAS_PROD_MCP_API_KEY --scopes workers --value "$(openssl rand -hex 32)"
```

Local secrets live under `.wrangler/` (gitignored). Do not use `.dev.vars`.

## Client setup

Configure the MCP client (ChatGPT custom connector, MCP Inspector, etc.) with the `/mcp` URL and a custom `Authorization: Bearer <key>` header. Never put the key in a query string.

## Rotation

1. Generate a new key; update `ANAS_PROD_MCP_API_KEY` in Secrets Store.
2. Update approved clients.
3. Verify the new key works and the old key returns `401`.

Dual-key rotation would need an explicit OpenSpec change.

## Not substitutes

`CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, Bing/Google/Clarity credentials, PostgreSQL/Hyperdrive credentials, and CI deployment tokens must never be used as the MCP key.
