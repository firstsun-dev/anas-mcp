# anas-mcp project

## Mission
Provide ChatGPT and other MCP clients with safe, read-only access to Firstsun analytics through one Cloudflare-hosted Remote MCP service.

## Authentication strategy

Production MCP access is authenticated and authorized by **Cloudflare Access**.

- The production `/mcp` resource SHALL sit behind a Cloudflare Access self-hosted application with **Managed OAuth** enabled.
- MCP clients such as ChatGPT authenticate through Access using standards-based OAuth discovery and the authorization-code flow with PKCE.
- Cloudflare Access policies are the primary user authorization boundary. Production policy should be default-deny and explicitly allow approved Firstsun identities/groups.
- `anas-mcp` SHALL NOT implement a parallel username/password system or a custom long-lived shared-token scheme for normal interactive MCP access.
- Do not authenticate ChatGPT by OpenAI IP allowlists, User-Agent matching, query-string secrets, or a shared static bearer token.
- Access-managed OAuth state and access tokens are owned by Cloudflare Access; `anas-mcp` does not persist MCP OAuth token state in KV, D1, Durable Objects, or PostgreSQL.
- The Worker may consume only the minimum authenticated identity/context forwarded by Access when needed for authorization or audit; it must not expose Access tokens or identity assertions to MCP tool results.
- `/health` may remain unauthenticated when Access is scoped specifically to `/mcp`; it must expose readiness only and no configuration or credential state.

This decision is specified in `openspec/changes/add-cloudflare-access-auth/` and `docs/cloudflare-access.md`.

## CI/CD strategy

Cloudflare Worker CI/CD is centralized in **`firstsun-dev/.github`**.

- Production and development deployment implementation SHALL use the organization-managed reusable workflow `firstsun-dev/.github/.github/workflows/_cf-worker-template.yml`.
- `anas-mcp` may contain a thin caller workflow that defines triggers, application-specific inputs, test/build commands, target URLs, and `secrets: inherit` as required by the reusable workflow contract.
- `anas-mcp` SHALL NOT copy or fork the shared `wrangler versions upload/deploy`, generic branch routing, rollback, or organization-wide runner/setup implementation merely to customize deployment.
- Generic Cloudflare pipeline improvements belong in `firstsun-dev/.github`; application-specific exceptions require an accepted OpenSpec change.
- CI bootstrap credentials required to authenticate GitHub Actions to Cloudflare may use the protected GitHub Actions secret/configuration mechanism expected by the reusable workflow. Runtime provider credentials must not be copied into GitHub Actions solely for deployment.
- Before enabling the caller workflow, verify package-manager compatibility: this repository currently uses npm scripts while the shared pipeline currently invokes `pnpm exec wrangler` internally.
- Production deployment must not be claimed ready until the caller workflow, version input, build/check command, target URLs, and Cloudflare bootstrap credentials have been validated.

This decision is specified in `openspec/changes/use-centralized-cf-worker-ci/` and `docs/cicd.md`.

## HTTP API contract strategy

The HTTP surface is specified with **OpenAPI 3.2.0** in repository-root `openapi.yaml` and is intended to be rendered/inspected with Swagger-compatible tooling.

- `openapi.yaml` is the canonical HTTP API description for routes, methods, authentication requirements, status codes, content types, and stable payloads owned by `anas-mcp`.
- Any HTTP surface change SHALL update `openapi.yaml` in the same change.
- OpenAPI documents `/mcp` as an MCP Streamable HTTP transport endpoint; it SHALL NOT model each MCP tool as a fake REST endpoint.
- MCP tool input/output contracts remain authoritative in MCP SDK/Zod schemas and are discovered through the MCP protocol.
- CI SHALL validate `openapi.yaml` with an OpenAPI 3.2-capable validator before deployment once the project validation tool is selected.
- Swagger/OpenAPI examples SHALL NOT include production credentials, Access assertions, provider tokens, database secrets, or private analytics payloads.
- Runtime Swagger UI serving is optional and requires an explicit decision on route and Access protection before implementation.

This decision is specified in `openspec/changes/adopt-openapi-http-contract/` and `docs/api.md`.

## Data-source strategy

### Google Analytics 4
- Source: Google Analytics Data API.
- Access pattern: direct API query at MCP request time.
- Rationale: preserve GA4 dimension/metric flexibility and avoid prematurely materializing aggregates.

### Google Search Console
- Source: Search Console API.
- Access pattern: direct API query at MCP request time.
- Rationale: expose query/page SEO analysis without making Windmill a mandatory hop.

### Microsoft Clarity
- Source: PostgreSQL schema `blog_analytics`, populated by `firstsun-dev/windmill-flows`.
- Access pattern: read-only SQL through Cloudflare Hyperdrive.
- Rationale: Clarity Data Export API has restrictive daily request/window/row limits, so ingestion and query-serving are intentionally separated.

## Credential strategy

`anas-mcp` follows a **Secrets Store first** credential policy. See `docs/credentials.md` for the complete rules and exceptions.

- Any long-lived secret consumed directly by the Worker MUST come from Cloudflare Secrets Store whenever supported.
- Google OAuth credential is one JSON document stored in Cloudflare Secrets Store.
- Future API tokens, OAuth client secrets, signing keys, or encryption keys consumed directly by `anas-mcp` also belong in Secrets Store by default.
- Production secrets MUST NOT use Wrangler `vars`, committed configuration, `.env`, `.dev.vars`, source code, or logs.
- `wrangler secret` is not the preferred production store; using it when Secrets Store is available requires an accepted OpenSpec exception.
- Runtime Google access tokens are derived from the stored OAuth credential and remain runtime-only; they are not persisted.
- Cloudflare Access Managed OAuth credentials/tokens are platform-managed and are not duplicated into `anas-mcp` Secrets Store.
- Clarity API token remains owned by the Windmill ingestion project and is not copied into `anas-mcp`.
- Database credentials are owned by Hyperdrive and MUST NOT be duplicated into Secrets Store or Worker configuration; the database role must be read-only.
- CI/deployment bootstrap credentials may live in the CI provider's protected secret store only when they are required before Cloudflare Secrets Store can be accessed; for this project, deployment must flow through the reusable workflow in `firstsun-dev/.github`.
- Non-sensitive identifiers such as GA4 property ID and Search Console site URL may use Wrangler `vars`.

## Runtime architecture

```text
ChatGPT / MCP client
        |
        | OAuth / PKCE
        v
Cloudflare Access (Managed OAuth + policy)
        |
        | authenticated request
        v
Cloudflare Worker: anas-mcp
        |
        +--> GA4 Data API
        |
        +--> Search Console API
        |
        +--> Hyperdrive --> PostgreSQL --> blog_analytics Clarity data
```

Deployment path:

```text
GitHub event in anas-mcp
        |
        v
thin caller workflow
        |
        v
firstsun-dev/.github reusable Cloudflare Worker pipeline
        |
        v
Cloudflare Worker deployment
```

Contract path:

```text
HTTP routes/auth/media types
        -> openapi.yaml (OpenAPI 3.2 / Swagger)

MCP tool contracts
        -> MCP SDK / Zod schemas
```

## Non-goals for the initial system
- No write operations against analytics providers.
- No direct Microsoft Clarity API access.
- No generic SQL tool.
- No event-level GA4 warehouse or BigQuery integration yet.
- No cross-source persisted warehouse yet.
- No user-facing dashboard.
- No custom MCP account/password database.
- No Worker-managed OAuth token database when Cloudflare Access Managed OAuth provides the client authentication boundary.
- No independent local Cloudflare deployment implementation that duplicates the organization reusable workflow.
- No fake REST endpoint per MCP tool solely for Swagger documentation.

## Tool design principles
- Prefer a small number of composable tools over many near-duplicate endpoint wrappers.
- Validate dimensions, metrics, date ranges, row limits, and filters before upstream calls.
- Return machine-readable structured content plus concise text summaries where useful.
- Bound result sizes to keep MCP responses predictable.
- Treat analytics data as potentially sensitive operational data; do not log row-level payloads by default.
- All production MCP tool invocations must arrive through the Cloudflare Access authorization boundary.

## Initial capability roadmap
1. MCP foundation and health endpoint.
2. OpenAPI 3.2 HTTP contract and automated validation.
3. Cloudflare Access Managed OAuth protection for production `/mcp`.
4. Centralized Cloudflare Worker CI/CD caller using `firstsun-dev/.github`.
5. Cloudflare Secrets Store binding and Google OAuth credential loading/access-token exchange.
6. GA4 generic report, realtime, and metadata tools.
7. Search Console analytics, URL inspection, and site-list tools.
8. Hyperdrive-backed Clarity overview/page tools.
9. Cross-source analytical workflows only after repeated usage patterns justify dedicated tools.
