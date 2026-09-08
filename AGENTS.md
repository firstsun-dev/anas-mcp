# AGENTS.md

## Purpose
`anas-mcp` is Firstsun's read-only analytics MCP service running on Cloudflare Workers.

## Architecture invariants
- Expose MCP over stateless Streamable HTTP at `/mcp` using `createMcpHandler()`.
- **Production MCP authentication uses Cloudflare Access Managed OAuth.** The production `/mcp` resource must be protected by an Access self-hosted application with Managed OAuth enabled and default-deny Access policy. See `docs/cloudflare-access.md` and `openspec/changes/add-cloudflare-access-auth/`.
- Do not replace Access Managed OAuth with shared static bearer tokens, query-string secrets, OpenAI IP allowlisting, User-Agent checks, or a custom username/password system.
- Do not add `@cloudflare/workers-oauth-provider`, `OAUTH_KV`, D1, Durable Objects, or PostgreSQL OAuth tables solely to duplicate Cloudflare Access Managed OAuth unless an accepted OpenSpec change supersedes the current decision.
- GA4 is queried through the Google Analytics Data API.
- Google Search Console is queried through the Search Console API.
- Microsoft Clarity is never queried directly from this service. Read normalized Clarity data from PostgreSQL populated by `firstsun-dev/windmill-flows`.
- **Secrets Store first:** every long-lived secret consumed directly by `anas-mcp` MUST come from Cloudflare Secrets Store whenever the platform supports it. See `docs/credentials.md`.
- Never put production secrets in Wrangler `vars`, committed files, `.env`, `.dev.vars`, source code, or logs.
- Do not use `wrangler secret` for a production credential when Secrets Store can provide it. Any fallback requires an accepted OpenSpec change documenting the limitation.
- Google OAuth credentials are stored as one JSON credential in Cloudflare Secrets Store. Never commit credentials or log credential contents.
- Derived short-lived provider access tokens are runtime-only and must not be persisted.
- Cloudflare Access Managed OAuth token/session state is platform-managed and must not be duplicated into application storage.
- PostgreSQL access must be read-only and use Cloudflare Hyperdrive when enabled. Database credentials are owned by Hyperdrive and must not be duplicated into Secrets Store.
- The Clarity API token remains owned by `firstsun-dev/windmill-flows` and must not be copied into this service.
- Never expose a generic SQL execution MCP tool. MCP tools must use constrained inputs and parameterized queries.
- Do not add D1, Durable Objects, Containers, Queues, or other infrastructure unless an accepted OpenSpec change requires them.

## OpenSpec workflow
1. Read `openspec/project.md`, `docs/credentials.md`, `docs/cloudflare-access.md`, and relevant files in `openspec/specs/`.
2. For behavior or architecture changes, create or update a change under `openspec/changes/<change-id>/` before implementation.
3. Keep `proposal.md`, `design.md`, and `tasks.md` aligned with implementation.
4. Mark tasks complete only with verification evidence.

## Verification
Before claiming a code change is done, run:

```bash
npm install
npm run check
```

For MCP behavior changes also run the Worker locally and validate `/mcp` using MCP Inspector. Production authentication is not verified until the deployed Access Managed OAuth flow has been tested with an allowed and denied identity; ChatGPT compatibility must not be claimed unless actually tested from ChatGPT.

## Definition of done
- Scope matches an accepted OpenSpec change or an existing spec.
- TypeScript typecheck passes.
- No credentials, tokens, private keys, database URLs, Access assertions, or raw analytics payloads are committed or logged.
- Production `/mcp` remains behind Cloudflare Access Managed OAuth unless an accepted OpenSpec change supersedes it.
- Long-lived Worker-consumed credentials use Cloudflare Secrets Store unless an accepted exception is documented.
- Tool contracts have bounded inputs and predictable output shapes.
- Relevant OpenSpec tasks are updated with verification evidence.
