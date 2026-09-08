# anas-mcp project

## Mission
Provide ChatGPT and other MCP clients with safe, read-only access to Firstsun analytics through one Cloudflare-hosted Remote MCP service.

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
- Clarity API token remains owned by the Windmill ingestion project and is not copied into `anas-mcp`.
- Database credentials are owned by Hyperdrive and MUST NOT be duplicated into Secrets Store or Worker configuration; the database role must be read-only.
- CI/deployment bootstrap credentials may live in the CI provider's protected secret store only when they are required before Cloudflare Secrets Store can be accessed; prefer workload identity/OIDC where supported.
- Non-sensitive identifiers such as GA4 property ID and Search Console site URL may use Wrangler `vars`.

## Runtime architecture

```text
ChatGPT / MCP client
        |
        | Streamable HTTP
        v
Cloudflare Worker: anas-mcp
        |
        +--> GA4 Data API
        |
        +--> Search Console API
        |
        +--> Hyperdrive --> PostgreSQL --> blog_analytics Clarity data
```

## Non-goals for the initial system
- No write operations against analytics providers.
- No direct Microsoft Clarity API access.
- No generic SQL tool.
- No event-level GA4 warehouse or BigQuery integration yet.
- No cross-source persisted warehouse yet.
- No user-facing dashboard.

## Tool design principles
- Prefer a small number of composable tools over many near-duplicate endpoint wrappers.
- Validate dimensions, metrics, date ranges, row limits, and filters before upstream calls.
- Return machine-readable structured content plus concise text summaries where useful.
- Bound result sizes to keep MCP responses predictable.
- Treat analytics data as potentially sensitive operational data; do not log row-level payloads by default.

## Initial capability roadmap
1. MCP foundation and health endpoint.
2. Cloudflare Secrets Store binding and Google OAuth credential loading/access-token exchange.
3. GA4 generic report, realtime, and metadata tools.
4. Search Console analytics, URL inspection, and site-list tools.
5. Hyperdrive-backed Clarity overview/page tools.
6. MCP authentication/authorization for production, with any application-held secrets sourced from Secrets Store.
7. Cross-source analytical workflows only after repeated usage patterns justify dedicated tools.
