# Tasks

- [x] `MCP_ROUTE` -> `/anas/mcp`; exact-path 404 for all other paths before auth (`src/index.ts`; `tests/mcp-path-routing.test.ts`).
- [x] Access validation, Host/Origin, `workers_dev=false`, `preview_urls=false`, minimal `/health` unchanged.
- [x] Update `openapi.yaml`, `scripts/smoke-prod.sh` (+ tests), README, AGENTS, docs, `openspec/project.md`, live spec.
- [x] Local gate: `pnpm install --frozen-lockfile && pnpm run check` (typecheck, vitest, redocly lint) passed.
- [ ] (Cutover, after infra-config apply) CI deploy + smoke on `main`.
- [ ] (Cutover, live) Unauthenticated challenge + `resource_metadata` on `/anas/mcp`; PRM `resource` identifier; AS metadata; Authorization Code + PKCE with dynamic client registration; authorized `initialize`; Service Token; wrong-AUD / blocked identity; `/anas` and `/mcp` dead; no workers.dev / Preview.
- [ ] (Cutover) Owner re-points ChatGPT to `https://mcp.firstsun.org/anas/mcp`; close anas-mcp#30 only after the above.
