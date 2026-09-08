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
- **Google OAuth:** one JSON credential stored in Cloudflare Secrets Store.
- **Database:** read-only PostgreSQL access through Cloudflare Hyperdrive.

## Current state

The repository currently contains the MCP foundation only:

- stateless `/mcp` endpoint using Cloudflare Agents SDK
- `/health` HTTP endpoint
- MCP `health` tool
- OpenSpec architecture, requirements, design, and implementation tasks

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

See `AGENTS.md` before making code or architecture changes.
