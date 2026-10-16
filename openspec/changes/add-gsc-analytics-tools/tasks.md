# Tasks: Search Console MCP tools

## Contract
- [x] OpenSpec change before code; issue #16 updated with requirements and acceptance criteria
- [ ] Operator: enable Search Console API in the Google Cloud project
- [ ] Operator: confirm the existing refresh token includes `webmasters.readonly`
- [ ] Operator: confirm the authorized account can access each intended property
- [ ] Operator: set `GSC_ALLOWED_SITES` (verified identifiers) in `wrangler.jsonc` `vars`; production GSC stays disabled until then

## Implementation
- [x] `src/services/google-search-console.ts`
- [x] `src/tools/google-search-console.ts` and registration; `health` gating
- [x] Guardrail tests extended for the new Google module (fixed host, no new scopes, no new vars)
- [x] No `openapi.yaml` change (no HTTP surface change)

## Verification
- [x] `pnpm run check`: typecheck, 331 tests passed (22 skipped, Postgres integration), `redocly lint` valid (3 existing warnings in unchanged openapi.yaml)
- [ ] MCP Inspector against `wrangler dev` (not run)
- [ ] Production GSC query through Cloudflare Access (not claimed)
