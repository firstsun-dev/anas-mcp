# Proposal: concurrent dual-mode Cloudflare Access authentication

## Why

`anas-mcp` must serve both interactive AI clients and headless agents.

Interactive clients such as ChatGPT require standards-based OAuth. Headless agents, CI jobs, and automation may not be able to complete a browser OAuth flow and need a machine identity.

The service therefore needs both modes **at the same time**, not a toggle between them.

## Decision

Protect the same production `/mcp` resource with one Cloudflare Access application that concurrently accepts:

- **Mode A — Managed OAuth** for interactive/user-driven clients.
- **Mode B — Access Service Token** for headless agents and automation.

Both modes terminate at Cloudflare Access. Cloudflare Access evaluates the authentication material present on each request and applies the matching policy. Enabling Mode B SHALL NOT disable Mode A, and vice versa.

The Worker SHALL validate `Cf-Access-Jwt-Assertion` before MCP initialization/tool execution.

The Worker-local bearer API key implemented in PR #8 is superseded and SHALL be removed when this change is implemented.

## Policy model

- Interactive identities: identity-based Access Allow policies.
- Service Tokens: Access `Service Auth` policies.
- Default deny remains the baseline.
- Service Tokens are machine principals and do not represent end users.

## Client compatibility

### Mode A
Use Managed OAuth for ChatGPT and any client supporting OAuth discovery, authorization-code flow, PKCE, and the MCP/OAuth requirements expected by Cloudflare Access.

### Mode B
Use Access Service Tokens for clients with no interactive user flow.

Preferred headers:

```http
CF-Access-Client-Id: <CLIENT_ID>
CF-Access-Client-Secret: <CLIENT_SECRET>
```

If an approved agent supports only one custom header, configure Access single-header service-token authentication using a dedicated non-`Authorization` header.

## Success criteria

- OAuth clients and Service Token clients can use the same `/mcp` deployment concurrently.
- ChatGPT can complete Managed OAuth and call a read-only tool.
- A headless agent can call the same MCP endpoint using a Service Token without browser login.
- Invalid users/tokens are blocked before MCP execution.
- The Worker validates the Access application JWT for requests reaching `/mcp`.
- The transitional `ANAS_MCP_API_KEY` gate/binding is removed.
- No OAuth token, Service Token secret, Access assertion, or security header is logged or returned.
