# Proposal: serve the ANAS MCP endpoint at `/anas` (retire `/mcp`)

Implements the application side of the organization contract
[`firstsun-dev/.github` PR #59](https://github.com/firstsun-dev/.github/pull/59) (`standardize-mcp-path-hosting`,
capability `mcp-service-hosting`). Issue: [anas-mcp#28](https://github.com/firstsun-dev/anas-mcp/issues/28). Infrastructure
side: [infra-config#112](https://github.com/firstsun-dev/infra-config/issues/112) (branch `feat/mcp-path-routing`).

## Why

`mcp.firstsun.org` becomes a shared hostname for independent MCP services at `/{service}`. `/mcp` is not a service identity.
The move is deliberately breaking: no alias, redirect or compatibility window (owner decision 2026-10-21).

## What changes

- `createMcpHandler()` route `/mcp` -> `/anas` (`MCP_ROUTE` in `src/index.ts`).
- Exact-path routing in the Worker: every path except `/anas` (and `GET /health`) returns `404 {"error":"not_found"}`
  *before* authentication, JWKS fetch, MCP initialization or database access. This covers `/mcp`, `/anas2`, `/anas/`,
  `/anas/x`, case variants and other services' slugs.
- `openapi.yaml`, `scripts/smoke-prod.sh` (now also asserts `/mcp` and `/anas2` serve nothing and the `/anas`
  protected-resource metadata), docs, README, AGENTS, tests and the live spec reference `/anas`.

## Unchanged (explicitly)

Dual-mode Cloudflare Access auth (Managed OAuth + Service Token) and the decision in `support-dual-access-auth`;
Worker-side JWT validation (signature, issuer, AUD, exp/nbf) before MCP; `ACCESS_AUD` / `ACCESS_TEAM_DOMAIN` (the Access
application is updated in place, AUD unchanged: infra-config plan evidence); `workers_dev=false`, `preview_urls=false`;
Host/Origin handling; read-only analytics tools (GA4, GSC, Bing, Clarity, PostgreSQL/Hyperdrive); minimal public
`GET /health`; production-only CI/CD. Historical changes under `openspec/changes/` are not rewritten.

## Deployment safety

Merging to `main` deploys production (central CI). Do not merge before the coordinated cutover; the order and recovery are in
`firstsun-dev/infra-config` `docs/mcp-anas-path-cutover.md`: Terraform (Access path) first, then this PR. Every
intermediate state stays fail-closed because the Worker validates the Access assertion and 404s non-`/anas` paths. Live
Managed OAuth/PKCE, Service Token, and path-scoped discovery verification are **pending** the cutover; unit tests do not
prove them.
