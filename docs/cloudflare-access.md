# Cloudflare Access (active production authentication)

Production `/mcp` is protected by one Cloudflare Access application that concurrently accepts **Mode A, Managed OAuth** and **Mode B, Access Service Token**. See `docs/mcp-authentication.md` for Worker behavior and client setup, and `openspec/changes/support-dual-access-auth/` for the decision.

## Ownership

| Concern | Owner |
| --- | --- |
| Custom domain `mcp.firstsun.org`, Access application, Managed OAuth, identity/Service Auth policies, Service Tokens | `firstsun-dev/infra-config` (issue #59), Terraform only |
| Access assertion validation, `/health`, MCP tools, this contract | `firstsun-dev/anas-mcp` (issue #9) |

Do not provision or mutate Access resources from this repository, and do not hand-configure production state in the dashboard.

## Values the Worker needs (non-secret)

`ACCESS_TEAM_DOMAIN` and `ACCESS_AUD` in `wrangler.jsonc` `vars`, taken from the infra-config Terraform outputs after the Access application is applied. They are identifiers, not credentials.

## Coordinated rollout (required ordering)

Verified 2026-10-07: this repository has **no** `.github/workflows` caller, no GitHub Actions runs, and no recorded GitHub deployments, so merging to `main` does **not** deploy anything today. The centralized caller described in `docs/cicd.md` is not wired up yet. Which Worker version is live in production, and how it was deployed (presumably a manual `wrangler deploy`), cannot be determined from this repository and must be confirmed by the operator before rollout.

**If a caller workflow is added before this rolls out, `main` pushes will deploy to production** (`docs/cicd.md` branch behavior). Then merge ordering becomes a deployment ordering and the steps below must be followed strictly.

1. Merge/apply nothing until both PRs (`anas-mcp` PR for issue #9 and the `infra-config` PR for issue #59) are reviewed.
2. Operator runs the reviewed infra-config `terraform apply`. It attaches `mcp.firstsun.org` and creates the Access application. The currently deployed Worker is untouched.
3. Read `anas_mcp_access_team_domain` and `anas_mcp_access_aud` from the Terraform outputs and set them in `wrangler.jsonc` `vars` (do not deploy with empty values: `/mcp` returns `503`).
4. Merge the Worker PR and deploy the new Worker (assertion required, API key gone) as part of the same rollout window.
5. Immediately verify both modes (matrix below). Roll back by redeploying the previous Worker version, or reverting and redeploying, if either mode is blocked.

Failure states to avoid:

- *New Worker deployed, Access not active:* every `/mcp` request fails (`503` with empty vars, `401` without an assertion). Avoided by applying infra (step 2) and setting the vars (step 3) first.
- *Access active, old Worker still expecting `ANAS_MCP_API_KEY`:* Access forwards an assertion, but the old Worker only accepts a bearer key, so requests fail. Avoided by deploying the new Worker in the same window (step 4) and not announcing the Access hostname to clients before then.

The old API-key path is not kept as a third mode. Once the new Worker is deployed, the previous hostname/key no longer works by design.

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
- `POST https://mcp.firstsun.org/mcp` with no credentials is blocked/challenged by Access (it never reaches the Worker).
- Service Token checks use operator-held credentials; never place the Client Secret in repository files or CI logs.
