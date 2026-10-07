# anas-mcp project

## Mission
Provide ChatGPT and other MCP clients with safe, read-only access to Firstsun analytics through one Cloudflare-hosted Remote MCP service.

## Authentication strategy

Production `/mcp` supports **two Cloudflare Access authentication modes simultaneously on the same endpoint and Access application**. This is not a feature flag, fallback rollout, or environment-specific switch.

### Mode A — interactive Managed OAuth
- ChatGPT and other OAuth-capable MCP clients authenticate through Cloudflare Access Managed OAuth.
- Access performs OAuth discovery, authorization-code flow with PKCE, identity-provider login, and identity-policy evaluation.
- This mode preserves human identity, per-user revocation, and audit attribution.

### Mode B — machine/agent Service Token
- Headless agents, automation, CI, and AI tools that cannot complete an interactive browser OAuth flow authenticate with a Cloudflare Access Service Token.
- Preferred request headers are `CF-Access-Client-Id` and `CF-Access-Client-Secret`.
- A dedicated non-`Authorization` single-header Service Token configuration MAY be enabled for a client that supports only one custom header.
- Service Token authorization SHALL use an Access `Service Auth` policy.

Both modes are enabled concurrently. Cloudflare Access selects the applicable authentication/policy path from the incoming request. Neither mode disables the other.

After either mode succeeds, the Worker SHALL validate the Access application JWT in `Cf-Access-Jwt-Assertion` before MCP initialization/tool execution. The Worker SHALL NOT maintain a second production API-key/user/session database.

Do not use the transitional Worker-local `ANAS_MCP_API_KEY` gate as a production authentication path after this architecture is implemented. Do not use query-string secrets, OpenAI IP allowlists, User-Agent matching, or Cloudflare account/deployment API tokens for MCP authentication.

`/health` MAY remain unauthenticated when Access protection is scoped specifically to `/mcp`; it must expose readiness only.

The active decision is `openspec/changes/support-dual-access-auth/`. The earlier `add-cloudflare-access-auth` and `use-mcp-api-key-auth` changes are retained as superseded historical decisions.

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
- Swagger/OpenAPI examples SHALL NOT include OAuth access tokens, Access JWT assertions, Service Token credentials, provider tokens, database secrets, or private analytics payloads.
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
- Cloudflare Access OAuth tokens, Access assertions, and Service Token credentials are Access-managed/client-held authentication material and SHALL NOT be duplicated into the Worker's Secrets Store.
- Bing Webmaster and Clarity upstream credentials remain owned by the Windmill ingestion project and are not copied into `anas-mcp`.
- Database credentials are owned by Hyperdrive and MUST NOT be duplicated into Secrets Store or Worker configuration; the database role must be read-only.
- CI/deployment bootstrap credentials may live in the CI provider's protected secret store only when they are required before Cloudflare Secrets Store can be accessed; for this project, deployment must flow through the reusable workflow in `firstsun-dev/.github`.
- Non-sensitive identifiers such as GA4 property ID and Search Console site URL may use Wrangler `vars`.

## Runtime architecture

```text
Interactive OAuth client              Headless agent / automation
        |                                         |
        | Managed OAuth + PKCE                    | Access Service Token
        +-------------------+---------------------+
                            |
                            v
                    Cloudflare Access
                            |
                            | Cf-Access-Jwt-Assertion
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
- No Worker-local API-key/user/session database for MCP authentication; Cloudflare Access owns both interactive and machine authentication.
- No independent local Cloudflare deployment implementation that duplicates the organization reusable workflow.
- No fake REST endpoint per MCP tool solely for Swagger documentation.

## Tool design principles
- Prefer a small number of composable tools over many near-duplicate endpoint wrappers.
- Validate dimensions, metrics, date ranges, row limits, and filters before upstream calls.
- Return machine-readable structured content plus concise text summaries where useful.
- Bound result sizes to keep MCP responses predictable.
- Treat analytics data as potentially sensitive operational data; do not log row-level payloads by default.
- All production MCP tool invocations must pass Cloudflare Access and Worker validation of `Cf-Access-Jwt-Assertion` before tool execution.

## Initial capability roadmap
1. MCP foundation and health endpoint.
2. OpenAPI 3.2 HTTP contract and automated validation.
3. Concurrent dual-mode Cloudflare Access protection for production `/mcp`: Managed OAuth for interactive clients plus Service Tokens for headless agents.
4. Centralized Cloudflare Worker CI/CD caller using `firstsun-dev/.github`.
5. Cloudflare Secrets Store binding and Google OAuth credential loading/access-token exchange.
6. GA4 generic report, realtime, and metadata tools.
7. Search Console analytics, URL inspection, and site-list tools.
8. Windmill-ingested, Hyperdrive-backed Bing Webmaster site-list and search-performance tools.
9. Hyperdrive-backed Clarity overview/page tools.
10. Cross-source analytical workflows only after repeated usage patterns justify dedicated tools.
