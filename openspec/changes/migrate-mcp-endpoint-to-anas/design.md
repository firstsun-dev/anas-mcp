# Design

- **Path check before auth.** The hostname is shared; an unrecognised path is not this service's concern, so it gets a generic
  404 without a JWKS fetch or any MCP/DB work. `/anas` itself still runs `verifyAccessAssertion` before `createMcpHandler`.
  A 404 for non-`/anas` paths cannot be used to bypass auth: nothing sensitive is served there.
- **Exact match** on `url.pathname` (`!==`): trailing slash, sub-paths and case variants are rejected; `/anas2` can never be
  taken for `/anas`. `GET /health` is the only other served route and remains `{service,status}`; `POST /health` is now 404.
- **OAuth discovery** is owned by Cloudflare Access, never by the Worker (it 404s `/.well-known/*`). The Access
  protected-resource metadata for this endpoint is expected at `/.well-known/cloudflare-access-protected-resource/anas`
  (observed pattern of the existing `/mcp` application; infra-config verified `/anas` returns 404 until the Access app
  moves). Smoke asserts it after the cutover; real OAuth+PKCE stays a manual gate.
- **No new auth**, no AUD change, no gateway, no `/mcp` shim.
