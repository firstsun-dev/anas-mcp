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

## Deployment credentials
- [ ] Provision least-privilege `CLOUDFLARE_API_TOKEN` for the shared deployment pipeline.
- [ ] Configure `CLOUDFLARE_ACCOUNT_ID` in the protected GitHub Actions secret/configuration mechanism expected by the reusable workflow.
- [ ] Confirm no Google OAuth credential, Clarity token, PostgreSQL password, Access token, or other runtime credential is copied into GitHub Actions solely for deployment.

## Verification
- [ ] Validate caller-workflow syntax and reusable-workflow input compatibility.
- [ ] Confirm pull requests run checks without deployment.
- [ ] Confirm a non-main branch follows the intended development deployment behavior when authorized.
- [ ] Confirm `main` production deployment is only enabled after Cloudflare resources and production authorization are ready.
- [ ] Add or select a smoke verification command that checks minimal health and the Access-protected MCP boundary without exposing secrets.
- [ ] If MCP-specific Access smoke logic is reusable, move that generic logic to `firstsun-dev/.github` instead of duplicating it locally.

## Verification evidence

On 2026-09-08 the central reusable workflow `firstsun-dev/.github/.github/workflows/_cf-worker-template.yml` was inspected and confirmed to provide the organization-managed Cloudflare Worker pipeline contract. Existing Firstsun repositories also consume it through reusable-workflow callers. No `anas-mcp` production workflow or deployment was created by this documentation change because package-manager compatibility, versioning, URLs, and production resources are not yet resolved.
