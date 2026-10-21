# Design

## Routing
`src/index.ts` compares `url.pathname` to `MCP_ROUTE = "/anas/mcp"` by strict equality and 404s otherwise, before
`verifyAccessAssertion`, `createServer()` or any database work. `createMcpHandler` receives the same constant.

## OAuth discovery
Cloudflare Access serves RFC 9728 protected-resource metadata and the authorization server. The Worker serves none of it
(404 for `/.well-known/*`). The smoke script follows the `resource_metadata` URL from the `401` challenge, requires it to be
on the production host, and asserts `resource == https://mcp.firstsun.org/anas/mcp` and the Access issuer in
`authorization_servers`. Nothing hardcodes the metadata path.

## Order-sensitive cutover (summary)
1. infra-config: Terraform updates the Access application domain `mcp.firstsun.org/anas` -> `mcp.firstsun.org/anas/mcp`
   (in place, AUD unchanged; plan evidence in the infra PR). Until the Worker deploys, `/anas/mcp` is challenged by Access and the
   old Worker answers 404 for it (fail closed; MCP unavailable).
2. Merge this PR (CI deploys + smoke).
3. Live verification, then owner re-points ChatGPT to `https://mcp.firstsun.org/anas/mcp`.
Recovery: manual only; never roll back to a version that predates Access validation.
