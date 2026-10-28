# Tasks
- [x] Verify shared contract at 026f5b40e9a6570005a8b30c2ae48338bb71337f (inputs/secrets exist; no required input missing) — scripted check + actionlint 1.7.12 OK.
- [x] Migrate `cicd.yml`; remove `pr-verify.yml`; update guardrail tests, docs, AGENTS/README/project.md.
- [x] Local gate: `pnpm install --frozen-lockfile && pnpm run check` (394 passed, 22 skipped; OpenAPI valid).
- [x] Branch push run: Build Validation + Unit Tests success, Deploy skipped (non-main), Preview/Dev jobs skipped.
- [x] Smoke-probe gap (`GET /` is 404): fixed via `probe_path: /health` (shared v2 `probe_path`, .github#73).
- [ ] Production deploy after merge, then live smoke verification (not yet run).
