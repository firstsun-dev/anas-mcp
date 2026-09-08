# AGENTS.md

## Purpose
`anas-mcp` is Firstsun's read-only analytics MCP service running on Cloudflare Workers.

## Architecture invariants
- Expose MCP over stateless Streamable HTTP at `/mcp` using `createMcpHandler()`.
- **HTTP API contract uses OpenAPI 3.2.0.** Keep repository-root `openapi.yaml` synchronized with every HTTP route/method/auth/status/content-type/stable-payload change. Swagger-compatible tooling is the expected rendering ecosystem. See `docs/api.md` and `openspec/changes/adopt-openapi-http-contract/`.
- Do not model MCP tools as fake REST endpoints merely to expose them in Swagger. MCP tool schemas remain authoritative in MCP/Zod; OpenAPI documents the HTTP transport surface.
- **Production MCP authentication uses Cloudflare Access Managed OAuth.** The production `/mcp` resource must be protected by an Access self-hosted application with Managed OAuth enabled and default-deny Access policy. See `docs/cloudflare-access.md` and `openspec/changes/add-cloudflare-access-auth/`.
- Do not replace Access Managed OAuth with shared static bearer tokens, query-string secrets, OpenAI IP allowlisting, User-Agent checks, or a custom username/password system.
- Do not add `@cloudflare/workers-oauth-provider`, `OAUTH_KV`, D1, Durable Objects, or PostgreSQL OAuth tables solely to duplicate Cloudflare Access Managed OAuth unless an accepted OpenSpec change supersedes the current decision.
- **Cloudflare Worker CI/CD is centralized in `firstsun-dev/.github`.** Production/development deploy logic must use the reusable workflow `firstsun-dev/.github/.github/workflows/_cf-worker-template.yml`; this repository may contain only a thin caller workflow with app-specific triggers and inputs. See `docs/cicd.md` and `openspec/changes/use-centralized-cf-worker-ci/`.
- Do not copy/fork `wrangler versions upload/deploy`, shared rollback logic, or generic Cloudflare pipeline steps into this repository to bypass the central workflow. Generic CI improvements belong in `firstsun-dev/.github`.
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
- CI bootstrap credentials required to deploy to Cloudflare may live in the protected GitHub Actions mechanism expected by the centralized workflow; do not copy runtime provider credentials into CI solely for deployment.
- Never expose a generic SQL execution MCP tool. MCP tools must use constrained inputs and parameterized queries.
- Do not add D1, Durable Objects, Containers, Queues, or other infrastructure unless an accepted OpenSpec change requires them.

## OpenSpec workflow
1. Read `openspec/project.md`, `docs/credentials.md`, `docs/cloudflare-access.md`, `docs/cicd.md`, `docs/api.md`, `openapi.yaml`, and relevant files in `openspec/specs/`.
2. For behavior or architecture changes, create or update a change under `openspec/changes/<change-id>/` before implementation.
3. Keep `proposal.md`, `design.md`, and `tasks.md` aligned with implementation.
4. Mark tasks complete only with verification evidence.

## Verification
Before claiming a code change is done, run:

```bash
npm install
npm run check
```

For HTTP surface changes, also validate `openapi.yaml` with the project-selected OpenAPI 3.2-capable validator and ensure Swagger-compatible rendering remains valid. Do not claim OpenAPI validation complete until that validator is actually wired into the project check/CI path.

For MCP behavior changes also run the Worker locally and validate `/mcp` using MCP Inspector. Production authentication is not verified until the deployed Access Managed OAuth flow has been tested with an allowed and denied identity; ChatGPT compatibility must not be claimed unless actually tested from ChatGPT.

CI/CD work is not complete until the thin caller has been validated against the current `firstsun-dev/.github` reusable workflow contract. Do not claim deploy compatibility until package-manager behavior, required inputs, and target environment URLs have actually been verified.

## Definition of done
- Scope matches an accepted OpenSpec change or an existing spec.
- TypeScript typecheck passes.
- HTTP surface and `openapi.yaml` are synchronized.
- No credentials, tokens, private keys, database URLs, Access assertions, or raw analytics payloads are committed or logged.
- Production `/mcp` remains behind Cloudflare Access Managed OAuth unless an accepted OpenSpec change supersedes it.
- Production/development Worker deployment remains delegated to `firstsun-dev/.github` reusable CI unless an accepted OpenSpec change documents an exception.
- Long-lived Worker-consumed credentials use Cloudflare Secrets Store unless an accepted exception is documented.
- Tool contracts have bounded inputs and predictable output shapes.
- Relevant OpenSpec tasks are updated with verification evidence.
