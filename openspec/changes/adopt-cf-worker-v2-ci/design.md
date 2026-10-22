# Design

- **Pin:** `uses` and `tools_ref` are the same full SHA (026f5b40e9a6570005a8b30c2ae48338bb71337f, `firstsun-dev/.github` main on 2026-10-22; v2.6.0 is the latest tag). Guardrail test enforces equality and that caller keys exist in the shared workflow contract.
- **Triggers:** `push` only. `workflow_dispatch` would deploy Production from main; `delete` is a no-op for production-only; `pull_request` is omitted because the shared CI action requires the self-hosted runner (fails on `ubuntu-latest`: no pnpm) and the repository is public (fork PRs must not reach it). Deviates from the shared docs' "MUST" on purpose.
- **Permissions:** `contents: write` is a ceiling demanded by the callee's skipped Release job (otherwise `startup_failure`); Deploy itself uses `contents: read`.
- **Smoke:** `scripts/smoke-prod.sh` runs as `smoke_cmd` (credential-free). The engine's built-in probe runs first and requires 2xx on `<app_url_prod>/`; production returns 404 there (**open blocker**, see docs/cicd.md "Known gap"). No Access service token is used or needed by the existing smoke.
- **Rollback:** manual, because an older version may predate Access.
