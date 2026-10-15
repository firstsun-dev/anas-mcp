# Tasks: centralized Cloudflare Worker CI/CD

## Documentation and policy
- [x] Document `firstsun-dev/.github` as the owner of Cloudflare Worker deployment implementation.
- [x] Document `_cf-worker-template.yml` as the required reusable pipeline for `anas-mcp` deployment.
- [x] Document the thin-caller boundary for application workflows.
- [x] Document CI bootstrap credentials as a narrow exception to runtime Secrets Store first.

## Caller workflow
- [x] Select the project versioning strategy for `app_version`: `${{ github.sha }}` (the template's `pnpm -r version` matches no projects here: no-op).
- [x] Verified npm is incompatible (setup action runs `pnpm install --frozen-lockfile`); pnpm 10.33.0 frozen install, `pnpm run check`, `pnpm exec wrangler deploy --dry-run` pass locally.
- [x] Migrated to pnpm (`packageManager`, `pnpm-lock.yaml`, `package-lock.json` removed); shared workflow not modified.
- [x] Add thin `.github/workflows/cicd.yml` at `_cf-worker-template.yml@v1.5.0`, push to `main` only, serialized (guarded by `tests/repo-guardrails.test.ts`).
- [x] `secrets: inherit` (template declares no `secrets:` block; reads only the two Cloudflare deploy secrets).
- [x] Configure `app_name: anas-mcp` and `app_path: .`.
- [x] `test_unit_cmd: pnpm run check`, `build_cmd: pnpm exec wrangler deploy --dry-run`.
- [x] `app_url_prod: https://mcp.firstsun.org`; no dev environment/URL (none exists).

## Interim PR verification gate (exception)
- [x] Determine why PR #10 had no checks: no workflow existed (0 Actions runs).
- [x] Inspect `_cf-worker-template.yml@v1`: PR events are test-only, but its setup action runs `pnpm install --frozen-lockfile` (no pnpm lockfile here, `install` input not exposed) and non-PR pushes deploy, with non-`main` branches using `--env dev`, which this repository does not define (Wrangler only warns and falls back to the production script).
- [x] Add `.github/workflows/pr-verify.yml`: `pull_request` only, `contents: read`, no secrets, GitHub-hosted runner, `npm ci`, `npm run check`, `wrangler deploy --dry-run`; guarded by `tests/repo-guardrails.test.ts`.
- [x] Observe the first GitHub run of `pr-verify.yml` and record its result: run 38527650533, `pull_request`, 2026-10-14, commit `17af13c`, success (`npm ci`, `npm run check`, `wrangler deploy --dry-run`). Verification only, not a deployment.
- [x] Superseded: pnpm migration removes the need for npm pass-through; `cicd.yml` is main-only so no `env.dev` is needed. `pr-verify.yml` stays as the PR gate (now pnpm).

## Deployment credentials
- [ ] Provision least-privilege `CLOUDFLARE_API_TOKEN` for the shared deployment pipeline.
- [ ] Configure `CLOUDFLARE_ACCOUNT_ID` in the protected GitHub Actions secret/configuration mechanism expected by the reusable workflow.
- [ ] Confirm no Google OAuth credential, Clarity token, PostgreSQL password, Access token, or other runtime credential is copied into GitHub Actions solely for deployment.

## Verification
- [x] Validated YAML parses and every `with:` key exists in the `v1.5.0` template inputs (test-enforced). Not yet executed on GitHub Actions.
- [x] Confirm pull requests run checks without deployment (for `pr-verify.yml`: run 38527650533 ran verification only; the shared template's PR path is not exercised because it is not wired up).
- [ ] Confirm a non-main branch follows the intended development deployment behavior when authorized.
- [ ] Confirm `main` production deployment is only enabled after Cloudflare resources and production authorization are ready.
- [x] `scripts/smoke-prod.sh` run against production: all 4 checks pass; negative case (wrong issuer) fails with exit 1.
- [ ] If MCP-specific Access smoke logic is reusable, move that generic logic to `firstsun-dev/.github` instead of duplicating it locally.

## Verification evidence

On 2026-09-08 the central reusable workflow `firstsun-dev/.github/.github/workflows/_cf-worker-template.yml` was inspected and confirmed to provide the organization-managed Cloudflare Worker pipeline contract. Existing Firstsun repositories also consume it through reusable-workflow callers. No `anas-mcp` production workflow or deployment was created by this documentation change because package-manager compatibility, versioning, URLs, and production resources are not yet resolved.

2026-10-14: documented exception. The shared template cannot be consumed yet (see tasks above and `docs/cicd.md`), so a test-only `pr-verify.yml` was added. It copies no deployment, version-upload, rollback or credential logic. Wiring the shared template with a branch-push trigger before `env.dev` exists would deploy feature branches to the production Worker name; do not do that.

2026-10-14: first `pr-verify.yml` run (38527650533, commit `17af13c`) succeeded. This is PR verification evidence only; it says nothing about deployment, which remains unconfigured and unverified (no deploy workflow, no Cloudflare credentials in CI).

2026-10-15 (issue #11): verified `wrangler versions upload --dry-run --var COMMIT_HASH:… --var VERSION:…` (the template's exact arguments) preserves `ACCESS_TEAM_DOMAIN`, `ACCESS_AUD` and the `ANALYTICS_DB` Hyperdrive binding. Residual: `workers_dev:false`/`preview_urls:false` are not re-applied by `versions upload`; confirm in the dashboard. Pending until first `main` run: Cloudflare secrets/runner access, `anas-mcp/prod` environment, runner pnpm version, branch protection, and the unchecked items above (non-main dev deploy is intentionally not applicable; production deploy requires merge approval).
