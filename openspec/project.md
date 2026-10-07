# anas-mcp project

## Mission
Provide ChatGPT and other MCP clients with safe, read-only access to Firstsun analytics through one Cloudflare-hosted Remote MCP service.

## Authentication strategy

Production MCP access uses a **dedicated application bearer API key**.

- Every production `/mcp` request SHALL provide `Authorization: Bearer <token>`.
- The credential SHALL be a dedicated high-entropy secret for `anas-mcp`; it SHALL NOT be a Cloudflare API token, provider token, database password, or other credential reused from another system.
- The production secret SHALL be stored in Cloudflare Secrets Store under an application binding such as `ANAS_MCP_API_KEY`; it SHALL NOT be committed, placed in Wrangler `vars`, or logged.
- The Worker SHALL reject a missing or invalid bearer credential before MCP initialization or tool execution.
- The current model is service-level rather than per-user: possession of the dedicated key authorizes the caller to the existing read-only MCP surface.
- Do not authenticate clients by query-string secrets, OpenAI IP allowlists, User-Agent matching, or Cloudflare account/deployment tokens.
- The Worker remains stateless for MCP client authentication; no OAuth state, user database, KV, D1, Durable Object, or PostgreSQL auth table is required for the current model.
- `/health` MAY remain unauthenticated, but it must expose readiness only and no configuration, credential, or analytics state.
- OAuth or identity-aware authentication SHALL be reconsidered through a separate OpenSpec change if the service later needs multiple human users, per-user revocation/audit, delegated third-party access, or per-user/per-tool authorization.

This decision is specified in `openspec/changes/use-mcp-api-key-auth/`. The earlier `openspec/changes/add-cloudflare-access-auth/` decision is retained only as superseded historical rationale.

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

### Bing Webmaster Tools
- Upstream source: Bing Webmaster REST/JSON API, consumed by `firstsun-dev/windmill-flows`.
- Serving source: normalized PostgreSQL `blog_analytics` read model populated by Windmill.
- Access pattern: scheduled Windmill ingestion; `anas-mcp` reads PostgreSQL through read-only Cloudflare Hyperdrive.
- Authentication: the Bing provider token/API key is owned by the Windmill ingestion runtime, not by `anas-mcp`.
- Rationale: Bing search data does not require request-time freshness, and live Cloudflare Worker access observed `ErrorCode: 17 / ThrottleIP`; ingestion isolates provider throttling/latency from MCP availability.
- Guardrail: `anas-mcp` SHALL NOT call Bing directly. Initial MCP scope is site-list and search-performance reads; arbitrary URL-info lookup is deferred.

### Microsoft Clarity
- Source: PostgreSQL schema `blog_analytics`, populated by `firstsun-dev/windmill-flows`.
- Access pattern: read-only SQL through Cloudflare Hyperdrive.
- Rationale: Clarity Data Export API has restrictive daily request/window/row limits, so ingestion and query-serving are intentionally separated.

## Credential strategy

`anas-mcp` follows a **Secrets Store first** credential policy. See `docs/credentials.md` for the complete rules and exceptions.

- Any long-lived secret consumed directly by the Worker MUST come from Cloudflare Secrets Store whenever supported.
- GA4 and Google Search Console use one Google OAuth credential JSON stored in Cloudflare Secrets Store; derived Google access tokens remain runtime-only.
- Bing Webmaster credentials are owned by `firstsun-dev/windmill-flows` because Windmill consumes the upstream API; `anas-mcp` SHALL NOT duplicate the Bing token into Cloudflare Secrets Store.
- Future API tokens, OAuth client secrets, signing keys, or encryption keys consumed directly by `anas-mcp` also belong in Secrets Store by default.
- Production secrets MUST NOT use Wrangler `vars`, committed configuration, `.env`, `.dev.vars`, source code, or logs.
- `wrangler secret` is not the preferred production store; using it when Secrets Store is available requires an accepted OpenSpec exception.
- Runtime Google access tokens are derived from the stored OAuth credential and remain runtime-only; they are not persisted.
- The dedicated production MCP bearer API key is application-owned and SHALL be stored in Cloudflare Secrets Store; it SHALL NOT be reused as a Cloudflare account/deployment credential.
- Bing Webmaster and Clarity upstream credentials remain owned by the Windmill ingestion project and are not copied into `anas-mcp`.
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
        +--> Hyperdrive --> PostgreSQL
                              ^
                              |
                    +---------+---------+
                    |                   |
               Windmill Bing       Windmill Clarity
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
- All production MCP tool invocations must pass the dedicated bearer API-key gate before tool execution.

## Initial capability roadmap
1. MCP foundation and health endpoint.
2. OpenAPI 3.2 HTTP contract and automated validation.
3. Dedicated bearer API-key protection for production `/mcp`, with the key stored in Cloudflare Secrets Store.
4. Centralized Cloudflare Worker CI/CD caller using `firstsun-dev/.github`.
5. Cloudflare Secrets Store binding and Google OAuth credential loading/access-token exchange.
6. GA4 generic report, realtime, and metadata tools.
7. Search Console analytics, URL inspection, and site-list tools.
8. Windmill-ingested, Hyperdrive-backed Bing Webmaster site-list and search-performance tools.
9. Hyperdrive-backed Clarity overview/page tools.
10. Cross-source analytical workflows only after repeated usage patterns justify dedicated tools.
