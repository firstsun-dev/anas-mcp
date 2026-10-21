# Tasks

- [x] Route `/mcp` -> `/anas`; exact-path 404 for all other paths before auth (`src/index.ts`; `tests/mcp-path-routing.test.ts`).
- [x] Keep Access assertion validation, Host/Origin handling, `workers_dev=false`, `preview_urls=false`, minimal `/health`.
- [x] Update `openapi.yaml`, `scripts/smoke-prod.sh` (+ `tests/smoke-script.test.ts`), README, AGENTS, docs, `openspec/project.md`, live spec.
- [x] Local gate: `pnpm run check` (typecheck, vitest, redocly lint).
- [ ] (Cutover, after infra-config Access apply) CI deploy + smoke on `main`.
- [ ] (Cutover) Live: Managed OAuth + PKCE via `/anas` PRM, Service Token, wrong-AUD/blocked identity, `/mcp` dead, `/anas2` dead, no workers.dev/Preview.
- [ ] (Cutover) Owner points ChatGPT at `https://mcp.firstsun.org/anas`; close anas-mcp#28 only after the above.
