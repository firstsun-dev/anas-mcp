# Tasks: Search Console MCP tools

## Contract
- [x] OpenSpec change before code; issue #16 updated with requirements and acceptance criteria
- [ ] Operator: enable Search Console API in the Google Cloud project
- [ ] Operator: confirm the existing refresh token includes `webmasters.readonly`
- [ ] Operator: confirm the authorized account can access each intended property
- [x] `GSC_ALLOWED_SITES` set in `wrangler.jsonc` `vars` to the two operator-supplied identifiers
- [ ] Operator: verify those identifiers via `gsc_list_sites` after deploy

## Implementation
- [x] `src/services/google-search-console.ts`
- [x] `src/tools/google-search-console.ts` and registration; `health` gating
- [x] Guardrail tests extended for the new Google module (fixed host, no new scopes, no new vars)
- [x] No `openapi.yaml` change (no HTTP surface change)

## Verification
- [x] Review fixes (PR #25): rows whose `keys` length differs from requested dimensions -> `malformed_response`; 5xx `Retry-After` honored exactly within 5 s, never shortened, >5 s not slept (`retryAfterSeconds` surfaced); `first_incomplete_date` documented as dataState=all + date grouping
- [x] `pnpm run check`: typecheck, 336 tests passed (22 skipped, Postgres integration), `redocly lint` valid (3 existing warnings in unchanged openapi.yaml)
- [x] `pnpm exec wrangler deploy --dry-run` OK (bindings unchanged)
- [ ] MCP Inspector against `wrangler dev` (not run: needs Access assertion and live Google; the `/mcp` handler is exercised end to end with mocked Google in `tests/gsc-mcp.test.ts`)
- [ ] Production GSC query through Cloudflare Access (not claimed)
