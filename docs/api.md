# HTTP API contract

## Decision

`anas-mcp` documents its HTTP surface with **OpenAPI 3.2.0** in the repository-root `openapi.yaml` file.

Swagger-compatible tooling is the expected human-facing documentation and validation ecosystem for this contract.

At the time this decision was recorded, Swagger UI 5.32+ supports OpenAPI 3.2.0.

## Scope

OpenAPI documents HTTP endpoints and transport behavior, including:

- `GET /health`
- `POST /mcp`
- HTTP status codes
- content types
- authentication boundary
- stable HTTP request/response schemas owned by this service

OpenAPI does **not** replace MCP tool discovery or MCP tool schemas.

Do not model each MCP tool as a fake REST endpoint merely to make it appear in Swagger.

The authoritative tool contract remains:

```text
MCP server registration
+ MCP tool input/output schema
+ Zod / MCP SDK validation
```

The authoritative HTTP contract remains:

```text
openapi.yaml
```

## Swagger UI

A Swagger UI surface may be generated from `openapi.yaml` for developers/operators.

If served by this Worker in a future change, prefer routes such as:

```text
/docs
/openapi.yaml
```

or equivalent static/generated documentation paths.

Do not expose credentials, Access assertions, OAuth tokens, Service Token secrets, provider tokens, Hyperdrive connection details, or analytics payload examples containing private production data in Swagger/OpenAPI documentation.

Whether `/docs` is public or Access-protected must be an explicit decision. A public schema is acceptable only if it contains no sensitive operational information.

## Cloudflare Access representation

Production `/mcp` is protected by one Cloudflare Access application that concurrently accepts Mode A (Managed OAuth) and Mode B (Access Service Token). `openapi.yaml` lists both as alternative security requirements: `CloudflareAccessOAuth` (`type: oauth2`, `oauth2MetadataUrl` pointing at the RFC 8414 Authorization Server Metadata document rather than a fixed `flows.authorizationCode` with hard-coded `authorizationUrl`/`tokenUrl`, since Cloudflare Access does not publish fixed ones for this flow) and `CloudflareAccessServiceTokenId` + `CloudflareAccessServiceTokenSecret` (headers `CF-Access-Client-Id` and `CF-Access-Client-Secret`, required together in the same security requirement, since Service Token auth needs both). OAuth discovery/authorization/token endpoints are owned by Cloudflare Access and are not implemented or enumerated by the Worker.

The contract documents the Worker-origin responses `401` (no valid `Cf-Access-Jwt-Assertion`), `403` (unexpected `Host` or any `Origin`; see `docs/mcp-authentication.md`) and `503` (Worker Access configuration missing; fails closed). Access's own challenges/denials happen at the edge and never reach the Worker. `/health` is outside the Access application (`security: []`). No example credential, token, assertion, or production AUD is embedded. See `docs/mcp-authentication.md`.

## MCP transport

`/mcp` is a protocol transport endpoint, not a conventional business REST operation.

The OpenAPI contract intentionally keeps the MCP protocol-message schema open and points developers to the MCP protocol/SDK for the authoritative envelope.

This avoids coupling the HTTP API document to a specific MCP protocol revision while still documenting:

- route
- method
- authentication
- accepted media type
- response media types
- expected HTTP errors

When the installed MCP SDK changes protocol behavior, review `openapi.yaml` in the same change.

## Change rule

Any change that adds, removes, or changes an HTTP route, method, status code, auth requirement, or stable payload owned by `anas-mcp` MUST update `openapi.yaml` in the same change.

Examples:

- adding `/docs`
- changing `/health` payload
- adding a REST admin endpoint
- changing `/mcp` authentication semantics
- adding a new HTTP webhook

MCP tool-only changes do not require fake OpenAPI paths, but they still require MCP schema/tests and relevant OpenSpec updates.

## Validation

`npm run check` runs `npm run lint:openapi` (`redocly lint openapi.yaml`, `@redocly/cli` pinned in `package.json`/`package-lock.json`), which validates OpenAPI 3.2.0 natively (verified with `@redocly/cli` 2.62.1; no downgrade to 3.0/3.1 was needed). A clean run has 0 errors. It currently reports 3 non-blocking warnings that are informational, not structural: `info-license` (this repository has no `LICENSE` file, and adding a `license` field without one would misstate the project's actual licensing), `no-server-example-com` (the `http://localhost:8787` local-dev server entry, which is intentional), and `operation-4xx-response` (`/health` has no 4xx because it is deliberately unauthenticated and unconditional). `redocly lint` exits `0` with warnings only, so CI fails only on real structural errors.

Swagger UI/Editor rendering should also be checked when the documentation tooling changes.

## Source-of-truth hierarchy

When documents disagree:

1. accepted OpenSpec requirements define intended behavior;
2. `openapi.yaml` defines the intended HTTP contract;
3. MCP schemas define the intended tool contract;
4. implementation and tests must conform to those contracts.

A drift between implementation and `openapi.yaml` is a defect, not a documentation-only issue.
