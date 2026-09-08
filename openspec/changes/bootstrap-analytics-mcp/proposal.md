# Proposal: bootstrap analytics MCP

## Why
Firstsun needs one MCP endpoint that ChatGPT can use to analyze GA4, Search Console, and Microsoft Clarity without duplicating the ingestion responsibilities already owned by Windmill. The service also needs a consistent credential model so long-lived application secrets do not drift across Worker secrets, config files, CI variables, and source code.

## What changes
- Establish a stateless Cloudflare Workers MCP service.
- Adopt a **Secrets Store first** policy for every long-lived secret consumed directly by `anas-mcp` whenever Cloudflare supports the secret type.
- Define Google OAuth credential handling through Cloudflare Secrets Store as one JSON credential.
- Keep platform-owned credentials with their owning integration instead of duplicating them: PostgreSQL password in Hyperdrive, Clarity API token in `firstsun-dev/windmill-flows`.
- Keep derived short-lived provider access tokens runtime-only.
- Add GA4 and Search Console as direct API-backed data sources.
- Add Microsoft Clarity as a PostgreSQL-backed data source through Hyperdrive.
- Keep the service read-only and forbid arbitrary SQL tools.
- Add explicit verification and project-agent instructions.

## Scope
### In scope
- MCP transport and health surface.
- Data-source contracts and credential boundaries.
- Secrets Store first policy plus documented exception rules.
- Initial tool contracts for GA4, GSC, and Clarity.
- Deployment configuration model for Cloudflare Workers.

### Out of scope
- BigQuery export or event-level GA4 warehouse.
- Direct Clarity API calls.
- Analytics writes or provider configuration changes.
- Persisted cross-source materialized views outside the existing Clarity PostgreSQL model.
- Production MCP OAuth implementation in the bootstrap commit.
- Duplicating Hyperdrive or Windmill-owned credentials into `anas-mcp` Secrets Store.

## Success criteria
- Repository has a runnable Cloudflare Worker MCP skeleton.
- Architecture, security boundaries, and credential ownership are documented.
- Long-lived Worker-consumed production secrets default to Cloudflare Secrets Store.
- Any exception to Secrets Store requires explicit documented justification.
- Follow-up implementation tasks are independently reviewable.
- No real credentials or infrastructure IDs are committed.
