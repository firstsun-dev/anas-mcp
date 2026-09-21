# Proposal: add Bing Webmaster Tools

## Why
Firstsun needs Bing search and index visibility alongside GA4 and Google Search Console so ChatGPT can compare search performance across providers without introducing another ingestion pipeline. The provider must remain consistent with the existing read-only MCP, Secrets Store first, and bounded-tool design.

The initial Firstsun deployment uses a long-lived Bing Webmaster provider token/API key owned by Firstsun and stored in Cloudflare Secrets Store. Because `anas-mcp` is a single-owner, server-side, read-only integration, delegated per-user Bing OAuth is not required for the initial provider. The integration still targets the supported REST/JSON interface and does not use legacy SOAP/POX protocols.

## What changes
- Add Bing Webmaster Tools as a direct request-time analytics provider.
- Use a Bing Webmaster provider token/API key for the initial server-side integration.
- Store the Bing provider token in Cloudflare Secrets Store as the sole production source of truth.
- Keep the MCP tool surface read-only even if the upstream credential is technically capable of additional operations.
- Define read-only MCP tools for site discovery, search performance, and URL information.
- Explicitly prohibit Bing write operations in the initial integration.
- Explicitly prohibit legacy SOAP/POX implementations.

## Scope
### In scope
- Provider authentication and credential ownership.
- Direct Bing Webmaster API reads.
- Bounded site/search-performance/URL-information tool contracts.
- Validation, provider error mapping, and secret-safe telemetry.

### Out of scope
- URL submission.
- Sitemap submission or mutation.
- Site ownership/configuration mutation.
- Delegated per-user Bing OAuth for the initial deployment.
- Provider write operations regardless of the technical capabilities of the configured token.
- Legacy SOAP or POX integrations.
- Persisting Bing analytics into PostgreSQL or another warehouse.

## Success criteria
- Bing provider remains read-only end to end.
- The Bing provider token is sourced from Cloudflare Secrets Store and never logged or returned.
- No OAuth authorization-code or refresh-token state is required for the initial Bing integration.
- MCP responses are bounded and predictable.
- No legacy SOAP/POX dependency is introduced.
- Implementation can be independently reviewed after this OpenSpec change is accepted.
