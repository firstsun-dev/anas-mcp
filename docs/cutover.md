# Cutover runbook: retire standalone deployment

`firstsun-dev/anas-mcp` is the **historical source**. The service moves to `firstsun-dev/innovation-apps` under `apps/anas-mcp`. Both repositories target the same Cloudflare Worker `anas-mcp` (production `https://mcp.firstsun.org/anas/mcp`), so two repositories able to deploy it is a cross-repo deployment race. This repository's deployment ownership is retired by the PR `chore: retire standalone deployment after monorepo migration`.

**That PR must not be merged until the lead confirms the new app is verified and approves the cutover.** This repository is not archived; history and docs stay.

## Automatic Production deploy triggers (before the retirement PR)

| # | Trigger | Path |
| --- | --- | --- |
| 1 | `push` to `main` | `.github/workflows/cicd.yml` calls `firstsun-dev/.github/.github/workflows/_cf-worker-v2.yml@v2` (`production-only`); its Deploy job does `wrangler versions upload` + `versions deploy @100` |

Also checked: no other workflow file; `cicd.yml` has no `workflow_dispatch`, `schedule`, `pull_request` or `delete`; no `.github/dependabot.yml` (no Dependabot PRs to push-trigger); non-`main` pushes run verification only. Because the callee is the floating `@v2` tag in another repository, its behaviour can change outside this repo. Not visible from the repository and to be confirmed by an operator: a Cloudflare Workers Builds git integration on the Worker (Cloudflare dashboard, Worker > Settings > Builds), and any other CI holding the Cloudflare token.

After the retirement PR, `cicd.yml` is verification-only: GitHub-hosted runner, `contents: read`, no secrets, no reusable workflow, no deploy command (only `wrangler deploy --dry-run`).

## Order of operations

1. **Freeze.** Stop merging to `main` here and in the monorepo's `apps/anas-mcp` path.
2. **Record the known-good version** (read-only, see below).
3. **Merge the retirement PR** here (after lead approval). Alternative if merge must wait: disable the workflow with `gh workflow disable cicd.yml --repo firstsun-dev/anas-mcp` (re-enable with `gh workflow enable`). Merging the PR itself pushes to `main` but the new workflow cannot deploy.
4. **Confirm no old run is in progress or queued** (below).
5. **Merge the monorepo change** so `innovation-apps` deploys.
6. **Confirm the old repository cannot deploy** (below).

## Confirm no old run is active

```bash
gh run list --repo firstsun-dev/anas-mcp --status in_progress
gh run list --repo firstsun-dev/anas-mcp --status queued
gh run list --repo firstsun-dev/anas-mcp --status waiting
```

All three must print nothing. For any run still listed, inspect it (`gh run view <run-id> --repo firstsun-dev/anas-mcp`). A run already past `Deploy` cannot be stopped safely: wait for it to finish. A queued/waiting one (the shared workflow serializes on the `cfv2-prod-anas-mcp` group) should be cancelled:

```bash
gh run cancel <run-id> --repo firstsun-dev/anas-mcp
```

## Check the deployed known-good Worker version (read-only)

Run from a checkout with Cloudflare authentication (do not paste credentials anywhere):

```bash
pnpm exec wrangler deployments list --name anas-mcp
pnpm exec wrangler versions list --name anas-mcp
curl -s https://mcp.firstsun.org/health
```

Note the version ID currently at 100% and its creation time before the monorepo merge, and compare again afterwards. Rolling back is manual only (a previous version may predate Cloudflare Access): never run `wrangler rollback` without an explicit decision.

## Confirm the old repository cannot deploy

- `gh run list --repo firstsun-dev/anas-mcp --branch main --limit 3` shows only the verification run for the retirement merge, with a single `verify` job and no `Deploy`.
- `grep -rn "_cf-worker\|CLOUDFLARE_" .github` finds nothing.
- Cloudflare: `wrangler deployments list --name anas-mcp` shows no new deployment from this repository's merge; the newest is from the monorepo.
- Operator follow-ups (not done by this PR): remove or de-scope the Cloudflare token for this repository, and confirm no Workers Builds git connection points at it.

## Branch protection

At the time of writing, `main` here has no branch protection and no rulesets, so no required status check references the old job names (`cf / Unit Tests`, `cf / Build Validation`). The new workflow's job is named `Verify (pnpm install, typecheck, tests, OpenAPI, wrangler dry-run)`; if protection is added later, require that name.
