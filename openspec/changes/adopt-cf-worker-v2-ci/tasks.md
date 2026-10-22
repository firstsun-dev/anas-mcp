# Tasks
- [x] Verify shared contract at 3cf1d52891f04cde737af10ea303f9b7d6b2e6ef (inputs/secrets exist; no required input missing) — scripted check + actionlint 1.7.12 OK.
- [x] Migrate `cicd.yml`; remove `pr-verify.yml`; update guardrail tests, docs, AGENTS/README/project.md.
- [x] Local gate: `pnpm install --frozen-lockfile && pnpm run check` (394 passed, 22 skipped; OpenAPI valid).
- [x] Branch push run: Build Validation + Unit Tests success, Deploy skipped (non-main), Preview/Dev jobs skipped.
- [ ] Resolve the smoke-probe gap (`GET /` is 404) before merge.
- [ ] Production deploy after merge, then live smoke verification (not yet run).
