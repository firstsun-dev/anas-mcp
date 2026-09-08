# anas-mcp

Cloudflare-hosted, read-only Remote MCP service for Firstsun analytics.

## Architecture

```text
ChatGPT / MCP client
        |
        | OAuth + PKCE
        v
Cloudflare Access (Managed OAuth + policy)
        |
        | authenticated Streamable HTTP
        v
Cloudflare Worker: anas-mcp
        |
        +--> Google Analytics Data API
        +--> Google Search Console API
        +--> Hyperdrive --> PostgreSQL --> Clarity analytics
```

- **MCP authentication:** production `/mcp` is protected by Cloudflare Access Managed OAuth. ChatGPT should authenticate through Access; no shared static bearer token is required for the normal interactive flow.
- **GA4:** direct Google Analytics Data API queries.
- **Search Console:** direct Search Console API queries.
- **Clarity:** read normalized PostgreSQL data populated by `firstsun-dev/windmill-flows`; this service never calls the Clarity API directly.
- **Credentials:** Secrets Store first. Any long-lived secret consumed directly by this Worker should come from Cloudflare Secrets Store whenever supported.
- **Google OAuth:** one JSON credential stored in Cloudflare Secrets Store.
- **Database:** read-only PostgreSQL access through Cloudflare Hyperdrive; the database password remains managed by Hyperdrive and is not duplicated into Worker secrets.

See:

- `docs/cloudflare-access.md` for MCP authentication and Access setup
- `docs/credentials.md` for credential ownership/storage policy

## Authentication policy summary

Cloudflare Access Managed OAuth is the production identity boundary for `/mcp`.

Do not replace it with:

- shared static bearer tokens
- query-string secrets
- OpenAI IP allowlisting
- User-Agent checks
- a custom username/password system

Cloudflare Access owns the MCP client-facing OAuth state and token lifecycle. `anas-mcp` must not add KV, D1, Durable Objects, or PostgreSQL tables solely to duplicate Managed OAuth state.

## Credential policy summary

Use Cloudflare Secrets Store as the production source of truth for application-held secrets such as Google OAuth credentials, API tokens, client secrets, signing keys, and encryption keys.

Do not put production credentials in:

- Wrangler `vars`
- committed configuration
- `.env` or `.dev.vars`
- source code
- logs

Do not use `wrangler secret` when Secrets Store can serve the same production credential unless an accepted OpenSpec change documents why.

Intentional exceptions:

- Cloudflare Access Managed OAuth token/session material remains managed by Cloudflare Access.
- PostgreSQL credentials stay in the Hyperdrive connection.
- The Microsoft Clarity API token stays in `firstsun-dev/windmill-flows` because this service never calls Clarity directly.
- Derived short-lived Google OAuth access tokens stay in runtime memory only.
- CI bootstrap credentials may use the CI provider's protected secret store when they are required before Cloudflare can be accessed; prefer workload identity/OIDC where supported.

## Current state

The repository currently contains the MCP foundation and architecture specifications:

- stateless `/mcp` endpoint using Cloudflare Agents SDK
- `/health` HTTP endpoint
- MCP `health` tool
- OpenSpec architecture, requirements, design, and implementation tasks
- Secrets Store first credential policy
- Cloudflare Access Managed OAuth production-auth decision

Cloudflare dashboard Access configuration and end-to-end ChatGPT authentication are not considered verified until actually tested.

## Development

```bash
npm install
npm run dev
```

Health endpoint:

```text
http://localhost:8787/health
```

MCP endpoint:

```text
http://localhost:8787/mcp
```

Test MCP locally with:

```bash
npx @modelcontextprotocol/inspector@latest
```

Local MCP behavior may be tested before production Access is provisioned, but production authentication must be verified against the deployed Access-protected endpoint.

## Verification

```bash
npm run check
```

For production auth, follow `docs/cloudflare-access.md` and verify both allowed and denied identities.

## Deployment

```bash
npm run deploy
```

Do not commit real Cloudflare resource IDs, database credentials, Google OAuth credentials, access tokens, Access assertions, or private analytics payloads.

## OpenSpec

Start with:

- `openspec/project.md` — project architecture and boundaries
- `openspec/specs/analytics-mcp/spec.md` — baseline capability requirements
- `openspec/changes/bootstrap-analytics-mcp/` — bootstrap design/tasks
- `openspec/changes/add-cloudflare-access-auth/` — Cloudflare Access authentication decision and rollout tasks
- `docs/cloudflare-access.md` — production Access authentication model and operator checklist
- `docs/credentials.md` — credential ownership, storage, and exception policy

See `AGENTS.md` before making code or architecture changes.
