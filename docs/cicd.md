# CI/CD

## Decision

`anas-mcp` uses the reusable Cloudflare Worker pipeline maintained in `firstsun-dev/.github` for deployment.

The application repository may contain a thin caller workflow that defines triggers and application-specific inputs, but it MUST NOT copy or fork the shared Cloudflare deployment implementation.

Canonical reusable workflow:

```yaml
uses: firstsun-dev/.github/.github/workflows/_cf-worker-template.yml@v1.5.0
```

The caller pins a release tag (or an approved commit SHA). Do not point production deployment at a branch or the floating `@v1`.

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

Verified against `_cf-worker-template.yml@v1.5.0` (tag commit `cd1cdc0ab29d5069bc31b5faef55d271e62dac36`); the shared repository is consumed unmodified.

```yaml
on:
  push:
    branches: [main]
concurrency:
  group: anas-mcp-production-deploy
  cancel-in-progress: false
jobs:
  pipeline:
    uses: firstsun-dev/.github/.github/workflows/_cf-worker-template.yml@v1.5.0
    secrets: inherit
    with:
      app_name: anas-mcp
      app_path: .
      app_version: ${{ github.sha }}
      test_unit_cmd: pnpm run check
      build_cmd: pnpm exec wrangler deploy --dry-run
      app_url_prod: https://mcp.firstsun.org
  smoke: # read-only, see below
```

- **Main only.** The only trigger is `push` to `main`. There is no `pull_request`, `workflow_dispatch`, or other-branch trigger, so the template's `--env dev` branch path (this repository defines no `env.dev`) can never run, and PR code never reaches the deploy-capable pipeline or the org's self-hosted runners. `enable_preview_alias`, `app_url_dev`, and `worker_name_dev` are unset.
- **Pinned.** `@v1.5.0` is a release tag, not a branch or floating `@v1`. `tests/repo-guardrails.test.ts` rejects `@main`/`@v1` and any input the template does not declare. Pinning to the commit SHA is stricter (tags are mutable) and is allowed by the test.
- **Inputs.** `app_version` is the commit SHA (the template runs `pnpm -r version` on it with `|| true`; verified locally that with this `pnpm-workspace.yaml` it matches no projects and exits 0, so `package.json` is not rewritten). `test_unit_cmd` runs the aggregate check (typecheck, Vitest, `redocly lint`) before any migrate/deploy job. `build_cmd` is the template's only build hook; the Worker is bundled by `wrangler versions upload`, so a dry-run build is a no-op safety gate. `verify_cmd` is deliberately unset (see Smoke tests).
- **Runner.** The template default (`linux`, the org's trusted self-hosted runners) is used. Only merged `main` code runs there.
- **Serialization.** The template defines no `concurrency`. The caller does: one production deployment at a time, `cancel-in-progress: false` so a running deploy is never cancelled; GitHub keeps at most one pending run, so a newer push supersedes an older queued one (latest `main` wins).
- **Credentials.** The template declares no `secrets:` block, so `secrets: inherit` is required. It reads only `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` (organization secrets). Smoke and PR jobs receive no secrets.

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

A push to `main` deploys production immediately. The `/mcp` -> `/anas` change must not be merged until `infra-config` has applied the Access path update (see `infra-config/docs/mcp-anas-path-cutover.md`); otherwise the `smoke` job fails on the missing `/anas` protected-resource metadata (the Worker itself stays fail-closed). The smoke job also asserts `/mcp` and `/anas2` serve nothing.

## Smoke tests and rollback

The template's `verify_cmd` path installs Playwright and, on failure, runs `wrangler versions deploy <previous>@100`. For this service that is unsafe: the previous version may predate Cloudflare Access authentication, so an automatic revert could reopen `/anas` with a weaker gate. `verify_cmd` is therefore unset and the caller adds an application-specific `smoke` job (`scripts/smoke-prod.sh`; GitHub-hosted, no secrets, `contents: read`) that runs after a successful `pipeline` and checks, with unauthenticated requests only:

1. `GET /health` is `200` with `{service: "anas-mcp", status: "ok"}`.
2. `POST /anas` without credentials is `401`/`403` and returns no `tools`; `POST /mcp` and `POST /anas2` are `401`/`403`/`404` and return no `tools`.
3. `GET /.well-known/cloudflare-access-protected-resource/anas` returns `200` with `resource == https://mcp.firstsun.org/anas` and the Access issuer in `authorization_servers`.
4. `GET <issuer>/.well-known/oauth-authorization-server` is reachable and its `issuer` equals `https://firstsun.cloudflareaccess.com` (the `ACCESS_TEAM_DOMAIN` in `wrangler.jsonc`; a test guards drift).

Transport errors (DNS, connect, timeout) and HTTP `5xx` are retried up to 6 requests per check with a 5 s delay (bounded; curl's exit status is handled separately from its HTTP status). `tests/smoke-script.test.ts` exercises the script with a mock `curl` (DNS error, connection failure, timeout, `502` then `200`, persistent `503`, success, and rejection cases); it is skipped where `bash`/`jq` are missing. On failure the job fails the run with "OPERATOR INTERVENTION REQUIRED".

**This design has NO automatic rollback.** A failed smoke test leaves the new version live. Operators must decide to roll forward or manually run `wrangler versions deploy <known-good-id>@100` after confirming that version has the Access gate. The smoke checks do not prove an authenticated MCP session works; that still requires an operator-held Access credential (Managed OAuth or Service Token) and is not performed in CI.

## Pull request verification gate

`.github/workflows/pr-verify.yml` runs on `pull_request` only: `pnpm install --frozen-lockfile`, `pnpm run check` (TypeScript, Vitest including security/regression tests, `redocly lint openapi.yaml` for OpenAPI 3.2) and `pnpm exec wrangler deploy --dry-run`. It cannot deploy: no push/dispatch trigger, `permissions: contents: read`, no secrets, no Cloudflare credentials, no call to the shared template, GitHub-hosted runner (this repository is public; PR code must not run on self-hosted runners). `tests/repo-guardrails.test.ts` fails if any of that changes. To make a failing check block merging, require the `PR Verify / Verify (…)` check in branch protection for `main` (a repository setting; not configured by this repository).

## Package manager

The repository uses **pnpm** (`packageManager: pnpm@10.33.0`, matching `blog`, `heaven-monorepo` and `innovation-apps`), with a committed `pnpm-lock.yaml` and `pnpm-workspace.yaml` (`allowBuilds`). `package-lock.json` is removed. The shared setup action runs `pnpm install --frozen-lockfile` and the template calls `pnpm exec wrangler`; both were exercised locally with pnpm 10.33.0 on Node 24 (the template's `NODE_VERSION`). The self-hosted runner image bakes in Node/pnpm (`setup-node`/`setup-pnpm: false`); its pnpm version cannot be inspected from here and is verified only by the first run on `main`.

## Production release gates (status as of 2026-10-15)

**Merging this PR is the first production deployment.** Because `cicd.yml` deploys every push to `main`, `main` must be gated before activation. This repository does not change GitHub or Cloudflare settings; the items below are operator actions.

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
URL=https://mcp.firstsun.org/anas
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

The central template treats pull requests as test-only, `main` pushes as production deployment, and every other branch push as `--env dev`. `anas-mcp` defines no `env.dev`, so the caller must never run the template for non-`main` events; it triggers on `main` only. Re-check the template before bumping `@v1.5.0`.

## Change policy

If `anas-mcp` needs deployment behavior that the shared workflow cannot express:

1. determine whether the need is generic to Firstsun Cloudflare Workers;
2. if generic, improve `firstsun-dev/.github` and then consume the updated reusable workflow;
3. if truly application-specific, document the exception in OpenSpec before adding local CI logic.

Production deployment must not silently diverge from the organization-managed pipeline.
