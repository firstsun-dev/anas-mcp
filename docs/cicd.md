# CI/CD

## Decision

`anas-mcp` uses the reusable Cloudflare Worker pipeline maintained in `firstsun-dev/.github` for deployment.

The application repository may contain a thin caller workflow that defines triggers and application-specific inputs, but it MUST NOT copy or fork the shared Cloudflare deployment implementation.

Canonical reusable workflow:

```yaml
uses: firstsun-dev/.github/.github/workflows/_cf-worker-v2.yml@3cf1d52891f04cde737af10ea303f9b7d6b2e6ef
```

The caller pins a full commit SHA, and `tools_ref` MUST be the same SHA (the engine checks out its tooling at `tools_ref`). Do not point production deployment at a branch or a floating tag.

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

## Production caller (`.github/workflows/cicd.yml`)

Migrated from `_cf-worker-template.yml@v1.5.0` to `_cf-worker-v2.yml` at `firstsun-dev/.github` commit `3cf1d52891f04cde737af10ea303f9b7d6b2e6ef` (main HEAD when verified, 2026-10-22; `docs/cf-worker-v2.md` read at that commit). The shared repository is consumed unmodified. Tracking issue: firstsun-dev/anas-mcp#32.

- **Strategy: `production-only`.** `preview_on_branch_push: false`, `shared_dev_on_branch_push: false`; no Native Preview, no Shared Dev, no persistent Dev, no Preview/Dev credentials. A non-`main` push runs verification only (Lint/Typecheck/Unit/Build Validation jobs of the shared workflow); only a push to `main` reaches the Deploy job. `workers_dev: false` / `preview_urls: false` stay in `wrangler.jsonc` (guardrail test).
- **Triggers: `push` only.** `workflow_dispatch` is omitted because on `main` it would be a manual Production deploy path; `delete` is omitted because the lifecycle job is skipped for `production-only`; `pull_request` is omitted because the shared CI action requires the org's self-hosted runner (it needs a pre-installed pnpm: a trial on `ubuntu-latest` failed with `pnpm: command not found`) and this repository is public, so a fork PR must never reach that runner. Same-repo PRs are verified by their branch push. The shared documentation says callers "MUST" also trigger on `pull_request`/`delete`/`workflow_dispatch`; that is deliberately not followed for the reasons above.
- **Permissions.** `contents: write` is only the ceiling GitHub demands because the callee declares it on its (here skipped, `release_cmd` unset) Release job; without it the run fails at startup. `deployments: write` and `pull-requests: write` are used by Deploy.
- **Inputs.** `wrangler_config: wrangler.jsonc` (the shared default is `wrangler.toml`). `test_unit_cmd: pnpm run check` is the aggregate gate (typecheck, Vitest, `redocly lint`); `build_cmd: pnpm exec wrangler deploy --dry-run` is a credential-free build validation (the Worker is bundled by `wrangler versions upload`). `app_version` is the commit SHA. `production_rollback_policy: manual` (never an automatic revert, see below). `smoke_cmd: scripts/smoke-prod.sh` with `smoke_env` `BASE_URL`/`EXPECTED_ISSUER`.
- **Credentials.** Only `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` are passed explicitly (no `secrets: inherit`); they are only reachable by the main-branch Deploy job. Smoke receives no secret.
- **Serialization.** The shared workflow owns the run-level `cfv2-prod-anas-mcp` concurrency group (`queue: max`, FIFO); the caller declares none (a caller group using the `cfv2-` prefix would deadlock).
- **Engine behaviour that replaces the v1 template:** `wrangler versions upload` + `versions deploy @100` on the audited config; the `--var COMMIT_HASH/VERSION` behaviour described below is unchanged.
- **Contract check.** Every `with:`/`secrets:` key of the caller is declared by the pinned workflow; `tests/repo-guardrails.test.ts` enforces the key set, the SHA/`tools_ref` match and the production-only settings. To bump the SHA, re-read `_cf-worker-v2.yml` and `docs/cf-worker-v2.md` at the new commit and update both refs together.

### Known gap: the shared smoke probe requests `<app_url_prod>/` and requires a 2xx

The v2 Deploy job always runs the engine's built-in probe before `smoke_cmd`: it GETs `<app_url_prod>/` and accepts only 2xx (or an Access login redirect, which `access_protected_targets` accepts for `preview` by default, not `prod`). `https://mcp.firstsun.org/` currently returns **404** (the Worker serves only `/health` and `/anas/mcp`), and there is no input to change the probe path. A Production deploy from this caller therefore publishes the new version and then reports the run failed at the smoke step (rollback is manual, so the version stays live). This must be resolved before merging (either the Worker answers `GET /` with 2xx, or the shared engine gains a probe-path input); it is deliberately not worked around here by loosening the shared engine or adding unreviewed Worker surface.

### Effective production configuration (verified non-deploying)

The template runs `wrangler versions upload --message … --var COMMIT_HASH:<sha7> --var VERSION:<sha>` then `wrangler versions deploy <id>@100`. Running the same arguments with `--dry-run` (Wrangler 4.149.0) lists:

```text
env.ANALYTICS_DB (8677c23a…)       Hyperdrive Config
env.ACCESS_TEAM_DOMAIN             Environment Variable
env.ACCESS_AUD                     Environment Variable
env.COMMIT_HASH ("(hidden)")       Environment Variable
env.VERSION ("(hidden)")           Environment Variable
```

`--var` adds to, and does not replace, the `vars` in `wrangler.jsonc`, so `ACCESS_TEAM_DOMAIN`, `ACCESS_AUD`, and the `ANALYTICS_DB` Hyperdrive binding are preserved. A guardrail test fails if `COMMIT_HASH`/`VERSION` are ever added to `vars`.

**Residual risk (not verifiable without deploying):** `workers_dev: false` and `preview_urls: false` are, to our understanding of Wrangler, applied by `wrangler deploy`, not by `versions upload`/`versions deploy` (not verified without deploying). The template never runs `wrangler deploy`, so these settings are not re-asserted on each release; they rely on the Worker's current subdomain/preview-URL state. Operators must confirm in the Cloudflare dashboard (Worker → Settings → Domains & Routes) that the `workers.dev` route and Preview URLs are disabled, and the custom domain `mcp.firstsun.org` is attached. Fixing this generically would be a change to `firstsun-dev/.github` and is out of scope here.

## Endpoint-path migration ordering

A push to `main` deploys production immediately. The `/anas` -> `/anas/mcp` change must not be merged until `infra-config` has applied the Access path update (see `infra-config/docs/mcp-anas-transport-suffix-cutover.md`); otherwise the smoke step fails on the missing `/anas/mcp` Access challenge and protected-resource metadata (the Worker itself stays fail-closed). The smoke job also asserts `/mcp`, `/anas` and `/anas/mcp2` serve nothing.

## Smoke tests and rollback

An automatic revert is unsafe for this service: the previous version may predate Cloudflare Access authentication, so it could reopen `/anas/mcp` with a weaker gate. The caller therefore sets `production_rollback_policy: manual` and runs `scripts/smoke-prod.sh` as the shared Deploy job's `smoke_cmd` (no secrets), after the engine's built-in probe (see Known gap), checking with unauthenticated requests only:

1. `GET /health` is `200` with `{service: "anas-mcp", status: "ok"}`.
2. `POST /anas/mcp` without credentials is `401`/`403` and returns no `tools`; `POST /mcp`, `POST /anas` and `POST /anas/mcp2` are `401`/`403`/`404` and return no `tools`.
3. The protected-resource metadata URL advertised in the `resource_metadata` parameter of the unauthenticated `WWW-Authenticate` challenge (discovered, never hardcoded) returns `200` with `resource == https://mcp.firstsun.org/anas/mcp` and the Access issuer in `authorization_servers`.
4. `GET <issuer>/.well-known/oauth-authorization-server` is reachable and its `issuer` equals `https://firstsun.cloudflareaccess.com` (the `ACCESS_TEAM_DOMAIN` in `wrangler.jsonc`; a test guards drift).

Transport errors (DNS, connect, timeout) and HTTP `5xx` are retried up to 6 requests per check with a 5 s delay (bounded; curl's exit status is handled separately from its HTTP status). `tests/smoke-script.test.ts` exercises the script with a mock `curl` (DNS error, connection failure, timeout, `502` then `200`, persistent `503`, success, and rejection cases); it is skipped where `bash`/`jq` are missing. On failure the job fails the run with "OPERATOR INTERVENTION REQUIRED".

**This design has NO automatic rollback.** A failed smoke test leaves the new version live. Operators must decide to roll forward or manually run `wrangler versions deploy <known-good-id>@100` after confirming that version has the Access gate. The smoke checks do not prove an authenticated MCP session works; that still requires an operator-held Access credential (Managed OAuth or Service Token) and is not performed in CI.

## Pull request verification gate

`pr-verify.yml` was removed: the shared workflow's CI jobs (`pnpm run check`, `wrangler deploy --dry-run`) run on every branch push, which covers same-repo PRs, so it duplicated them. The trade-off is that fork PRs are no longer verified (they would otherwise run on the self-hosted runners of a public repository). To make a failing check block merging, require the shared workflow's `cf / Unit Tests` and `cf / Build Validation` checks in branch protection for `main` (repository setting; not configured by this repository).

## Package manager

The repository uses **pnpm** (`packageManager: pnpm@10.33.0`, matching `blog`, `heaven-monorepo` and `innovation-apps`), with a committed `pnpm-lock.yaml` and `pnpm-workspace.yaml` (`allowBuilds`). `package-lock.json` is removed. The shared setup action runs `pnpm install --frozen-lockfile` and the template calls `pnpm exec wrangler`; both were exercised locally with pnpm 10.33.0 on Node 24 (the template's `NODE_VERSION`). The self-hosted runner image bakes in Node/pnpm (`setup-node`/`setup-pnpm: false`); its pnpm version cannot be inspected from here and is verified only by the first run on `main`.

## Production release gates (status as of 2026-10-15)

**A push to `main` deploys Production (merging the v2 migration PR triggers one).** Because `cicd.yml` deploys every push to `main`, `main` must be gated before activation. This repository does not change GitHub or Cloudflare settings; the items below are operator actions.

### Verified (read-only GitHub API, 2026-10-15)

| Item | Observed |
| --- | --- |
| Repository visibility | public |
| `main` branch protection | **none** (`protected: false`, protection API returns 404, no rulesets) |
| Org secrets `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` | exist, but visibility is `private` (private repositories only) |
| Org runner group `Default` | visible to all repositories, `allows_public_repositories: true`; 10 online runners labeled `self-hosted, Linux, X64, …` (label matching is case-insensitive, so the template's default `linux` matches) |
| Repository environments | none exist yet (`anas-mcp/prod` is auto-created on first deploy) |
| Repository-level secrets | none |

### Outstanding operator prerequisites (blockers for activation)

1. **Cloudflare secrets are not available to this repository.** The org secrets are scoped to private repositories and this repository is public, so `secrets: inherit` would pass empty values and the deploy would fail at Wrangler authentication. An org admin must either grant the secrets to `anas-mcp` (change visibility to `selected`) or add repository-level secrets. Use a least-privilege token (Workers Scripts edit for the `anas-mcp` script only). Do not paste credentials into the PR or repository files.
2. **Protect `main`** before merging this PR:
   - require a pull request before merging (no direct pushes), with at least 1 approving review;
   - require the status check `Verify (pnpm install, typecheck, tests, OpenAPI, wrangler dry-run)` (workflow `PR Verify`) to pass, branch up to date;
   - restrict who can push to `main` and block force-pushes and deletions; include administrators if policy allows.
   A check only appears in the picker after it has run once, so the order is: PR Verify runs on this PR, then add protection, then merge.
3. **Public repository + self-hosted runners.** Only `push` to `main` reaches the self-hosted pipeline, and with protection (item 2) only reviewed code lands there. Also set Settings, Actions, "Fork pull request workflows" to require approval for outside contributors; PR Verify itself uses GitHub-hosted runners.
4. **Environment `anas-mcp/prod`:** created automatically on first deploy. Optionally pre-create it with required reviewers for a manual approval gate and restrict it to the `main` branch.
5. **Cloudflare dashboard:** confirm `workers.dev` and Preview URLs are disabled and `mcp.firstsun.org` is attached (see Residual risk above).
6. **Runner pnpm:** the pnpm version on the runner image cannot be inspected from here; the first run on `main` is the evidence.

Do not mark activation complete until each item is confirmed by the operator.

## Authenticated MCP acceptance check (separate from CI smoke; not yet executed)

The credential-free smoke job proves ingress and discovery only. It does **not** prove an authorized client can use MCP. After the first production deployment, an operator must run this check manually with an approved Cloudflare Access Service Token held in the operator's secret store (never committed, never added to repository or PR workflows, never printed):

```bash
export CF_ACCESS_CLIENT_ID=...        # from the operator's secret store
export CF_ACCESS_CLIENT_SECRET=...
H=(-H "CF-Access-Client-Id: $CF_ACCESS_CLIENT_ID" -H "CF-Access-Client-Secret: $CF_ACCESS_CLIENT_SECRET" \
   -H 'content-type: application/json' -H 'accept: application/json, text/event-stream')
URL=https://mcp.firstsun.org/anas/mcp
curl -sS "${H[@]}" $URL -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"acceptance","version":"0"}}}'
curl -sS "${H[@]}" $URL -d '{"jsonrpc":"2.0","id":2,"method":"tools/list"}'
curl -sS "${H[@]}" $URL -d '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"bing_list_sites","arguments":{}}}'
# Invalid credential: expect a non-2xx response and no tools in the body.
curl -sS -i -H 'CF-Access-Client-Id: invalid.access' -H 'CF-Access-Client-Secret: invalid' \
  -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' $URL -d '{"jsonrpc":"2.0","id":4,"method":"tools/list"}'
```

Acceptance criteria: `initialize` succeeds; `tools/list` returns the expected tools; `bing_list_sites` (read-only) returns a result or a documented `data_unavailable`, and no write-capable tool is exposed; the invalid credential is rejected without tool output. Record the date, deployed Worker version, and observed status codes in `openspec/changes/use-centralized-cf-worker-ci/tasks.md`. Until then, authenticated end-to-end behavior (including ChatGPT/OAuth) is **unverified**.

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

With `deployment_strategy: production-only`, `preview_on_branch_push: false` and `shared_dev_on_branch_push: false`, the v2 workflow deploys nothing from a non-`main` ref: its Deploy condition requires `refs/heads/main` for production-only, and Shared Dev / Preview / persistent Dev are all disabled. Re-check the shared workflow before bumping the pinned SHA.

## Change policy

If `anas-mcp` needs deployment behavior that the shared workflow cannot express:

1. determine whether the need is generic to Firstsun Cloudflare Workers;
2. if generic, improve `firstsun-dev/.github` and then consume the updated reusable workflow;
3. if truly application-specific, document the exception in OpenSpec before adding local CI logic.

Production deployment must not silently diverge from the organization-managed pipeline.
