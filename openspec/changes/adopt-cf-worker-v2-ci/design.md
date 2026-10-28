# Design

- **Ref:** `uses` and `tools_ref` are both `v2` (floating major tag, owner decision 2026-10-28; was a full SHA). Guardrail test enforces equality and that caller keys exist in the shared contract.
- **Triggers:** `push` only. `workflow_dispatch` would deploy Production from main; `delete` is a no-op for production-only; `pull_request` is omitted because the shared CI action requires the self-hosted runner (fails on `ubuntu-latest`: no pnpm) and the repository is public (fork PRs must not reach it). Deviates from the shared docs' "MUST" on purpose.
- **Permissions:** `contents: write` is a ceiling demanded by the callee's skipped Release job (otherwise `startup_failure`); Deploy itself uses `contents: read`.
- **Smoke:** the built-in probe checks `probe_path: /health` (200); `scripts/smoke-prod.sh` then runs as `smoke_cmd` (credential-free). No Access service token needed.
- **Rollback:** manual, because an older version may predate Access.
