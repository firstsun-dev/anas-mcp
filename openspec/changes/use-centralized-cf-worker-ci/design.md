# Design: centralized Cloudflare Worker CI/CD

## Deployment architecture

`anas-mcp` delegates Cloudflare Worker pipeline implementation to the reusable workflow maintained by `firstsun-dev/.github`.

```text
GitHub event in firstsun-dev/anas-mcp
        |
        v
thin caller workflow in anas-mcp
        |
        | uses:
        v
firstsun-dev/.github/.github/workflows/_cf-worker-template.yml@v1
        |
        +--> tests supported by shared template
        +--> build
        +--> Cloudflare Worker version upload/deploy
        +--> optional smoke verification
        +--> shared rollback/revert behavior when configured
```

The application repository owns inputs; the organization repository owns deployment implementation.

## Canonical reusable workflow

Use:

```yaml
uses: firstsun-dev/.github/.github/workflows/_cf-worker-template.yml@v1
```

An approved commit SHA may be used instead of `@v1` when the project intentionally pins the deployment implementation for reproducibility. Production must not reference an arbitrary feature branch.

## Caller workflow boundary

A caller workflow in `anas-mcp` may define:

- push / pull-request / manual triggers
- concurrency behavior
- workflow permissions required by the shared workflow
- `secrets: inherit` where required by the reusable workflow contract
- `app_name: anas-mcp`
- `app_path: .`
- application version input
- project-specific build/check/test commands
- optional smoke verification commands
- production/development URLs once provisioned

It must not reproduce:

- `wrangler versions upload`
- `wrangler versions deploy`
- Cloudflare deployment selection logic
- shared rollback implementation
- organization-wide runner/setup boilerplate

If those behaviors need to change generically, change them in `firstsun-dev/.github`.

## Current shared-workflow behavior

At the time of this decision, `_cf-worker-template.yml` implements branch-based behavior approximately as follows:

- pull request: test phase only
- push to `main`: production deploy
- push to other branches: development deploy
- deployment uses Worker Versions upload/deploy
- optional smoke verification can run after deployment
- production revert behavior is available when verification is configured

Treat the reusable workflow as the source of truth; re-read its current contract before changing caller inputs.

## Package-manager compatibility

`anas-mcp` currently defines npm scripts and does not yet have an accepted pnpm migration decision.

The central Cloudflare pipeline currently invokes `pnpm exec wrangler` during deployment. Before enabling the caller workflow, verify the current template with this repository's install/build strategy.

Acceptable outcomes:

1. prove npm-installed dependencies work with the central template;
2. align `anas-mcp` to the organization's pnpm convention in a reviewed change; or
3. improve the central reusable workflow to support the needed package-manager contract.

Unacceptable outcome:

- copy the central deployment shell steps locally just to avoid resolving the compatibility issue.

## Credential boundary

### Runtime credentials

Remain governed by `docs/credentials.md`:

- Google OAuth JSON -> Cloudflare Secrets Store
- Hyperdrive DB credential -> Hyperdrive-owned
- Clarity API token -> `windmill-flows` owned
- Cloudflare Access Managed OAuth token/session state -> Access owned

### CI bootstrap credentials

GitHub Actions may hold Cloudflare deployment credentials required before the Worker runtime exists. This is an intentional bootstrap exception to Secrets Store first.

The reusable workflow currently expects deployment credentials including:

```text
CLOUDFLARE_API_TOKEN
CLOUDFLARE_ACCOUNT_ID
```

Use least privilege and do not mirror runtime provider credentials into GitHub Actions secrets.

## Access-aware smoke verification

Cloudflare Access remains the production authentication boundary for `/mcp`.

A post-deploy verification strategy should eventually validate:

- minimal `/health` readiness
- unauthenticated `/mcp` is blocked from tool execution
- Managed OAuth discovery/login remains functional
- allowed identity path succeeds
- denied identity path stays denied

If this verification pattern is reusable across Firstsun MCP Workers, implement it centrally in `firstsun-dev/.github` rather than embedding a large custom script in `anas-mcp`.

## Release/version input

The shared workflow requires `app_version`. The caller must use an explicit versioning strategy rather than inventing a placeholder in production.

Until the project's release/version strategy is selected, caller workflow activation remains a task, not a completed requirement.

## Failure policy

Do not claim CI/CD complete until:

- caller syntax validates
- shared-workflow inputs are compatible with this repository
- test/check command succeeds on the shared runner
- a non-production deployment succeeds where applicable
- production deploy behavior is explicitly authorized and tested

No production deployment is performed as part of this documentation change.
