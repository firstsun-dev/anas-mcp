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
- AND the document SHALL NOT contain production credentials, Access assertions, provider tokens, database secrets, or private analytics payloads

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

### Requirement: Cloudflare Access production authentication
Production access to `/mcp` SHALL be protected by Cloudflare Access with Managed OAuth enabled.

#### Scenario: Unauthenticated MCP client connects
- GIVEN `/mcp` is deployed behind Cloudflare Access
- WHEN an unauthenticated standards-compliant MCP client requests the resource
- THEN Cloudflare Access presents standards-based OAuth discovery/authentication behavior
- AND the client is not allowed to invoke MCP tools before successful authentication

#### Scenario: Authorized user connects from ChatGPT
- GIVEN the user matches an approved Cloudflare Access policy
- WHEN ChatGPT completes the Access Managed OAuth authorization flow with PKCE
- THEN Access permits the authenticated request to reach `/mcp`
- AND the MCP client can initialize and invoke tools permitted by the service

#### Scenario: User is not allowed by Access policy
- GIVEN the user does not match an allow policy
- WHEN the user attempts the Access authorization flow
- THEN access to `/mcp` is denied
- AND the Worker does not bypass the Access decision

### Requirement: No parallel static-token authentication
The normal production ChatGPT/MCP authentication path SHALL NOT use a shared static bearer token or client-identification heuristics.

#### Scenario: Alternative authentication is proposed
- WHEN an implementation proposes OpenAI IP allowlisting, User-Agent matching, query-string tokens, or a shared long-lived bearer token as the primary interactive MCP authentication mechanism
- THEN the proposal SHALL be rejected unless a new accepted OpenSpec change explicitly supersedes the Cloudflare Access decision

### Requirement: Access-owned OAuth state
Cloudflare Access Managed OAuth SHALL own MCP client authentication state and tokens at the edge.

#### Scenario: MCP authentication state is required
- WHEN ChatGPT authenticates to the protected `/mcp` resource
- THEN `anas-mcp` SHALL NOT introduce KV, D1, Durable Objects, PostgreSQL, or another application datastore solely to persist MCP OAuth state/tokens
- AND Access-managed token material SHALL NOT be copied into application storage or MCP responses

### Requirement: Authenticated identity minimization
The Worker MAY consume authenticated identity/context forwarded by Cloudflare Access only when necessary for authorization, audit, or future per-user policy.

#### Scenario: Tool handler uses authenticated identity
- WHEN a tool needs caller identity
- THEN it uses the minimum trusted Access-provided identity/context available to the request
- AND it SHALL NOT return raw Access tokens, identity assertions, or security headers to the MCP client

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
- AND runtime credentials such as Google OAuth JSON, Bing Webmaster tokens, Clarity tokens, PostgreSQL passwords, or Access token material SHALL NOT be copied into CI solely for deployment

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


#### Scenario: Cloudflare Access authenticates MCP clients
- WHEN Cloudflare Access Managed OAuth is used for `/mcp`
- THEN Access-owned OAuth client/session/token material remains managed by Cloudflare Access
- AND `anas-mcp` SHALL NOT duplicate that platform-managed material into Secrets Store or an application datastore

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
`/health` MAY remain unauthenticated when Cloudflare Access protection is scoped specifically to `/mcp`, but it SHALL expose no sensitive state.

#### Scenario: Health check is requested
- WHEN a caller requests `/health`
- THEN the service may return a minimal readiness response such as `{ "status": "ok" }`
- AND it SHALL NOT disclose credentials, Access configuration, provider authentication state, database details, or analytics data
