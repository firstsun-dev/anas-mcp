# Cloudflare Access (active production authentication)

Production `/anas` is protected by one Cloudflare Access application that concurrently accepts **Mode A, Managed OAuth** and **Mode B, Access Service Token**. See `docs/mcp-authentication.md` for Worker behavior and client setup, and `openspec/changes/support-dual-access-auth/` for the decision.


> **OAuth discovery URLs.** Resource server `https://mcp.firstsun.org/anas`; protected-resource metadata (RFC 9728) `https://mcp.firstsun.org/.well-known/cloudflare-access-protected-resource/anas`; authorization server `https://firstsun.cloudflareaccess.com`; its metadata (RFC 8414) `https://firstsun.cloudflareaccess.com/.well-known/oauth-authorization-server`. See `docs/mcp-authentication.md#discovery-chain-rfc-9728--rfc-8414`.

## Ownership

| Concern | Owner |
| --- | --- |
| Custom domain `mcp.firstsun.org`, Access application, Managed OAuth, identity/Service Auth policies, Service Tokens | `firstsun-dev/infra-config` (issue #59), Terraform only |
| Access assertion validation, `/health`, MCP tools, this contract | `firstsun-dev/anas-mcp` (issue #9) |

Do not provision or mutate Access resources from this repository, and do not hand-configure production state in the dashboard.

> **Path migration `/mcp` -> `/anas`.** The sections below record the original API-key -> Access rollout and still say `/mcp` where they describe that history. The current endpoint is `/anas`; the coordinated cutover (Terraform Access path update first, then this Worker's deploy, with recovery rules) is `firstsun-dev/infra-config` `docs/mcp-anas-path-cutover.md`. Access application is updated in place (AUD unchanged), so `ACCESS_AUD` is not edited.

## Ingress hardening: no alternative path around Access

Cloudflare Access is attached to the custom domain/hostname (`mcp.firstsun.org`), not to the Worker itself. A
Worker also has two other built-in ingress paths that do **not** go through that Access application unless
separately protected: the `workers.dev` subdomain and Version/Preview URLs. `wrangler.jsonc` sets both
`workers_dev: false` and `preview_urls: false` so neither is reachable; `tests/repo-guardrails.test.ts` fails the
build if either flips back to enabled (or is removed, since `workers_dev` defaults to `true` whenever the config
has no `routes`/`route`, which is the case here because the custom domain is attached by infra-config Terraform,
not by a `routes` entry in this file). Verified against the Wrangler configuration reference and the Workers
Preview URLs documentation (2026-10).

This is a guardrail on the Worker's own config, not a substitute for end-to-end verification. **Outstanding, not
yet verified**: after the next deploy, confirm from a plain `curl` that the Worker's `*.workers.dev` hostname and
any Version/Preview URL return no reachable `/anas` (disabled subdomains normally 404/not-found at the Cloudflare
edge before reaching the Worker), and that the only way to reach `/anas` is through `https://mcp.firstsun.org/anas`
once infra-config's Access application is applied. This repository cannot observe or assert live Cloudflare
account/zone state; only the operator can confirm it after deploy.

## Values the Worker needs (non-secret)

`ACCESS_TEAM_DOMAIN` and `ACCESS_AUD` in `wrangler.jsonc` `vars`, taken from the infra-config Terraform outputs after the Access application is applied. They are identifiers, not credentials.

## Coordinated rollout and rollback

This section is a **plan, not a record**. Nothing in it has been executed. No Terraform apply, Worker deploy, Access change or rollback was performed while preparing it, and the live state is unconfirmed.

### Why a Worker-only rollback is not enough

Two independently owned systems must agree on who authenticates a request:

| Layer | Owner | Changed by | Restored by a Worker version rollback? |
| --- | --- | --- | --- |
| Worker code and auth gate | `anas-mcp` | `wrangler` deploy / version deploy | Yes |
| Worker `vars` (`ACCESS_TEAM_DOMAIN`, `ACCESS_AUD`) and bindings | `anas-mcp` | Same Worker version | Expected yes; operator confirms on first use (see assumptions) |
| Access application, policies, Managed OAuth, Service Tokens, **AUD tag** | `infra-config` | Terraform | **No** |
| Custom domain `mcp.firstsun.org` to Worker routing | `infra-config` | Terraform | **No** |
| Legacy secret `ANAS_PROD_MCP_API_KEY` (Secrets Store) | operator | Secrets Store | **No** |

The two Worker generations accept disjoint credentials:

| | Previous Worker (merged PR #8, `dd0783c`) | New Worker (this PR) |
| --- | --- | --- |
| Gate | `Authorization: Bearer <ANAS_MCP_API_KEY>` compared inside the Worker | Valid `Cf-Access-Jwt-Assertion` (signature, issuer, AUD, exp) |
| Needs Access in front | No | Yes. Without Access there is no assertion, so `/mcp` returns `401` |
| Needs the Secrets Store secret | Yes (binding must resolve) | No |
| When misconfigured | Fails closed | Fails closed (`503` empty vars, `401` bad assertion) |

| Worker | Access application on `mcp.firstsun.org` | Result |
| --- | --- | --- |
| Previous | Not attached | Works for existing API-key clients. Assumed to be today's state (unverified). |
| Previous | Attached | **Total outage.** Access stops API-key clients at the edge; Access-authenticated clients carry no API key, so the Worker rejects them. Not a valid steady state. |
| New | Not attached | Outage: no assertion, `401` (or `503` while the vars are empty). |
| New, wrong `ACCESS_AUD` / team domain | Attached | Outage: `401` (claim mismatch) or `503` (empty or invalid vars). |
| New, correct vars | Attached | Target state. |

Every combination is **fail-closed**. A bad rollout costs availability, not exposure, as long as the safety rules below are followed.

### Unverified assumptions (check before relying on them)

- Which Worker version is live in production and how it was deployed. This repository has no deployment workflow, Actions deployment run or recorded GitHub deployment (only the test-only `pr-verify.yml` exists).
- Whether `infra-config` PR #68 has been applied. Merged is not applied.
- That Worker `vars` travel with a Worker version, so redeploying an earlier new-Worker version restores its own vars.
- Whether Managed OAuth forwards an `Authorization` header to the origin. The new Worker ignores it; the previous Worker would treat an Access-issued token as a wrong key.
- Whether `wrangler versions deploy` / `wrangler rollback` changes the script-level `workers.dev` and Preview URL settings. Inspect them after any rollback instead of assuming.
- Which clients hold the legacy API key.

### Pre-flight (all must pass before the change window)

1. Record the **current live Worker version ID** and deploy time (`wrangler deployments list`, read-only). This is the rollback target. Confirm it is at or after PR #8 (`b128a25`) (rule R1).
2. Confirm `ANAS_PROD_MCP_API_KEY` exists in Secrets Store and the previous version's binding resolves. Do not delete or rotate it until the soak in step 6 ends (R4).
3. Obtain evidence of the `infra-config` plan for the Access application and the current Terraform state, so the revert target is known.
4. Inventory the clients holding the legacy API key and announce the cutover. They stop working at Access.
5. Arrange operator-held recovery credentials: a Service Token and an approved identity.
6. Confirm the live script's `workers.dev` and Preview URL state.

### Rollout order and checkpoints

The AUD tag only exists after Terraform creates the Access application, so the Worker vars cannot be filled in first. The ordering below is therefore forced, and the outage window starts at step 2.

| Step | Action | Checkpoint to continue | Stop condition |
| --- | --- | --- | --- |
| 1 | Pre-flight | All items satisfied | Any item unknown |
| 2 | Operator applies the reviewed `infra-config` Terraform | Plan contains only the Access application, policies and domain attachment. `GET /health` still `200`. **Outage window opens**: the previous Worker is now behind Access. | Plan shows other changes |
| 3 | Read `anas_mcp_access_team_domain` and `anas_mcp_access_aud` from the real outputs and set them in `wrangler.jsonc` `vars` | Values match the outputs exactly | Outputs missing or ambiguous |
| 4 | Merge and deploy the new Worker | `/mcp` without a credential does not return `200` | Unexpected `200` |
| 5 | Verify both modes (matrix below) | OAuth and Service Token both reach `tools/list`; a no-credential `POST /mcp` is blocked at the edge | Either mode fails |
| 6 | Soak. Retire `ANAS_PROD_MCP_API_KEY` in a separate, later change | Agreed soak with no rollback | Anyone still needs the old key |

Keep steps 2 to 5 in one maintenance window and do not announce the Access behaviour to clients earlier.

### When restoring the previous Worker version alone is safe

A Worker-only rollback (`wrangler rollback`, or deploying the recorded version) is safe and sufficient only when **all** hold:

1. Access is **not** attached to `mcp.firstsun.org/mcp` (never applied, or already reverted).
2. The target version contains the API-key gate: it is at or after PR #8 (R1).
3. `ANAS_PROD_MCP_API_KEY` still resolves in Secrets Store.
4. The clients that must keep working are API-key clients.
5. The fault is entirely in the Worker (for example a bad build), not in Access or routing.

If the only problem is wrong `ACCESS_TEAM_DOMAIN` / `ACCESS_AUD`, use a **forward fix** (redeploy the new Worker with corrected vars). Rolling back would convert a config error into an outage for Access clients.

### When Access configuration or routing must also be restored

Restore Access/routing (through `infra-config` Terraform only) as well as the Worker when any of these is true:

- Access is attached and API-key clients must work again. The previous Worker cannot serve Access clients, and Access blocks API-key clients.
- The Access application was recreated and its AUD changed. An old AUD can never validate; the new Worker needs new vars.
- The custom-domain attachment changed (hostname moved, removed, or pointed at another Worker).

If instead a policy change locked out approved identities or tokens, fix the policy forward and leave the Worker alone.

Recovery order for a full revert (every intermediate state is fail-closed):

1. Stop and record evidence: status codes and the `access_rejected` reason codes. Never record headers, tokens or assertions.
2. Deploy the recorded previous Worker version. The endpoint stays fail-closed.
3. The operator reverts the Access attachment through `infra-config` Terraform to the recorded prior state.
4. Run the recovery validation below. Do not announce recovery until it passes.

### Deployment verification and rollback decision matrix

| Observation | Likely cause | Action | Worker-only rollback safe? | Restore Access / routing? |
| --- | --- | --- | --- | --- |
| `503 auth_unavailable`, log `access_not_configured` | Empty or invalid `ACCESS_*` vars | Forward fix with verified values | Only if Access is not attached | No |
| `503`, log `jwks_unavailable` | Access JWKS unreachable (team-domain typo, Cloudflare incident) | Verify the team domain; wait out an incident. Do not roll back for a provider outage. | n/a | No |
| `401` for requests Access allowed, log `ERR_JWT_CLAIM_VALIDATION_FAILED` | AUD, issuer or expiry mismatch (application recreated, wrong output) | Forward fix: correct `ACCESS_AUD` / team domain | No | Only if the application must be reverted |
| `401`, log `missing_assertion` for everyone | Access not attached to this hostname or path | Attach Access, or full revert | Only if criterion 1 holds | Yes, if reverting |
| One mode works, the other fails | Policy or token problem | Fix the policy in Terraform | No | Policy only |
| `200` on `/mcp` with no credential | Gate bypassed. **Treat as exposure.** | Exposure response below | n/a | n/a |
| `403` from the Worker (`Invalid Host` / `Invalid Origin`) | Request through another hostname or from a browser | Expected rejection. Do not widen the allowlists. | n/a | No |
| `GET /health` not `200` | Routing or deploy failure | Check the domain attachment and Worker version | Yes if Access is not attached | If routing changed |

### Exposure response

If `/mcp` ever answers `tools/list` without a valid credential: immediately deploy a known fail-closed version (the recorded previous version if it is API-key gated and its secret resolves, otherwise the last new-Worker version with correct vars). If the gate cannot be restored quickly, detach the hostname from the Worker through `infra-config`. Investigate afterwards.

### Safety rules

- **R1** Never deploy a Worker version that predates PR #8 (`b128a25`); earlier versions had no authentication. Check the version's commit before any rollback.
- **R2** Never set the Access application to a Bypass / everyone policy to "get clients working". It does not restore service (the new Worker still needs an assertion) and removes the edge layer.
- **R3** Never re-enable `workers_dev` or Preview URLs to reach the Worker directly.
- **R4** Never delete or rotate `ANAS_PROD_MCP_API_KEY` before the soak ends, and never put it in `vars`, source or CI.
- **R5** Do not add a third authentication mode (query-string key, IP allowlist). The API-key path returns only through rolling back the whole Worker version.
- **R6** Change Access through `infra-config` Terraform, not the dashboard, so state stays truthful.
- **R7** Do not claim recovery before the validation below passes.

### Stop conditions

Halt the window and choose forward fix, Worker rollback or full revert from the matrix if any occur: unknown live Worker version; no Terraform plan or state evidence; a plan with changes beyond the Access application and domain attachment; either auth mode failing at step 5; any unexpected `200` without a credential; logs containing a header, token or assertion; the previous version's secret no longer resolving.

### Recovery validation (after any rollback or revert)

Use operator-held credentials only and never record secrets:

1. `GET https://mcp.firstsun.org/health` returns `{"service":"anas-mcp","status":"ok"}`.
2. `POST /anas` with no credential is rejected (`401` or an Access challenge) and does not initialize MCP.
3. A client of the **restored** mode completes `initialize` and `tools/list`: API key for the previous Worker; Managed OAuth and a Service Token for the new Worker.
4. A client of the mode no longer expected to work fails closed (never `200`).
5. `*.workers.dev` and any Preview URL do not serve `/anas`.
6. Logs show only fixed `access_rejected` reason codes and no credential material.

None of this is verified until it has been run against the live system.

## Verification matrix (after authorized rollout)

| Client | Mode | Expected |
| --- | --- | --- |
| ChatGPT | Managed OAuth | login, initialize, tools/list, tool call |
| MCP Inspector / OAuth client | Managed OAuth | OAuth + PKCE succeeds |
| Headless agent | Service Token | initialize, tools/list |
| Unapproved identity | OAuth | blocked |
| Invalid/revoked Service Token | Service Token | 401/403, no login redirect |
| No/invalid assertion at Worker | origin validation | `401` before MCP |
| `/health` | public | `{"service":"anas-mcp","status":"ok"}` |

Also confirm OAuth still works while a Service Token is configured, and vice versa. None of this is verified until it has actually been run against the deployed system.

## Smoke checks (no secrets in CI logs)

- `GET https://mcp.firstsun.org/health` returns the minimal body.
- `POST https://mcp.firstsun.org/anas` with no credentials is blocked/challenged by Access (it never reaches the Worker).
- Service Token checks use operator-held credentials; never place the Client Secret in repository files or CI logs.
