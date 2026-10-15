# Tasks: centralized Cloudflare Worker CI/CD

## Documentation and policy
- [x] Document `firstsun-dev/.github` as the owner of Cloudflare Worker deployment implementation.
- [x] Document `_cf-worker-template.yml` as the required reusable pipeline for `anas-mcp` deployment.
- [x] Document the thin-caller boundary for application workflows.
- [x] Document CI bootstrap credentials as a narrow exception to runtime Secrets Store first.

## Caller workflow
- [ ] Select the project versioning strategy required for the reusable workflow `app_version` input.
- [ ] Verify whether the current npm dependency installation is compatible with the shared workflow's `pnpm exec wrangler` deployment steps.
- [ ] If necessary, either migrate the project to the organization pnpm convention or update the shared workflow centrally; do not fork deploy steps locally.
- [ ] Add a thin `.github/workflows/cicd.yml` caller using `firstsun-dev/.github/.github/workflows/_cf-worker-template.yml@v1` or an approved pinned commit.
- [ ] Pass `secrets: inherit` only as required by the shared workflow contract.
- [ ] Configure `app_name: anas-mcp` and `app_path: .`.
- [ ] Configure project build/check/test commands after package-manager compatibility is resolved.
- [ ] Configure production/dev application URLs only after the Cloudflare routes are provisioned.

## Interim PR verification gate (exception)
- [x] Determine why PR #10 had no checks: no workflow existed (0 Actions runs).
- [x] Inspect `_cf-worker-template.yml@v1`: PR events are test-only, but its setup action runs `pnpm install --frozen-lockfile` (no pnpm lockfile here, `install` input not exposed) and non-PR pushes deploy, with non-`main` branches using `--env dev`, which this repository does not define (Wrangler only warns and falls back to the production script).
- [x] Add `.github/workflows/pr-verify.yml`: `pull_request` only, `contents: read`, no secrets, GitHub-hosted runner, `npm ci`, `npm run check`, `wrangler deploy --dry-run`; guarded by `tests/repo-guardrails.test.ts`.
- [x] Observe the first GitHub run of `pr-verify.yml` and record its result: run 38527650533, `pull_request`, 2026-10-14, commit `17af13c`, success (`npm ci`, `npm run check`, `wrangler deploy --dry-run`). Verification only, not a deployment.
- [ ] Propose to `firstsun-dev/.github`: npm/install pass-through and a test-only mode; define `env.dev` here; then replace `pr-verify.yml` with the thin caller.

## Deployment credentials
- [ ] Provision least-privilege `CLOUDFLARE_API_TOKEN` for the shared deployment pipeline.
- [ ] Configure `CLOUDFLARE_ACCOUNT_ID` in the protected GitHub Actions secret/configuration mechanism expected by the reusable workflow.
- [ ] Confirm no Google OAuth credential, Clarity token, PostgreSQL password, Access token, or other runtime credential is copied into GitHub Actions solely for deployment.

## Verification
- [ ] Validate caller-workflow syntax and reusable-workflow input compatibility.
- [x] Confirm pull requests run checks without deployment (for `pr-verify.yml`: run 38527650533 ran verification only; the shared template's PR path is not exercised because it is not wired up).
- [ ] Confirm a non-main branch follows the intended development deployment behavior when authorized.
- [ ] Confirm `main` production deployment is only enabled after Cloudflare resources and production authorization are ready.
- [ ] Add or select a smoke verification command that checks minimal health and the Access-protected MCP boundary without exposing secrets.
- [ ] If MCP-specific Access smoke logic is reusable, move that generic logic to `firstsun-dev/.github` instead of duplicating it locally.

## Verification evidence

On 2026-09-08 the central reusable workflow `firstsun-dev/.github/.github/workflows/_cf-worker-template.yml` was inspected and confirmed to provide the organization-managed Cloudflare Worker pipeline contract. Existing Firstsun repositories also consume it through reusable-workflow callers. No `anas-mcp` production workflow or deployment was created by this documentation change because package-manager compatibility, versioning, URLs, and production resources are not yet resolved.

2026-10-14: documented exception. The shared template cannot be consumed yet (see tasks above and `docs/cicd.md`), so a test-only `pr-verify.yml` was added. It copies no deployment, version-upload, rollback or credential logic. Wiring the shared template with a branch-push trigger before `env.dev` exists would deploy feature branches to the production Worker name; do not do that.

2026-10-14: first `pr-verify.yml` run (38527650533, commit `17af13c`) succeeded. This is PR verification evidence only; it says nothing about deployment, which remains unconfigured and unverified (no deploy workflow, no Cloudflare credentials in CI).
