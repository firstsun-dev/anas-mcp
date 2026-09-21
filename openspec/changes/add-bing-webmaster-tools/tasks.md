# Tasks: Bing Webmaster Tools provider

## OpenSpec and architecture
- [x] Add the Bing Webmaster provider proposal and design.
- [x] Add baseline analytics MCP requirements for Bing read access.
- [x] Record OAuth `Webmaster.read` as the least-privilege initial scope.
- [x] Record REST/JSON-only integration and prohibit legacy SOAP/POX.
- [x] Record write operations as out of scope for the initial provider.

## Credential provisioning
- [ ] Register/select the production Bing Webmaster OAuth client.
- [ ] Complete the authorization flow with `Webmaster.read`.
- [ ] Store the structured Bing OAuth credential in Cloudflare Secrets Store.
- [ ] Add the production Secrets Store binding without committing real IDs or credential values.
- [ ] Verify staging and production credentials can be rotated independently.

## Provider services
- [ ] Implement `services/bing-auth.ts` with structured credential validation and access-token refresh.
- [ ] Implement `services/bing-webmaster.ts` using the Microsoft-supported REST/JSON API surface current at implementation time.
- [ ] Confirm no SOAP or POX endpoint is used.
- [ ] Add provider error normalization and secret redaction.

## MCP tools
- [ ] Implement `bing_list_sites`.
- [ ] Implement `bing_search_performance`.
- [ ] Implement `bing_url_info`.
- [ ] Add bounded inputs/outputs and URL/site validation.
- [ ] Ensure site-list responses do not expose verification/authentication codes returned by upstream APIs.

## Tests
- [ ] Add malformed-credential and OAuth refresh failure tests.
- [ ] Add request validation and result-bound tests.
- [ ] Add provider error-mapping tests.
- [ ] Add tests proving write operations are not exposed.
- [ ] Add tests proving SOAP/POX endpoints are not referenced by the provider implementation.

## Verification
- [ ] Run the aggregate project check.
- [ ] Validate the tools locally with MCP Inspector.
- [ ] Verify the configured credential requires only `Webmaster.read`.
- [ ] Verify representative Bing site/search/URL reads against a real authorized site without logging private analytics payloads.
- [ ] Verify production access still passes through Cloudflare Access Managed OAuth.

## Verification evidence
OpenSpec design added on 2026-09-21. Microsoft documentation was checked while defining this change: OAuth 2.0 is the recommended access method, `Webmaster.read` is documented as read-only access, and legacy SOAP/POX retirement is dated 2026-08-31. Runtime/provider implementation remains pending and must not be marked complete until tested.
