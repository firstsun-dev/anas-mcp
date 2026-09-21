# Tasks: Bing Webmaster Tools provider

## OpenSpec and architecture
- [x] Add the Bing Webmaster provider proposal and design.
- [x] Add baseline analytics MCP requirements for Bing read access.
- [x] Record a Secrets Store-backed Bing provider token/API key as the initial server-side credential model.
- [x] Record REST/JSON-only integration and prohibit legacy SOAP/POX.
- [x] Record write operations as out of scope for the initial provider.

## Credential provisioning
- [ ] Create/select the production Bing Webmaster provider token/API key.
- [ ] Store the token in Cloudflare Secrets Store as the sole production source of truth.
- [ ] Add the production Secrets Store binding without committing real IDs or credential values.
- [ ] Verify the Worker can read the token at runtime without exposing it to logs or tool responses.
- [ ] Verify staging and production credentials can be rotated independently.

## Provider services
- [ ] Implement `services/bing-webmaster.ts` with Secrets Store token loading and the Microsoft-supported REST/JSON API surface current at implementation time.
- [ ] Confirm no SOAP or POX endpoint is used.
- [ ] Add provider error normalization and secret redaction.

## MCP tools
- [ ] Implement `bing_list_sites`.
- [ ] Implement `bing_search_performance`.
- [ ] Implement `bing_url_info`.
- [ ] Add bounded inputs/outputs and URL/site validation.
- [ ] Ensure site-list responses do not expose verification/authentication codes returned by upstream APIs.

## Tests
- [ ] Add missing/empty-token and upstream authentication failure tests.
- [ ] Add request validation and result-bound tests.
- [ ] Add provider error-mapping tests.
- [ ] Add tests proving write operations are not exposed.
- [ ] Add tests proving SOAP/POX endpoints are not referenced by the provider implementation.

## Verification
- [ ] Run the aggregate project check.
- [ ] Validate the tools locally with MCP Inspector.
- [ ] Verify the Bing provider token is read only from Cloudflare Secrets Store and is never returned or logged.
- [ ] Verify representative Bing site/search/URL reads against a real authorized site without logging private analytics payloads.
- [ ] Verify production access still passes through Cloudflare Access Managed OAuth.

## Verification evidence
OpenSpec design added on 2026-09-21 and updated the same day to use a Cloudflare Secrets Store-backed Bing provider token/API key for the initial Firstsun server-side deployment. The MCP provider remains read-only and legacy SOAP/POX integration remains prohibited. Runtime/provider implementation remains pending and must not be marked complete until tested.
