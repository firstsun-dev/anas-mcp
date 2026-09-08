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

Owns only application-specific caller configuration, for example:

- workflow triggers
- `app_name`
- `app_path`
- application version input
- build/check commands
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

This is a contract example, not a license to guess unresolved values.

## Package-manager compatibility

The current `anas-mcp` repository uses npm scripts, while the shared Cloudflare Worker template currently invokes `pnpm exec wrangler` internally during deployment.

Before enabling deployment, verify one of the following with the current shared workflow version:

1. an npm-installed `node_modules` layout is compatible with the template's `pnpm exec wrangler` calls; or
2. align this repository with the Firstsun pnpm convention and commit the appropriate lockfile; or
3. update the reusable workflow centrally in `firstsun-dev/.github` to support the required package-manager contract.

Do NOT copy the deployment steps into this repository merely to bypass a package-manager mismatch.

## Secrets and deployment credentials

Application runtime credentials continue to follow `docs/credentials.md` and are Secrets Store first.

Cloudflare deployment credentials are bootstrap CI credentials: they may be supplied through the GitHub Actions protected secret mechanism required by the reusable workflow because CI must authenticate to Cloudflare before Worker runtime bindings are available.

The current shared workflow expects Cloudflare deployment credentials such as:

```text
CLOUDFLARE_API_TOKEN
CLOUDFLARE_ACCOUNT_ID
```

Use least privilege. Do not copy runtime Google OAuth credentials, Access tokens, Clarity tokens, or PostgreSQL passwords into GitHub Actions secrets solely for deployment.

## Branch behavior

Follow the shared workflow contract rather than reimplementing branch routing locally.

At the time this decision was recorded, the central template treats:

- pull requests as test-only
- `main` branch pushes as production deployment
- other branch pushes as development deployment

Re-check the current `firstsun-dev/.github` workflow before changing caller assumptions.

## Production authentication verification

Deployment success alone does not prove MCP authentication works.

When production Access is provisioned, post-deploy verification should cover at minimum:

- `/health` returns only minimal readiness according to the selected Access path scope
- unauthenticated `/mcp` cannot invoke MCP tools
- Cloudflare Access Managed OAuth discovery/login is reachable
- an allowed identity can initialize MCP
- a denied identity remains blocked

Do not put reusable Access-auth test implementation into the caller workflow if it can be generalized in `firstsun-dev/.github`.

## Change policy

If `anas-mcp` needs deployment behavior that the shared workflow cannot express:

1. determine whether the need is generic to Firstsun Cloudflare Workers;
2. if generic, improve `firstsun-dev/.github` and then consume the updated reusable workflow;
3. if truly application-specific, document the exception in OpenSpec before adding local CI logic.

Production deployment must not silently diverge from the organization-managed pipeline.
