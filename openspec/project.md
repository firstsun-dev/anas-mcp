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
- Google credential is one OAuth JSON document stored in Cloudflare Secrets Store.
- Runtime Google access tokens are derived from the stored OAuth credential and must not be persisted in Git.
- Clarity API token remains owned by the Windmill ingestion project and is not available to `anas-mcp`.
- Database credentials are managed through Hyperdrive; the database role must be read-only.

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
2. Google OAuth credential loading and access-token exchange.
3. GA4 generic report, realtime, and metadata tools.
4. Search Console analytics, URL inspection, and site-list tools.
5. Hyperdrive-backed Clarity overview/page tools.
6. MCP authentication/authorization for production.
7. Cross-source analytical workflows only after repeated usage patterns justify dedicated tools.
