# Design: Google Search Console MCP tools

## Flow
ChatGPT / agent -> Cloudflare Access (assertion validated first) -> Worker -> shared `GoogleTokenProvider` -> `https://www.googleapis.com/webmasters/v3/...`.

## Decisions
- **Allowlist first.** `GSC_ALLOWED_SITES` is a JSON array of exact identifiers (`https://host/path/` URL-prefix or `sc-domain:example.com`). Any malformed entry, non-array, or empty list disables GSC (fail closed). Order per request: configuration -> input validation -> exact allowlist membership -> access token -> Google. A URL-prefix property is never widened to a domain.
- **Fixed endpoint.** Base URL is a constant; `siteUrl` is `encodeURIComponent`-encoded as a single path segment.
- **Constrained request.** Body is built only from validated fields: `startDate`, `endDate`, `dimensions`, `type`, `dataState`, `rowLimit`, `startRow`, `aggregationType: "auto"`, and at most one `dimensionFilterGroups` entry (`groupType: "and"`) with `page`/`query` filters using only `contains` or `equals`. No regex, no raw JSON.
- **Dates in `America/Los_Angeles`.** Default = previous 28 completed Pacific calendar days (end = Pacific yesterday). Computed with `Intl.DateTimeFormat` so DST transitions are handled by the runtime tz database; calendar arithmetic is done on day numbers, never on 24 h offsets. Explicit dates are validated as real calendar dates, both-or-none, <= 366 days.
- **Dimensions.** `query|page|date|country|device`, 1-3, no duplicates. `discover`/`googleNews` do not support the `query` dimension or a query filter (rejected locally).
- **Pagination is advisory.** Google offers no total row count; `hasMorePossible = returned rows == limit`. Equal-click rows may reorder between requests, so offset paging can skip or repeat rows.
- **Values untouched.** `ctr` is a ratio; `position` is Google's average; absent metrics are `null`, never `0`; no totals are computed.
- **Errors.** `GscError` with fixed messages; Google bodies are parsed only for machine-readable `reason`/`status` and never forwarded. 401 -> one forced token refresh. Retry at most twice for 5xx/timeouts/network and short (<= 5 s) `Retry-After`. 2 MiB response cap.
- **Logging.** Only `{event, operation, attempt, status, outcome, durationMs}`. No site URL, query, token, or body.
- **Health.** `search-console` in `enabledSources` iff binding AND valid allowlist; configuration readiness only, never a Google call.
