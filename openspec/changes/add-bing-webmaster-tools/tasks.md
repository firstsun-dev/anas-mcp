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
- [x] Add the production Secrets Store binding without committing real IDs or credential values. (Binding uses the shared 首陽 `default_secrets_store` ID, a non-secret identifier; the secret itself is not yet created.)
- [ ] Verify the Worker can read the token at runtime without exposing it to logs or tool responses.
- [ ] Verify staging and production credentials can be rotated independently.

## Provider services
- [x] Implement `services/bing-webmaster.ts` with Secrets Store token loading and the Microsoft-supported REST/JSON API surface current at implementation time.
- [x] Confirm no SOAP or POX endpoint is used.
- [x] Add provider error normalization and secret redaction.

## MCP tools
- [x] Implement `bing_list_sites`.
- [x] Implement `bing_search_performance`.
- [x] Implement `bing_url_info`.
- [x] Add bounded inputs/outputs and URL/site validation.
- [x] Ensure site-list responses do not expose verification/authentication codes returned by upstream APIs.

## Tests
- [x] Add missing/empty-token and upstream authentication failure tests.
- [x] Add request validation (including real calendar-date and target-URL userinfo checks) and result-bound tests.
- [x] Add provider error-mapping tests.
- [x] Add tests proving write operations are not exposed.
- [x] Add tests proving SOAP/POX endpoints are not referenced by the provider implementation.

## Verification
- [x] Run the aggregate project check.
- [x] Confirm `wrangler.jsonc` explicitly disables outbound fetch tracing and passes `wrangler deploy --dry-run`.
- [x] Validate the tools locally with MCP Inspector.
- [ ] Verify the Bing provider token is read only from Cloudflare Secrets Store and is never returned or logged.
- [ ] Verify representative Bing site/search/URL reads against a real authorized site without logging private analytics payloads.
- [ ] Verify production access still passes through Cloudflare Access Managed OAuth.

## Verification evidence
OpenSpec design added on 2026-09-21 and updated the same day to use a Cloudflare Secrets Store-backed Bing provider token/API key for the initial Firstsun server-side deployment. The MCP provider remains read-only and legacy SOAP/POX integration remains prohibited. Runtime/provider implementation remains pending and must not be marked complete until tested.

### Implementation evidence (2026-09-21)
- Bing REST/JSON contract verified from Microsoft Learn; recorded in `design.md`. Token/API-key model confirmed; no OpenSpec architecture change required.
- `npm run check` (typecheck + vitest, 82 tests using mocked `fetch`) passes.
- `wrangler deploy --dry-run` accepts `wrangler.jsonc` including `observability.traces.enabled: false` and the Secrets Store binding syntax.
- `npm run dev` + MCP Inspector (`@modelcontextprotocol/inspector --cli`, streamable HTTP): `tools/list` shows `health`, `bing_list_sites`, `bing_search_performance`, `bing_url_info`. `bing_list_sites` without a bound secret returned only `missing_configuration` (no stack trace, token or raw binding error); `startDate=2026-02-30` is rejected by input validation.
- `store_id` in `wrangler.jsonc` is the shared 首陽 `default_secrets_store` (`a2a4a60a…`, supplied by the operator, used by dev and main). `ANAS_PROD_BING_WEBMASTER_TOKEN` does not exist in that store yet (checked via `wrangler secrets-store secret list`).
- NOT verified: real Secrets Store secret, real Bing API calls (no credential available; `GetUrlInfo` quoting and `GetPageStats` `Query` semantics remain unconfirmed), secret rotation, production Access.
