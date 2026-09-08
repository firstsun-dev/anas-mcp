# Proposal: bootstrap analytics MCP

## Why
Firstsun needs one MCP endpoint that ChatGPT can use to analyze GA4, Search Console, and Microsoft Clarity without duplicating the ingestion responsibilities already owned by Windmill.

## What changes
- Establish a stateless Cloudflare Workers MCP service.
- Define Google OAuth credential handling through Cloudflare Secrets Store.
- Add GA4 and Search Console as direct API-backed data sources.
- Add Microsoft Clarity as a PostgreSQL-backed data source through Hyperdrive.
- Keep the service read-only and forbid arbitrary SQL tools.
- Add explicit verification and project-agent instructions.

## Scope
### In scope
- MCP transport and health surface.
- Data-source contracts and credential boundaries.
- Initial tool contracts for GA4, GSC, and Clarity.
- Deployment configuration model for Cloudflare Workers.

### Out of scope
- BigQuery export or event-level GA4 warehouse.
- Direct Clarity API calls.
- Analytics writes or provider configuration changes.
- Persisted cross-source materialized views outside the existing Clarity PostgreSQL model.
- Production MCP OAuth implementation in the bootstrap commit.

## Success criteria
- Repository has a runnable Cloudflare Worker MCP skeleton.
- Architecture and security boundaries are documented.
- Follow-up implementation tasks are independently reviewable.
- No real credentials or infrastructure IDs are committed.
