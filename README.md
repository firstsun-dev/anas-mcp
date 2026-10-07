# anas-mcp

Cloudflare-hosted, read-only Remote MCP service for Firstsun analytics.

## Architecture

```text
ChatGPT / MCP client
        |
        | Authorization: Bearer <dedicated anas-mcp API key>
        v
Cloudflare Worker: anas-mcp
        |
        | authenticate BEFORE MCP initialization / tool execution
        | (key from Cloudflare Secrets Store)
        v
createMcpHandler() --> read-only analytics tools
        |
        |
        +--> Google Analytics Data API
        +--> Google Search Console API
        +--> Hyperdrive --> PostgreSQL --> Clarity analytics
```

- **HTTP API contract:** repository-root `openapi.yaml` uses OpenAPI 3.2.0 and is intended for Swagger-compatible tooling. It documents the HTTP surface; MCP tools remain MCP-native schemas rather than fake REST endpoints.
- **MCP authentication:** production `/mcp` requires `Authorization: Bearer <ANAS_MCP_API_KEY>`, a dedicated service-level key stored in Cloudflare Secrets Store and checked in the Worker before any MCP/tool/database work. `/health` stays public and minimal.
- **GA4:** direct Google Analytics Data API queries.
- **Search Console:** direct Search Console API queries.
- **Clarity:** read normalized PostgreSQL data populated by `firstsun-dev/windmill-flows`; this service never calls the Clarity API directly.
- **Credentials:** Secrets Store first. Any long-lived secret consumed directly by this Worker should come from Cloudflare Secrets Store whenever supported.
- **Google OAuth:** one JSON credential stored in Cloudflare Secrets Store.
- **Database:** read-only PostgreSQL access through Cloudflare Hyperdrive; the database password remains managed by Hyperdrive and is not duplicated into Worker secrets.
- **CI/CD:** Cloudflare Worker deployment is implemented centrally in `firstsun-dev/.github`; this repository must use a thin caller for the shared `_cf-worker-template.yml` workflow rather than duplicating deploy steps.

See:

- `openapi.yaml` and `docs/api.md` for the HTTP/OpenAPI contract
- `docs/mcp-authentication.md` for MCP API-key authentication, provisioning, client setup, and rotation
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

A dedicated bearer API key (`Authorization: Bearer <ANAS_MCP_API_KEY>`) is the production boundary for `/mcp`. It is service-level: it identifies no individual user and has no per-tool scopes. Failures return a generic `401` with `WWW-Authenticate: Bearer`.

The key must be high-entropy, generated outside source control, stored only in Cloudflare Secrets Store, and used for nothing else. `CLOUDFLARE_API_TOKEN` and provider/database/CI credentials are never valid substitutes. Do not accept the key via query string, and do not rely on OpenAI IP allowlisting or User-Agent checks.

OAuth or another identity-aware mechanism requires a future accepted OpenSpec change (see `openspec/changes/use-mcp-api-key-auth/`). `anas-mcp` must not add KV, D1, Durable Objects, or PostgreSQL auth tables for MCP client authentication.

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

- The MCP API key is application-owned and lives in Secrets Store (`ANAS_PROD_MCP_API_KEY`, bound as `ANAS_MCP_API_KEY`); it is never a reused infrastructure credential.
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
- dedicated bearer API-key authentication for `/mcp` (runtime gate + tests implemented; production Secrets Store value and deployed-client verification pending operator provisioning)
- centralized `firstsun-dev/.github` Cloudflare Worker CI/CD decision

Production Secrets Store key provisioning, datasource integrations, deployment caller, automated OpenAPI validation, and end-to-end ChatGPT authentication are not considered verified until actually tested.

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

Locally, `wrangler dev` simulates the Secrets Store binding; create a local-only secret with `wrangler secrets-store secret create` (see `docs/mcp-authentication.md`) and pass it as `Authorization: Bearer <key>` in MCP Inspector. Production authentication must be verified against the deployed Worker.

## Verification

```bash
npm run check
```

The final project check should also validate `openapi.yaml` with an OpenAPI 3.2-capable validator. Until that validator is actually wired in, OpenAPI automated validation remains pending.

For production auth, follow `docs/mcp-authentication.md` and verify missing, invalid, and valid bearer credentials against the deployed Worker.

## Deployment

Do not make `npm run deploy` or locally copied Wrangler deployment commands the normal production CI path.

Production/development CI deployment must be invoked through the reusable workflow maintained by `firstsun-dev/.github`. The application repository should contain only the thin caller after package-manager compatibility, versioning, URLs, and Cloudflare bootstrap credentials have been resolved.

See `docs/cicd.md`.

Do not commit real Cloudflare resource IDs, database credentials, Google OAuth credentials, bearer API keys, or private analytics payloads.

## OpenSpec

Start with:

- `openspec/project.md` — project architecture and boundaries
- `openspec/specs/analytics-mcp/spec.md` — baseline capability requirements
- `openspec/changes/bootstrap-analytics-mcp/` — bootstrap design/tasks
- `openspec/changes/use-mcp-api-key-auth/` — active dedicated bearer API-key authentication decision
- `openspec/changes/add-cloudflare-access-auth/` — superseded Cloudflare Access decision (historical only)
- `openspec/changes/use-centralized-cf-worker-ci/` — organization-managed Cloudflare Worker CI/CD decision
- `openspec/changes/adopt-openapi-http-contract/` — OpenAPI/Swagger HTTP contract decision
- `docs/api.md` — OpenAPI/Swagger ownership and drift policy
- `docs/mcp-authentication.md` — MCP bearer API-key model, provisioning, client setup, rotation
- `docs/cloudflare-access.md` — superseded Access notes (historical)
- `docs/credentials.md` — credential ownership, storage, and exception policy
- `docs/cicd.md` — reusable deployment workflow policy

See `AGENTS.md` before making code or architecture changes.
