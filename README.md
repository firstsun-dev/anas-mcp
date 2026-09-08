# anas-mcp

Cloudflare-hosted, read-only Remote MCP service for Firstsun analytics.

## Architecture

```text
ChatGPT / MCP client
        |
        | Streamable HTTP
        v
Cloudflare Worker: anas-mcp
        |
        +--> Google Analytics Data API
        +--> Google Search Console API
        +--> Hyperdrive --> PostgreSQL --> Clarity analytics
```

- **GA4:** direct Google Analytics Data API queries.
- **Search Console:** direct Search Console API queries.
- **Clarity:** read normalized PostgreSQL data populated by `firstsun-dev/windmill-flows`; this service never calls the Clarity API directly.
- **Credentials:** Secrets Store first. Any long-lived secret consumed directly by this Worker should come from Cloudflare Secrets Store whenever supported.
- **Google OAuth:** one JSON credential stored in Cloudflare Secrets Store.
- **Database:** read-only PostgreSQL access through Cloudflare Hyperdrive; the database password remains managed by Hyperdrive and is not duplicated into Worker secrets.

See `docs/credentials.md` for the full credential policy and documented exceptions.

## Credential policy summary

Use Cloudflare Secrets Store as the production source of truth for application-held secrets such as OAuth credentials, API tokens, client secrets, signing keys, and encryption keys.

Do not put production credentials in:

- Wrangler `vars`
- committed configuration
- `.env` or `.dev.vars`
- source code
- logs

Do not use `wrangler secret` when Secrets Store can serve the same production credential unless an accepted OpenSpec change documents why.

Intentional exceptions:

- PostgreSQL credentials stay in the Hyperdrive connection.
- The Microsoft Clarity API token stays in `firstsun-dev/windmill-flows` because this service never calls Clarity directly.
- Derived short-lived OAuth access tokens stay in runtime memory only.
- CI bootstrap credentials may use the CI provider's protected secret store when they are required before Cloudflare can be accessed; prefer workload identity/OIDC where supported.

## Current state

The repository currently contains the MCP foundation only:

- stateless `/mcp` endpoint using Cloudflare Agents SDK
- `/health` HTTP endpoint
- MCP `health` tool
- OpenSpec architecture, requirements, design, and implementation tasks
- Secrets Store first credential policy

Datasource integrations are intentionally tracked as follow-up tasks under `openspec/changes/bootstrap-analytics-mcp/tasks.md`.

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

## Verification

```bash
npm run check
```

## Deployment

```bash
npm run deploy
```

Do not commit real Cloudflare resource IDs, database credentials, Google OAuth credentials, access tokens, or private analytics payloads.

## OpenSpec

Start with:

- `openspec/project.md` — project architecture and boundaries
- `openspec/specs/analytics-mcp/spec.md` — baseline capability requirements
- `openspec/changes/bootstrap-analytics-mcp/proposal.md` — bootstrap proposal
- `openspec/changes/bootstrap-analytics-mcp/design.md` — implementation design
- `openspec/changes/bootstrap-analytics-mcp/tasks.md` — execution checklist
- `docs/credentials.md` — credential ownership, storage, and exception policy

See `AGENTS.md` before making code or architecture changes.
