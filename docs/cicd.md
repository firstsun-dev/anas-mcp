# CI/CD

## Decision

`anas-mcp` uses the reusable Cloudflare Worker pipeline maintained in `firstsun-dev/.github` for deployment.

The application repository may contain a thin caller workflow that defines triggers and application-specific inputs, but it MUST NOT copy or fork the shared Cloudflare deployment implementation.

Canonical reusable workflow:

```yaml
uses: firstsun-dev/.github/.github/workflows/_cf-worker-template.yml@v1
```

If the organization adopts a commit-pinned reference for deployment immutability, the caller may pin an approved commit SHA instead of `@v1`. Do not point production deployment at an arbitrary feature branch.

## Ownership

### `firstsun-dev/.github`

Owns the reusable deployment implementation, including the shared Cloudflare Worker pipeline behavior such as:

- test orchestration supported by the template
- Cloudflare Worker build/deploy sequencing
- production versus development deployment behavior
- Worker version upload/deploy behavior
- deployment metadata
- post-deploy verification and rollback behavior when configured
- common runner/actions conventions

Changes to generic deployment behavior belong in `firstsun-dev/.github`, not in `anas-mcp`.

### `firstsun-dev/anas-mcp`

Owns only application-specific caller configuration and project verification, for example:

- workflow triggers
- `app_name`
- `app_path`
- application version input
- build/check commands
- OpenAPI validation through the aggregate project check
- smoke-test command
- production/dev URLs
- `secrets: inherit` where required by the reusable workflow contract

The caller workflow must remain thin.

## Expected caller shape

The final caller should follow the organization's existing Cloudflare Worker pattern, conceptually:

```yaml
name: CI/CD

on:
  push:
    branches: ['**']
  pull_request:
  workflow_dispatch:

permissions:
  contents: read
  checks: write

concurrency:
  group: anas-mcp-${{ github.ref }}
  cancel-in-progress: ${{ github.ref != 'refs/heads/main' }}

jobs:
  pipeline:
    uses: firstsun-dev/.github/.github/workflows/_cf-worker-template.yml@v1
    secrets: inherit
    with:
      app_name: anas-mcp
      app_path: .
      app_version: <version expression determined by the project release strategy>
      build_cmd: <install/build/check command compatible with the shared runner>
      test_unit_cmd: <optional>
      test_integration_cmd: <optional>
      verify_cmd: <optional MCP/health smoke verification>
      app_url_prod: <production URL when provisioned>
      app_url_dev: <development URL when provisioned>
```

The project check used by this caller must eventually include both TypeScript verification and `openapi.yaml` validation with an OpenAPI 3.2-capable validator.

This is a contract example, not a license to guess unresolved values.

## Package-manager compatibility

The current `anas-mcp` repository uses npm scripts, while the shared Cloudflare Worker template currently invokes `pnpm exec wrangler` internally during deployment.

Before enabling deployment, verify one of the following with the current shared workflow version:

1. an npm-installed `node_modules` layout is compatible with the template's `pnpm exec wrangler` calls; or
2. align this repository with the Firstsun pnpm convention and commit the appropriate lockfile; or
3. update the reusable workflow centrally in `firstsun-dev/.github` to support the required package-manager contract.

Do NOT copy the deployment steps into this repository merely to bypass a package-manager mismatch.

## OpenAPI validation gate

`openapi.yaml` is the canonical HTTP contract and uses OpenAPI 3.2.0. See `docs/api.md`.

Before deployment is enabled:

- select an OpenAPI 3.2-capable validator;
- add a local `check:openapi` or equivalent command;
- include it in the project's aggregate `check` command;
- configure the thin caller/shared pipeline so that the aggregate check runs before deployment;
- fail CI when the OpenAPI contract is invalid.

If OpenAPI validation becomes a standard requirement across Firstsun services, prefer adding reusable validation support in `firstsun-dev/.github` rather than duplicating generic setup in every repository.

Do not downgrade `openapi.yaml` to an older OpenAPI version merely because an outdated CI tool cannot parse 3.2. Update the validator/toolchain or make an explicit reviewed compatibility decision.

## Pull request verification gate (interim, test-only)

`.github/workflows/pr-verify.yml` runs on `pull_request` only and runs `npm ci`, `npm run check` (TypeScript, Vitest including the security/regression tests, `redocly lint openapi.yaml` for OpenAPI 3.2) and `npx wrangler deploy --dry-run`. It cannot deploy: no push/dispatch trigger, `permissions: contents: read`, no secrets, no Cloudflare credentials, no call to the shared template. `tests/repo-guardrails.test.ts` fails if any of that changes. It runs on a GitHub-hosted runner because this repository is public and PR code must not run on the organization's self-hosted runners.

### Why PR #10 had no checks

The repository has no `.github/workflows` directory, and the Actions API reports zero runs ever. Nothing was configured to produce a check; this was not a failure of the shared template.

### Why the shared template cannot be used yet (verified against `_cf-worker-template.yml@v1`, commit `aeaab4c`)

1. **npm incompatibility.** Every job runs `firstsun-dev/.github/actions/setup@v1`, whose `Install dependencies` step is `pnpm install --frozen-lockfile`. The template does not expose the action's `install` input. This repository has only `package-lock.json`, so even a test-only PR run would fail at setup. The deploy job also calls `pnpm exec wrangler`.
2. **Unsafe branch deploys.** On any non-PR event the template deploys: `main` to production, every other branch to `--env dev`. This repository defines no `env.dev`. `npx wrangler deploy --dry-run --env dev` was run locally and only prints `No environment found in configuration with name "dev"`; it does not fail, and falls back to the top-level config, whose Worker name is the production script. Wiring the template with a `push: branches: ['**']` trigger (as the example above shows) would therefore deploy feature-branch pushes to production.
3. **The template's PR behavior is safe**: for `pull_request` the migrate and deploy jobs are skipped by `github.event_name != 'pull_request'`, and the test jobs use no Cloudflare secrets. Its jobs default to runner label `linux`; the organization's self-hosted runners carry the `Linux` label, so PR code from a public repository would run on them.
4. Only `test_unit_cmd`/`test_integration_cmd`/`test_e2e_cmd` jobs run on PRs; `build_cmd` is only used on deploy.

### Smallest compatible path (proposal, not implemented here)

Do not fork the deploy logic. Instead:

1. In `firstsun-dev/.github`: let `_cf-worker-template.yml` pass an install command or `install: false` through to the setup action, and use `npm`/`pnpm exec` according to the lockfile present; add a test-only mode (or require callers to be PR-only) that never reaches deploy.
2. In this repository: define `env.dev` (or a dedicated dev Worker name) in `wrangler.jsonc` so a non-`main` deploy can never resolve to the production script, and decide `app_version`, URLs and credentials.
3. Only then replace `pr-verify.yml` with the thin caller, restricted to the events the team accepts.

Until then, `pr-verify.yml` is a documented exception under the Change policy below (see `openspec/changes/use-centralized-cf-worker-ci/`). It contains no deployment, rollback or Cloudflare logic. Deployment remains manual and unautomated.

### Verified result

| Item | Value |
| --- | --- |
| Run | [`PR Verify` 38527650533](https://github.com/firstsun-dev/anas-mcp/actions/runs/38527650533) |
| Event / date | `pull_request`, 2026-10-14 (created 07:20 UTC) |
| Commit | `17af13cc0dbee643ae05eb97669bd289a2a6f95a` |
| Conclusion | success; check run `Verify (npm ci, typecheck, tests, OpenAPI, wrangler dry-run)` |
| Steps that passed | `npm ci` (lockfile-exact), `npm run check` (typecheck, Vitest, `redocly lint`), `wrangler deploy --dry-run` |

This proves only that the PR verification steps pass on a GitHub-hosted runner for that commit. It is **not** a deployment: the workflow has no Cloudflare credentials and uploads nothing, and no production deployment, Access provisioning or E2E has been performed. A later commit needs its own run; the result above is not carried over to it. Branch protection / required checks are not configured by this repository.

## Secrets and deployment credentials

Application runtime credentials continue to follow `docs/credentials.md` and are Secrets Store first.

Cloudflare deployment credentials are bootstrap CI credentials: they may be supplied through the GitHub Actions protected secret mechanism required by the reusable workflow because CI must authenticate to Cloudflare before Worker runtime bindings are available.

The current shared workflow expects Cloudflare deployment credentials such as:

```text
CLOUDFLARE_API_TOKEN
CLOUDFLARE_ACCOUNT_ID
```

Use least privilege. Do not copy runtime Google OAuth credentials, MCP authentication material (Access/Service Token credentials), Clarity tokens, or PostgreSQL passwords into GitHub Actions secrets solely for deployment.

## Branch behavior

Follow the shared workflow contract rather than reimplementing branch routing locally.

At the time this decision was recorded, the central template treats:

- pull requests as test-only
- `main` branch pushes as production deployment
- other branch pushes as development deployment

Re-check the current `firstsun-dev/.github` workflow before changing caller assumptions.

## Production authentication verification

Deployment success alone does not prove MCP authentication works.

Once Cloudflare Access is in front of `/mcp` (`docs/cloudflare-access.md`), post-deploy verification should cover at minimum:

- `GET /health` on `https://mcp.firstsun.org` returns only minimal readiness without credentials
- `/mcp` without credentials is blocked/challenged by Access and cannot invoke MCP tools
- a Service Token request (`CF-Access-Client-Id` + `CF-Access-Client-Secret`) can initialize MCP and list tools; Managed OAuth is verified interactively. Service Token credentials must come from an operator-held secret, never from CI logs or committed files
- the Worker rejects a request with no/invalid `Cf-Access-Jwt-Assertion` (covered by unit tests; do not bypass Access to test it in production)
- `ACCESS_TEAM_DOMAIN` / `ACCESS_AUD` are non-empty in the deployed Worker (empty values make `/mcp` return `503`)

This repository currently has no deployment workflow (only the test-only `pr-verify.yml`), so nothing deploys from `main` yet. Once one is added, rollout ordering in `docs/cloudflare-access.md` applies.

Do not put reusable auth test implementation into the caller workflow if it can be generalized in `firstsun-dev/.github`.

## Change policy

If `anas-mcp` needs deployment behavior that the shared workflow cannot express:

1. determine whether the need is generic to Firstsun Cloudflare Workers;
2. if generic, improve `firstsun-dev/.github` and then consume the updated reusable workflow;
3. if truly application-specific, document the exception in OpenSpec before adding local CI logic.

Production deployment must not silently diverge from the organization-managed pipeline.
