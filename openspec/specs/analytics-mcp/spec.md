# Analytics MCP capability

## Requirements

### Requirement: Remote MCP transport
The service SHALL expose a stateless MCP endpoint at `/mcp` on Cloudflare Workers using Streamable HTTP.

#### Scenario: MCP client connects
- GIVEN the Worker is deployed
- WHEN an MCP-compatible client connects to `/mcp`
- THEN the client can complete MCP initialization and list available tools after satisfying the production authentication boundary

### Requirement: OpenAPI HTTP contract
The service SHALL maintain a repository-root `openapi.yaml` using OpenAPI 3.2.0 as the canonical description of the `anas-mcp` HTTP surface.

#### Scenario: HTTP route behavior changes
- WHEN a change adds, removes, or modifies an HTTP path, method, authentication requirement, status code, content type, or stable request/response payload owned by `anas-mcp`
- THEN `openapi.yaml` SHALL be updated in the same change
- AND implementation/tests SHALL conform to the updated contract

#### Scenario: Developer inspects the HTTP API
- WHEN a developer opens `openapi.yaml` in Swagger-compatible tooling supporting OpenAPI 3.2.0
- THEN the currently supported HTTP surface can be inspected without requiring source-code inspection
- AND the document SHALL NOT contain production credentials, bearer API keys, provider tokens, database secrets, or private analytics payloads

### Requirement: MCP/OpenAPI contract separation
OpenAPI SHALL describe the MCP HTTP transport but SHALL NOT replace the authoritative MCP tool schemas.

#### Scenario: MCP tool is added or modified
- WHEN a tool such as a GA4, Search Console, or Clarity tool is added or changed
- THEN its input/output schema SHALL remain defined through the MCP SDK/schema layer
- AND the tool SHALL NOT be represented as a fake REST endpoint solely for Swagger visibility
- AND OpenAPI requires an update only when the HTTP transport surface itself changes

#### Scenario: `/mcp` is described in OpenAPI
- WHEN the MCP endpoint is documented
- THEN OpenAPI SHALL describe its route, method, authentication boundary, supported HTTP media types, and safe HTTP status behavior
- AND the MCP protocol/installed SDK remains authoritative for the protocol-message envelope

### Requirement: OpenAPI validation
The project SHALL validate `openapi.yaml` with an OpenAPI 3.2-capable validator before production deployment once the validator is integrated into the project check path.

#### Scenario: CI validates the project
- WHEN the centralized CI/CD caller executes the project's aggregate verification command
- THEN OpenAPI validation SHALL run before deployment
- AND validation failure SHALL block deployment

### Requirement: Dedicated bearer API-key production authentication
Production access to `/mcp` SHALL require a dedicated application bearer credential supplied through the HTTP `Authorization` header.

#### Scenario: Unauthenticated MCP client connects
- WHEN a client requests `/mcp` without `Authorization: Bearer <token>`
- THEN the request SHALL be rejected before MCP initialization or tool execution
- AND the response SHALL NOT reveal the configured credential or secret-binding details

#### Scenario: Client presents an invalid bearer credential
- WHEN a client requests `/mcp` with an invalid bearer token
- THEN the request SHALL be rejected
- AND no MCP tool SHALL execute

#### Scenario: Authorized MCP client connects
- GIVEN the client is configured with the dedicated `anas-mcp` bearer credential
- WHEN it requests `/mcp` with the valid `Authorization: Bearer` value
- THEN the request MAY reach MCP initialization
- AND the client can invoke the existing read-only tool surface

### Requirement: MCP API-key isolation
The production MCP bearer credential SHALL be application-specific, high entropy, and stored in Cloudflare Secrets Store.

#### Scenario: Production MCP credential is provisioned
- WHEN production authentication is configured
- THEN the credential SHALL be stored through Cloudflare Secrets Store under an application binding such as `ANAS_MCP_API_KEY`
- AND it SHALL NOT be committed, stored in Wrangler `vars`, written to logs, or returned to MCP clients
- AND it SHALL NOT reuse `CLOUDFLARE_API_TOKEN`, a provider token, a database password, or another system credential

### Requirement: Stateless service-level authentication
The current MCP authentication model SHALL remain stateless and SHALL NOT introduce per-user identity infrastructure solely to protect the single-owner read-only service.

#### Scenario: Authentication state is evaluated
- WHEN a request is authenticated
- THEN possession of the valid dedicated bearer credential is sufficient for the current service-level authorization boundary
- AND the Worker SHALL NOT require OAuth state, KV, D1, Durable Objects, PostgreSQL auth tables, or an application user database for that decision

### Requirement: Identity-aware authentication is a future decision
OAuth or another identity-aware authentication layer SHALL require a separate accepted OpenSpec change before it replaces the bearer API-key boundary.

#### Scenario: Per-user authorization becomes necessary
- WHEN requirements include multiple independently authorized users, per-user revocation/audit, delegated third-party access, or per-user/per-tool policy
- THEN the project SHALL evaluate an identity-aware authentication mechanism
- AND SHALL NOT silently repurpose the current shared service credential as a user identity mechanism

### Requirement: Centralized Cloudflare Worker CI/CD
Production and development Worker deployment SHALL use the reusable Cloudflare Worker pipeline maintained in `firstsun-dev/.github` rather than a duplicated deployment implementation in `anas-mcp`.

#### Scenario: Repository adds a deployment workflow
- WHEN `anas-mcp` defines GitHub Actions CI/CD
- THEN the application workflow SHALL be a thin caller of `firstsun-dev/.github/.github/workflows/_cf-worker-template.yml` using an approved tag or pinned commit
- AND the caller MAY define application-specific triggers, inputs, test/build commands, target URLs, and inherited deployment secrets
- AND it SHALL NOT copy the reusable workflow's generic Wrangler deployment or rollback implementation

#### Scenario: Generic deployment behavior must change
- WHEN `anas-mcp` needs a change to generic Cloudflare Worker build/deploy/version/revert behavior
- THEN the change SHOULD be made in `firstsun-dev/.github` and consumed through the reusable workflow
- AND a local fork SHALL require an accepted OpenSpec exception explaining why the centralized workflow cannot support the requirement

#### Scenario: CI authenticates to Cloudflare
- WHEN the reusable workflow requires Cloudflare deployment credentials before Worker runtime bindings are available
- THEN the required least-privilege deployment credential MAY use the protected GitHub Actions secret/configuration mechanism expected by the shared workflow
- AND runtime credentials such as Google OAuth JSON, Bing Webmaster tokens, Clarity tokens, PostgreSQL passwords, or the MCP API key SHALL NOT be copied into CI solely for deployment

#### Scenario: Caller workflow is enabled
- GIVEN this repository currently uses npm scripts and the shared workflow currently invokes `pnpm exec wrangler` internally
- WHEN the CI caller is enabled
- THEN package-manager compatibility SHALL be verified first
- AND a mismatch SHALL be resolved by aligning the project or improving the centralized workflow rather than duplicating deploy steps locally

### Requirement: Read-only analytics access
The service SHALL expose analytics data only through read-only operations.

#### Scenario: Client requests analytics
- WHEN a client invokes an analytics tool
- THEN the service may read from GA4, Search Console, Bing Webmaster Tools, or the Clarity PostgreSQL read model
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


### Requirement: Bing Webmaster from PostgreSQL
The service SHALL serve Bing Webmaster analytics from a PostgreSQL read model populated by `firstsun-dev/windmill-flows` and SHALL NOT query Bing Webmaster directly from the MCP request path.

#### Scenario: Client requests Bing sites
- WHEN a client invokes the Bing site-list tool
- THEN the service reads the latest successful normalized Bing site dataset through a read-only Hyperdrive/PostgreSQL connection
- AND returns only safe bounded site fields
- AND does not call the Bing Webmaster API

#### Scenario: Client requests Bing search performance
- WHEN a client requests valid Bing query/page search-performance data
- THEN the service validates the site, requested date range, dimension, offset, and result bounds before SQL execution
- AND uses a predefined parameterized query against the normalized Bing read model
- AND returns a bounded MCP response with freshness metadata
- AND does not call the Bing Webmaster API

### Requirement: Bing ingestion ownership
Bing Webmaster provider calls and credentials SHALL be owned by `firstsun-dev/windmill-flows`, which populates the PostgreSQL read model consumed by `anas-mcp`.

#### Scenario: Bing provider credential is provisioned
- WHEN the Bing Webmaster API key/token is configured
- THEN the credential SHALL be stored in the protected Windmill credential path used by the ingestion runtime
- AND `anas-mcp` SHALL NOT bind, store, log, or receive the Bing provider credential
- AND the credential SHALL NOT be persisted in PostgreSQL or raw fetch payloads

#### Scenario: Bing provider throttles an ingestion run
- WHEN Bing returns a throttling response such as HTTP 400 with `ErrorCode: 17 / ThrottleIP`
- THEN the ingestion layer SHALL classify the run as throttled/rate-limited
- AND apply bounded retry/backoff according to the ingestion policy
- AND preserve failure evidence
- AND SHALL NOT replace the latest successful dataset as though the throttled run were fresh

### Requirement: Bing freshness is explicit
Bing MCP responses SHALL expose freshness metadata for asynchronously ingested data.

#### Scenario: Bing analytics are returned
- WHEN `anas-mcp` returns Bing search-performance data
- THEN the response SHALL include the latest successful ingestion timestamp represented by the result when known
- AND the newest provider data date when known
- AND SHALL expose stale/unknown freshness rather than fabricating current zero-traffic rows

### Requirement: Bing URL information is deferred
The initial Bing MCP surface SHALL NOT expose arbitrary request-time URL information lookups.

#### Scenario: URL information is requested as a future capability
- WHEN a design proposes `bing_url_info` or another arbitrary Bing URL lookup
- THEN a separate accepted OpenSpec change SHALL define its cache/ingestion/on-demand execution strategy
- AND the design SHALL avoid reintroducing direct Cloudflare Worker-to-Bing request-time dependency

### Requirement: Bing legacy protocols are prohibited
The Bing integration SHALL NOT use the legacy SOAP or POX interfaces.

#### Scenario: Bing API client is implemented
- WHEN the provider service is added
- THEN it SHALL use the supported REST/JSON interface documented by Microsoft at implementation time
- AND it SHALL NOT depend on SOAP or POX endpoints

### Requirement: Clarity from PostgreSQL
The service SHALL read Microsoft Clarity analytics from PostgreSQL data ingested by `firstsun-dev/windmill-flows` and SHALL NOT call the Microsoft Clarity API.

#### Scenario: Clarity page analytics
- WHEN a client requests Clarity metrics for a page
- THEN the service reads the normalized `blog_analytics` data through a read-only PostgreSQL connection
- AND no Clarity API quota is consumed

### Requirement: Direct provider credentials are centralized in Secrets Store
Provider credentials consumed directly by `anas-mcp`, including GA4 and Google Search Console credentials, SHALL use Cloudflare Secrets Store as their production source of truth.

#### Scenario: Google analytics/search credentials are configured
- WHEN GA4 or Google Search Console tools need provider authorization
- THEN the shared Google OAuth credential JSON SHALL be loaded from Cloudflare Secrets Store
- AND derived short-lived Google access tokens SHALL remain runtime-only

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

#### Scenario: Windmill ingests Bing Webmaster data
- WHEN `firstsun-dev/windmill-flows` calls the Bing Webmaster API
- THEN the Bing provider credential remains owned by the Windmill ingestion runtime
- AND `anas-mcp` SHALL NOT duplicate the Bing API key/token into Cloudflare Secrets Store
- AND MCP tools SHALL read the resulting PostgreSQL read model through Hyperdrive


#### Scenario: MCP clients authenticate
- WHEN a client authenticates to `/mcp` with the dedicated bearer API key
- THEN the key is read from the Cloudflare Secrets Store binding and compared in the Worker
- AND the key and the supplied `Authorization` header SHALL NOT be persisted, logged, or returned

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

### Requirement: Minimal health endpoint
`/health` MAY remain unauthenticated while `/mcp` requires bearer authentication, but it SHALL expose no sensitive state.

#### Scenario: Health check is requested
- WHEN a caller requests `/health`
- THEN the service may return a minimal readiness response such as `{ "status": "ok" }`
- AND it SHALL NOT disclose credentials, Access configuration, provider authentication state, database details, or analytics data
