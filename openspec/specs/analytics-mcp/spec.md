# Analytics MCP capability

## Requirements

### Requirement: Remote MCP transport
The service SHALL expose a stateless MCP endpoint at `/mcp` on Cloudflare Workers using Streamable HTTP.

#### Scenario: MCP client connects
- GIVEN the Worker is deployed
- WHEN an MCP-compatible client connects to `/mcp`
- THEN the client can complete MCP initialization and list available tools

### Requirement: Read-only analytics access
The service SHALL expose analytics data only through read-only operations.

#### Scenario: Client requests analytics
- WHEN a client invokes an analytics tool
- THEN the service may read from GA4, Search Console, or the Clarity PostgreSQL read model
- AND it SHALL NOT mutate provider or database data

### Requirement: Google direct API access
The service SHALL query GA4 and Search Console directly through their Google APIs rather than requiring a local persisted analytics warehouse.

#### Scenario: GA4 report request
- WHEN a client requests a valid GA4 report
- THEN the service validates the requested dimensions, metrics, filters, date range, and limit
- AND queries the Google Analytics Data API

#### Scenario: Search Console request
- WHEN a client requests valid Search Console analytics
- THEN the service validates the request and queries the Search Console API

### Requirement: Clarity from PostgreSQL
The service SHALL read Microsoft Clarity analytics from PostgreSQL data ingested by `firstsun-dev/windmill-flows` and SHALL NOT call the Microsoft Clarity API.

#### Scenario: Clarity page analytics
- WHEN a client requests Clarity metrics for a page
- THEN the service reads the normalized `blog_analytics` data through a read-only PostgreSQL connection
- AND no Clarity API quota is consumed

### Requirement: Secrets Store first
Every long-lived secret consumed directly by the `anas-mcp` Worker SHALL be sourced from Cloudflare Secrets Store whenever Cloudflare supports that secret type.

#### Scenario: Worker needs a long-lived provider credential
- WHEN the Worker needs an OAuth credential, API token, signing secret, encryption secret, or comparable long-lived secret
- AND Cloudflare Secrets Store supports storing and binding it
- THEN the production source of truth SHALL be Cloudflare Secrets Store
- AND the secret SHALL NOT be stored in Wrangler `vars`, committed configuration, `.env`, `.dev.vars`, or source code

#### Scenario: Secrets Store is not usable for a required production secret
- GIVEN a long-lived secret cannot be sourced from Cloudflare Secrets Store because of a documented platform limitation or bootstrap dependency
- WHEN an alternative secret store is required
- THEN the exception SHALL be documented in an accepted OpenSpec change
- AND the alternative SHALL use least privilege and protected secret storage

### Requirement: Google credential isolation
Google OAuth credentials SHALL be stored as one JSON credential in Cloudflare Secrets Store and SHALL NOT be committed to source control or emitted in logs.

#### Scenario: Worker needs a Google access token
- WHEN a Google API tool is invoked
- THEN the Worker retrieves the bound OAuth JSON credential from Secrets Store
- AND derives a short-lived Google access token
- AND never returns credential material to the MCP client
- AND does not persist the derived access token

### Requirement: Service-managed credential exceptions
Credentials owned by platform integrations or other services SHALL remain with their owning service rather than being duplicated into `anas-mcp` Secrets Store.

#### Scenario: Worker accesses PostgreSQL
- WHEN the Worker accesses PostgreSQL through Hyperdrive
- THEN the database credential remains managed by the Hyperdrive connection
- AND the Worker SHALL NOT duplicate the database password into Secrets Store or Worker configuration

#### Scenario: Clarity ingestion authenticates upstream
- WHEN Microsoft Clarity API access is required for ingestion
- THEN `firstsun-dev/windmill-flows` remains the credential owner
- AND `anas-mcp` SHALL NOT receive or copy the Clarity API token

### Requirement: Constrained database tools
The service SHALL NOT provide clients with arbitrary SQL execution.

#### Scenario: Client requests Clarity data
- WHEN a Clarity MCP tool is invoked
- THEN only parameterized, predefined query paths are used
- AND SQL text is not accepted as a tool argument

### Requirement: Bounded responses
Analytics tools SHALL enforce bounded request and response sizes.

#### Scenario: Excessive requested rows
- WHEN a client requests more than the configured safe limit
- THEN the service clamps or rejects the request with a clear validation error
