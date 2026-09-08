# Cloudflare Access authentication

## Decision

Production MCP authentication for `anas-mcp` uses **Cloudflare Access Managed OAuth**.

`anas-mcp` does not distribute a shared token to ChatGPT and does not maintain a separate OAuth token database for MCP client authentication.

```text
ChatGPT / MCP client
        |
        | OAuth discovery + authorization code + PKCE
        v
Cloudflare Access Managed OAuth
        |
        | identity provider + Access policy
        v
anas-mcp /mcp
```

## Why

Cloudflare Access Managed OAuth lets non-browser clients authenticate to an Access-protected resource through standards-based OAuth while preserving the same Access policies used for browser access.

This keeps the identity boundary at Cloudflare and avoids application-managed shared keys, user databases, or token persistence.

## Production configuration

Create a Cloudflare Access self-hosted application for the production MCP resource.

Preferred scope:

```text
https://<production-host>/mcp
```

Enable **Managed OAuth** in the Access application's advanced settings.

Configure:

- approved identity provider(s)
- default-deny policy
- explicit allow rules for approved Firstsun identities/groups/attributes
- no wildcard allow rule for the public Internet

The actual production hostname and Access application name should be recorded here after provisioning. Do not record credential or token values.

## ChatGPT connection model

The intended user experience is:

1. Add the production `/mcp` URL to ChatGPT as a custom MCP connection.
2. ChatGPT detects that the resource requires OAuth.
3. ChatGPT opens the authorization URL exposed through Cloudflare Access Managed OAuth.
4. The user signs in through the configured Access identity provider.
5. Cloudflare Access evaluates the user's policy.
6. If allowed, ChatGPT receives the Access-managed authorization result/token.
7. Subsequent MCP requests reach `anas-mcp` through the Access boundary.

No shared bearer token should be manually copied into ChatGPT for the normal interactive flow.

## Worker responsibilities

The Worker remains responsible for MCP and analytics behavior, not primary user authentication.

It must:

- keep `/mcp` stateless using `createMcpHandler()`
- assume production `/mcp` traffic has passed the configured Access boundary
- consume only minimal Access-provided identity/context if application logic needs caller identity
- never return Access token/assertion material in MCP results
- never log raw Access security headers or token bodies

It must not add an application OAuth database solely to duplicate Managed OAuth.

## OAuth state and storage

Cloudflare Access owns MCP client-facing OAuth state and access tokens.

Do not create the following solely for MCP authentication:

- `OAUTH_KV`
- D1
- Durable Objects
- PostgreSQL OAuth/session tables
- a custom static token table

This does not change the project's general credential policy. Long-lived credentials consumed directly by the Worker, such as Google OAuth JSON, remain Secrets Store first. See `docs/credentials.md`.

## Health endpoint

`/health` may remain public if Access is scoped specifically to `/mcp`.

It must expose readiness only, for example:

```json
{"status":"ok"}
```

Never expose:

- Access policy/configuration details
- secret-binding state
- Google credential/token state
- Hyperdrive/database details
- analytics rows

## Rejected authentication patterns

Do not use these as the normal ChatGPT authentication path:

- shared static bearer token
- API key in query string
- OpenAI IP allowlisting
- User-Agent checks
- custom username/password authentication in the Worker
- Access service tokens for the interactive user flow

A machine-to-machine service-token flow, if needed later, must be specified separately.

## Verification checklist

After Access configuration is created:

1. Request `/mcp` without credentials and confirm MCP tool execution is blocked.
2. Inspect the response/auth discovery and confirm Managed OAuth is exposed.
3. Connect MCP Inspector and complete interactive login through Access.
4. Confirm an allowed identity can initialize MCP and list tools.
5. Confirm a denied identity cannot initialize MCP.
6. Add the endpoint to ChatGPT and confirm no manually pasted shared bearer token is required.
7. Confirm logs contain no Access token, JWT assertion, or raw security-header values.
8. Confirm `/health` behaves according to the selected public/protected path configuration.

## Current Cloudflare references

- MCP authorization: https://developers.cloudflare.com/agents/model-context-protocol/protocol/authorization/
- Managed OAuth announcement: https://developers.cloudflare.com/changelog/post/2026-03-20-managed-oauth/
- Secure MCP servers with Access: https://developers.cloudflare.com/cloudflare-one/access-controls/ai-controls/secure-mcp-servers/

Always re-check the current Cloudflare documentation before changing Access configuration because authentication behavior and UI options can evolve.
