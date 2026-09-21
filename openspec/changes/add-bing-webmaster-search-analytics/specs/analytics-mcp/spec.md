# Analytics MCP delta: Bing Webmaster and unified search analytics

## ADDED Requirements

### Requirement: Provider-neutral search analytics tools
The service SHALL expose bounded MCP tools for common search-performance intents using a provider selector rather than duplicating the primary public tool surface for Google Search Console and Bing Webmaster.

#### Scenario: Client selects a search provider
- GIVEN the client invokes a unified search analytics tool
- WHEN `provider` is `gsc` or `bing`
- THEN the service routes the request through the corresponding provider adapter
- AND returns the same normalized response envelope for equivalent search-performance intents

#### Scenario: Provider-specific capability has no clean equivalent
- WHEN a provider exposes a capability without a semantically equivalent operation in the other provider
- THEN the service MAY expose a provider-specific MCP tool
- AND SHALL NOT force the capability into the unified surface with misleading semantics

### Requirement: Unified search analytics operations
The service SHALL provide provider-neutral MCP operations for listing sites, site overview, top queries, top pages, page-to-query drilldown, and query-to-page drilldown.

#### Scenario: Client requests common search analytics
- WHEN the client invokes `search_list_sites`, `search_overview`, `search_queries`, `search_pages`, `search_page_queries`, or `search_query_pages`
- THEN the service validates bounded inputs before any upstream call
- AND maps the request to the selected provider
- AND returns normalized metrics plus provider and freshness metadata

### Requirement: Bing Webmaster read-only access
The service SHALL integrate Bing Webmaster Tools through its supported HTTPS JSON API using read-only OAuth authorization.

#### Scenario: Bing search analytics is requested
- GIVEN the selected provider is `bing`
- WHEN a supported search analytics tool is invoked
- THEN the service uses the Bing Webmaster JSON API
- AND uses OAuth authorization limited to the read-only `webmaster.read` scope
- AND SHALL NOT invoke write-capable Bing Webmaster operations

#### Scenario: Legacy Bing transport is considered
- WHEN an implementation path proposes SOAP or POX
- THEN it SHALL be rejected
- AND the supported JSON/HTTP transport SHALL be used instead

### Requirement: Bing credential isolation
Long-lived Bing Webmaster OAuth credential material consumed by the Worker SHALL follow the project's Secrets Store first policy.

#### Scenario: Worker needs a Bing access token
- WHEN a Bing-backed MCP tool is invoked
- THEN the Worker loads the Bing OAuth credential JSON from Cloudflare Secrets Store
- AND exchanges the refresh token for a short-lived access token
- AND keeps the derived token runtime-only
- AND SHALL NOT log or return the client secret, refresh token, or access token

### Requirement: Normalized search performance metrics
The unified search analytics layer SHALL normalize common provider metrics without claiming that provider-native ranking measurements are identical.

#### Scenario: Equivalent metrics are returned
- WHEN GSC or Bing returns clicks, impressions, CTR, query, page, date, or position data
- THEN the service maps them into the common response model where semantics are sufficiently aligned
- AND derives CTR as total clicks divided by total impressions when required
- AND uses weighted aggregation for position metrics when aggregating dated rows

#### Scenario: Provider-native position metrics differ
- WHEN the response includes Google average position or Bing average impression/click position
- THEN the service preserves the provider provenance and semantics
- AND SHALL NOT claim that those measurements are directly interchangeable ranking metrics

### Requirement: Search data freshness transparency
Unified search responses SHALL expose provider freshness and effective-range metadata so clients do not interpret unavailable or incomplete dates as zero traffic.

#### Scenario: Requested dates exceed provider-available data
- WHEN the provider cannot supply the full requested range
- THEN the response exposes the effective range and available data-through date when known
- AND marks completeness as partial or unknown as appropriate
- AND SHALL NOT fabricate zero-valued rows for unavailable dates

### Requirement: Bing Webmaster API surface is constrained
The Bing adapter SHALL expose only explicitly supported read-only operations required by the accepted MCP tool contracts.

#### Scenario: Initial Bing implementation is built
- WHEN the Bing provider client is implemented
- THEN it MAY call `GetUserSites`, `GetRankAndTrafficStats`, `GetQueryStats`, `GetPageStats`, `GetPageQueryStats`, and `GetQueryPageStats`
- AND SHALL NOT expose arbitrary upstream method names or a generic Bing API passthrough to MCP clients

### Requirement: Search analytics responses are bounded
Unified search analytics tools SHALL enforce safe date-range and row limits before provider calls or local aggregation.

#### Scenario: Client requests excessive data
- WHEN the requested date range or result limit exceeds configured safe bounds
- THEN the service rejects or clamps the request according to the tool contract
- AND reports truncation when provider or service limits reduce the result set
