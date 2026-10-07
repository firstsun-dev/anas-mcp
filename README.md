# anas-mcp

Cloudflare-hosted, read-only Remote MCP service for Firstsun analytics.

## Architecture

```text
Mode A: ChatGPT / OAuth client      Mode B: agent / CI / automation
        | Managed OAuth + PKCE                | CF-Access-Client-Id / -Secret
        +------------------+------------------+
                           v
        Cloudflare Access (one application, https://mcp.firstsun.org/mcp)
                           | Cf-Access-Jwt-Assertion
                           v
Cloudflare Worker: anas-mcp
        |
        | validate the Access JWT BEFORE MCP initialization / tool execution
        v
createMcpHandler() --> read-only analytics tools
        |
        |
        +--> Google Analytics Data API
        +--> Google Search Console API
        +--> Hyperdrive --> PostgreSQL --> Clarity analytics
```

- **HTTP API contract:** repository-root `openapi.yaml` uses OpenAPI 3.2.0 and is intended for Swagger-compatible tooling. It documents the HTTP surface; MCP tools remain MCP-native schemas rather than fake REST endpoints.
- **MCP authentication:** production `/mcp` is protected by one Cloudflare Access application that concurrently accepts **Mode A, Managed OAuth** (interactive clients such as ChatGPT) and **Mode B, Access Service Token** (headless agents). The Worker validates `Cf-Access-Jwt-Assertion` before any MCP/tool/database work. `/health` stays public and minimal. Cloudflare configuration is owned by `firstsun-dev/infra-config`.
- **GA4:** direct Google Analytics Data API queries.
- **Search Console:** direct Search Console API queries.
- **Clarity:** read normalized PostgreSQL data populated by `firstsun-dev/windmill-flows`; this service never calls the Clarity API directly.
- **Credentials:** Secrets Store first. Any long-lived secret consumed directly by this Worker should come from Cloudflare Secrets Store whenever supported.
- **Google OAuth:** one JSON credential stored in Cloudflare Secrets Store.
- **Database:** read-only PostgreSQL access through Cloudflare Hyperdrive; the database password remains managed by Hyperdrive and is not duplicated into Worker secrets.
- **CI/CD:** Cloudflare Worker deployment is implemented centrally in `firstsun-dev/.github`; this repository must use a thin caller for the shared `_cf-worker-template.yml` workflow rather than duplicating deploy steps.

See:

- `openapi.yaml` and `docs/api.md` for the HTTP/OpenAPI contract
- `docs/mcp-authentication.md` and `docs/cloudflare-access.md` for dual-mode Access authentication, client setup, and rollout
- `docs/credentials.md` for credential ownership/storage policy
- `docs/cicd.md` for centralized deployment policy and caller-workflow contract

## OpenAPI / Swagger policy

`openapi.yaml` is the canonical HTTP API description.

Current documented HTTP surface:

```text
GET  /health
POST /mcp
```

Use Swagger-compatible OpenAPI 3.2 tooling to inspect/render the contract.

Do not represent MCP tools such as future `ga4_run_report`, `gsc_search_analytics`, or `clarity_page` as fake REST routes. Those contracts belong to MCP tool schemas and are discovered through MCP.

Any change to an HTTP route, method, authentication requirement, status code, content type, or stable payload must update `openapi.yaml` in the same change.

Automated OpenAPI validation is tracked in `openspec/changes/adopt-openapi-http-contract/` and must be included in the project check/centralized CI path before being considered complete.

## Authentication policy summary

Production `/mcp` accepts two authentication modes **at the same time** through one Cloudflare Access application: Mode A, Managed OAuth (authorization code + PKCE) for interactive clients, and Mode B, Access Service Token (`CF-Access-Client-Id` + `CF-Access-Client-Secret`) for headless agents. This is not a toggle, fallback chain, or pair of endpoints.

Cloudflare Access owns OAuth and Service Token evaluation. The Worker only verifies the resulting `Cf-Access-Jwt-Assertion` (signature, issuer, AUD, expiry) and fails closed with a generic `401` (or `503` if its non-secret Access config is missing). Service Tokens identify machines, not users. `CLOUDFLARE_API_TOKEN` and provider/database/CI credentials are never valid substitutes, credentials are never accepted via query string, and IP allowlisting or User-Agent checks are not authentication. `anas-mcp` must not add OAuth endpoints, KV, D1, Durable Objects, or PostgreSQL auth tables for MCP client authentication.

## Credential policy summary

Use Cloudflare Secrets Store as the production source of truth for application-held secrets such as Google OAuth credentials, API tokens, client secrets, signing keys, and encryption keys.

Do not put production credentials in:

- Wrangler `vars`
- committed configuration
- `.env` or `.dev.vars`
- source code
- logs

Do not use `wrangler secret` when Secrets Store can serve the same production credential unless an accepted OpenSpec change documents why.

Intentional exceptions:

- MCP client authentication holds no Worker secret: Access OAuth tokens, assertions, and Service Token credentials are Access-managed or client-held. The Worker only has non-secret `ACCESS_TEAM_DOMAIN` / `ACCESS_AUD` vars.
- PostgreSQL credentials stay in the Hyperdrive connection.
- The Microsoft Clarity API token stays in `firstsun-dev/windmill-flows` because this service never calls Clarity directly.
- Derived short-lived Google OAuth access tokens stay in runtime memory only.
- CI bootstrap credentials such as the Cloudflare deploy token/account ID may use the protected GitHub Actions mechanism required by the organization-managed reusable deployment workflow.

## CI/CD policy summary

The deployment implementation belongs to:

```text
firstsun-dev/.github/.github/workflows/_cf-worker-template.yml
```

`anas-mcp` may add a thin caller workflow similar to:

```yaml
jobs:
  pipeline:
    uses: firstsun-dev/.github/.github/workflows/_cf-worker-template.yml@v1
    secrets: inherit
    with:
      app_name: anas-mcp
      app_path: .
      app_version: <project version>
      build_cmd: <verified build/check command>
```

Do not copy the shared `wrangler versions upload/deploy`, rollback, or generic runner logic into this repository.

The current project uses npm scripts while the central workflow currently invokes `pnpm exec wrangler` internally. Package-manager compatibility must be verified before the caller is enabled; if there is a mismatch, prefer aligning the project or improving the central workflow rather than forking deploy logic locally.

See `docs/cicd.md` and `openspec/changes/use-centralized-cf-worker-ci/`.

## Current state

The repository currently contains the MCP foundation and architecture specifications:

- stateless `/mcp` endpoint using Cloudflare Agents SDK
- `/health` HTTP endpoint
- MCP `health` tool
- OpenAPI 3.2.0 HTTP contract
- OpenSpec architecture, requirements, design, and implementation tasks
- Secrets Store first credential policy
- Cloudflare Access assertion validation for `/mcp` (Worker validation + local tests implemented; Access application, Managed OAuth, Service Token, and production E2E pending `infra-config#59` rollout)
- centralized `firstsun-dev/.github` Cloudflare Worker CI/CD decision

Cloudflare Access rollout and E2E (ChatGPT OAuth, Service Token, concurrent use), datasource integrations, deployment caller, automated OpenAPI validation, and end-to-end ChatGPT authentication are not considered verified until actually tested.

## Development

```bash
npm install
npm run dev
```

Health endpoint:

```text
http://localhost:8787/health
```

MCP endpoint:

```text
http://localhost:8787/mcp
```

Test MCP locally with:

```bash
npx @modelcontextprotocol/inspector@latest
```

Locally, `/mcp` requires an Access assertion that only Cloudflare Access can mint, so the test suite signs assertions with a generated key (see `docs/mcp-authentication.md`). Do not add an auth bypass for development. Production authentication must be verified against the deployed Worker through Access.

## Verification

```bash
npm run check
```

The final project check should also validate `openapi.yaml` with an OpenAPI 3.2-capable validator. Until that validator is actually wired in, OpenAPI automated validation remains pending.

For production auth, follow `docs/cloudflare-access.md` and verify Managed OAuth and Service Token (concurrently), blocked identities/tokens, and the origin `401` against the deployed system.

## Deployment

Do not make `npm run deploy` or locally copied Wrangler deployment commands the normal production CI path.

Production/development CI deployment must be invoked through the reusable workflow maintained by `firstsun-dev/.github`. The application repository should contain only the thin caller after package-manager compatibility, versioning, URLs, and Cloudflare bootstrap credentials have been resolved.

See `docs/cicd.md`.

Do not commit real Cloudflare resource IDs, database credentials, Google OAuth credentials, Access assertions, Service Token secrets, or private analytics payloads.

## OpenSpec

Start with:

- `openspec/project.md` — project architecture and boundaries
- `openspec/specs/analytics-mcp/spec.md` — baseline capability requirements
- `openspec/changes/bootstrap-analytics-mcp/` — bootstrap design/tasks
- `openspec/changes/support-dual-access-auth/` — active concurrent Managed OAuth + Service Token authentication decision
- `openspec/changes/use-mcp-api-key-auth/`, `openspec/changes/add-cloudflare-access-auth/` — superseded decisions (historical only)
- `openspec/changes/use-centralized-cf-worker-ci/` — organization-managed Cloudflare Worker CI/CD decision
- `openspec/changes/adopt-openapi-http-contract/` — OpenAPI/Swagger HTTP contract decision
- `docs/api.md` — OpenAPI/Swagger ownership and drift policy
- `docs/mcp-authentication.md` — dual-mode Access authentication model and client setup
- `docs/cloudflare-access.md` — Access ownership, rollout ordering, verification matrix
- `docs/credentials.md` — credential ownership, storage, and exception policy
- `docs/cicd.md` — reusable deployment workflow policy

See `AGENTS.md` before making code or architecture changes.
