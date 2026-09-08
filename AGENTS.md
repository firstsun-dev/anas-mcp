# AGENTS.md

## Purpose
`anas-mcp` is Firstsun's read-only analytics MCP service running on Cloudflare Workers.

## Architecture invariants
- Expose MCP over stateless Streamable HTTP at `/mcp` using `createMcpHandler()`.
- GA4 is queried through the Google Analytics Data API.
- Google Search Console is queried through the Search Console API.
- Microsoft Clarity is never queried directly from this service. Read normalized Clarity data from PostgreSQL populated by `firstsun-dev/windmill-flows`.
- **Secrets Store first:** every long-lived secret consumed directly by `anas-mcp` MUST come from Cloudflare Secrets Store whenever the platform supports it. See `docs/credentials.md`.
- Never put production secrets in Wrangler `vars`, committed files, `.env`, `.dev.vars`, source code, or logs.
- Do not use `wrangler secret` for a production credential when Secrets Store can provide it. Any fallback requires an accepted OpenSpec change documenting the limitation.
- Google OAuth credentials are stored as one JSON credential in Cloudflare Secrets Store. Never commit credentials or log credential contents.
- Derived short-lived provider access tokens are runtime-only and must not be persisted.
- PostgreSQL access must be read-only and use Cloudflare Hyperdrive when enabled. Database credentials are owned by Hyperdrive and must not be duplicated into Secrets Store.
- The Clarity API token remains owned by `firstsun-dev/windmill-flows` and must not be copied into this service.
- Never expose a generic SQL execution MCP tool. MCP tools must use constrained inputs and parameterized queries.
- Do not add D1, Durable Objects, Containers, Queues, or other infrastructure unless an accepted OpenSpec change requires them.

## OpenSpec workflow
1. Read `openspec/project.md`, `docs/credentials.md`, and relevant files in `openspec/specs/`.
2. For behavior or architecture changes, create or update a change under `openspec/changes/<change-id>/` before implementation.
3. Keep `proposal.md`, `design.md`, and `tasks.md` aligned with implementation.
4. Mark tasks complete only with verification evidence.

## Verification
Before claiming a code change is done, run:

```bash
npm install
npm run check
```

For MCP behavior changes also run the Worker locally and validate `/mcp` using MCP Inspector.

## Definition of done
- Scope matches an accepted OpenSpec change or an existing spec.
- TypeScript typecheck passes.
- No credentials, tokens, private keys, database URLs, or raw analytics payloads are committed or logged.
- Long-lived Worker-consumed credentials use Cloudflare Secrets Store unless an accepted exception is documented.
- Tool contracts have bounded inputs and predictable output shapes.
- Relevant OpenSpec tasks are updated with verification evidence.
