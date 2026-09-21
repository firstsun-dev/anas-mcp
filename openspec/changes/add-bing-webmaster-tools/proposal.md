# Proposal: add Bing Webmaster Tools

## Why
Firstsun needs Bing search and index visibility alongside GA4 and Google Search Console so ChatGPT can compare search performance across providers without introducing another ingestion pipeline. The provider must remain consistent with the existing read-only MCP, Secrets Store first, and bounded-tool design.

Microsoft currently recommends OAuth 2.0 for Bing Webmaster API access and exposes a read-only `Webmaster.read` scope. Microsoft also retired the legacy SOAP and POX APIs on 2026-08-31, so the integration must target the supported REST/JSON interface rather than legacy protocols.

## What changes
- Add Bing Webmaster Tools as a direct request-time analytics provider.
- Use OAuth 2.0 with least-privilege `Webmaster.read`.
- Store long-lived Bing OAuth credential material in Cloudflare Secrets Store.
- Keep derived Bing access tokens runtime-only.
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
- `Webmaster.manage`.
- API-key authentication as the default production design.
- Legacy SOAP or POX integrations.
- Persisting Bing analytics into PostgreSQL or another warehouse.

## Success criteria
- Bing provider remains read-only end to end.
- Only `Webmaster.read` is required for the initial provider.
- Long-lived credential material is sourced from Secrets Store and never logged.
- MCP responses are bounded and predictable.
- No legacy SOAP/POX dependency is introduced.
- Implementation can be independently reviewed after this OpenSpec change is accepted.
