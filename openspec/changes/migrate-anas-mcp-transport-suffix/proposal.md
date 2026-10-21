# Proposal: serve the ANAS MCP endpoint at `/anas/mcp` (retire bare `/anas`)

Implements the application side of the revised organization contract
[`firstsun-dev/.github` PR #60](https://github.com/firstsun-dev/.github/pull/60): MCP services are served at
`https://mcp.firstsun.org/{service}/mcp`. Issue: [anas-mcp#30](https://github.com/firstsun-dev/anas-mcp/issues/30).
Infrastructure side: [infra-config#115](https://github.com/firstsun-dev/infra-config/issues/115) (branch
`feat/anas-mcp-transport-suffix`).

This is a follow-up to `migrate-mcp-endpoint-to-anas` (`/mcp` -> `/anas`, already merged). That change is historical context
and is not rewritten.

## What changes

- `MCP_ROUTE` and the `createMcpHandler()` route become exactly `/anas/mcp`.
- Exact-path routing is unchanged in shape: every other path (`/anas`, `/mcp`, `/anas/mcp/`, `/anas/mcp2`, `/anas2/mcp`,
  `/infra/mcp`, ...) is `404 {"error":"not_found"}` before JWKS fetch, MCP initialization or database access. No redirect or alias.
- `scripts/smoke-prod.sh` probes the new negative paths and **discovers** the protected-resource metadata URL from the
  `resource_metadata` parameter of the unauthenticated `WWW-Authenticate` challenge instead of hardcoding a
  `/.well-known/...` path (Cloudflare Access is the source of truth for that URL and its path form for nested resources
  has not been observed live).
- `openapi.yaml`, README, AGENTS, docs, live spec and tests reference `/anas/mcp`.

## Unchanged (explicitly)

Dual-mode Cloudflare Access (Managed OAuth + Service Token); Worker-side JWT validation (signature, issuer, AUD, exp/nbf)
before MCP; `ACCESS_AUD` / `ACCESS_TEAM_DOMAIN` (the Access application is updated in place); `workers_dev=false`,
`preview_urls=false`; Host/Origin handling; read-only GA4, GSC, Bing, Clarity tools; minimal public `GET /health`;
centralized production CI/CD.

## Deployment safety

Merging to `main` deploys production. Do not merge before the coordinated cutover in `firstsun-dev/infra-config`
`docs/mcp-anas-transport-suffix-cutover.md`. At every intermediate state a request without a valid Access assertion cannot
execute tools (the Worker validates the assertion; it 404s non-canonical paths).
