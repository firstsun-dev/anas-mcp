# Design: concurrent dual-mode Cloudflare Access authentication

## Architecture

```text
Mode A: interactive                         Mode B: headless
ChatGPT / OAuth client                      Agent / CI / automation
        |                                             |
        | Managed OAuth + PKCE                        | Access Service Token
        | Authorization: Bearer <opaque token>        | CF-Access-Client-Id
        |                                             | CF-Access-Client-Secret
        +----------------------+----------------------+
                               |
                               v
                      Cloudflare Access
             identity Allow / Service Auth policies
                               |
                               | Cf-Access-Jwt-Assertion
                               v
                    Cloudflare Worker: anas-mcp
                               |
                     validate Access application JWT
                               |
                               v
                     createMcpHandler() at /mcp
                               |
                        read-only MCP tools
```

## Simultaneous behavior

Mode A and Mode B MUST be enabled concurrently on the same production Access application and MCP endpoint.

This is explicitly not:
- a feature flag choosing one auth mode
- a migration window where only one mode is active
- separate production endpoints
- an OAuth-first fallback to Service Token
- a Service-Token-first fallback to OAuth

Each request independently carries either user OAuth credentials or Service Token credentials. Cloudflare Access chooses the applicable auth path and policy.

## Mode A — Managed OAuth

Cloudflare Access owns OAuth discovery, authorization-code + PKCE, IdP login, opaque client-facing access tokens, and interactive identity-policy evaluation.

The Worker does not implement OAuth endpoints or persist OAuth state.

## Mode B — Access Service Token

Preferred request headers:

```http
CF-Access-Client-Id: <CLIENT_ID>
CF-Access-Client-Secret: <CLIENT_SECRET>
```

The Access application must include a `Service Auth` policy matching explicitly approved Service Tokens.

If a client only supports one arbitrary custom header, use Access `read_service_tokens_from_header` with a dedicated header such as `X-Anas-MCP-Service-Token`. Do not overload `Authorization` for the single-header Service Token on the shared endpoint unless a separately reviewed compatibility test proves it cannot interfere with Managed OAuth.

## Strict Service Token authentication

When Cloudflare strict Service Token authentication is enabled, Service Token requests must continue to send their Service Token headers on each request. Only `Service Auth` policies authorize them, and failed machine authentication should produce 401/403 rather than an interactive redirect.

## Worker validation

For every request that reaches protected `/mcp`:

1. Read `Cf-Access-Jwt-Assertion`.
2. Verify its signature using the Cloudflare Access JWKS.
3. Verify expected issuer/team domain.
4. Verify application AUD.
5. Verify expiry/not-before as supported.
6. Reject invalid/missing assertions before MCP initialization, tool execution, or database access.

Do not trust the presence of Access headers without cryptographic JWT validation.

## Transitional API-key removal

PR #8 introduced `ANAS_MCP_API_KEY`, a Secrets Store binding, and Worker-local bearer comparison.

Those are not a third supported mode. During implementation:
- remove the production API-key request gate
- remove its Secrets Store binding
- remove/update API-key-only OpenAPI semantics
- preserve reusable security tests where applicable
- replace API-key E2E with OAuth + Service Token verification

## Secret ownership

Service Token Client Secrets belong to the machine client/operator secret-management boundary, not the `anas-mcp` Worker Secrets Store.

The Worker must never receive or store the raw Service Token Client Secret as an application credential.

## Verification matrix

| Client | Mode | Expected |
| --- | --- | --- |
| ChatGPT | Managed OAuth | login, initialize, tools/list, tool call |
| OAuth-capable MCP client | Managed OAuth | OAuth + PKCE works |
| Headless agent | Service Token | two-header auth reaches same tools/list |
| Single-header agent, if required | Service Token | dedicated custom header works concurrently with OAuth |
| Unauthorized user | OAuth | blocked before MCP |
| Invalid/revoked Service Token | Service Token | 401/403 before MCP |
| Request without valid Access assertion | origin validation | rejected before MCP |
