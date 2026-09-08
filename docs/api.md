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

Do not expose credentials, Access assertions, provider tokens, Hyperdrive connection details, or analytics payload examples containing private production data in Swagger/OpenAPI documentation.

Whether `/docs` is public or Access-protected must be an explicit decision. A public schema is acceptable only if it contains no sensitive operational information.

## Cloudflare Access representation

Production `/mcp` is protected by Cloudflare Access Managed OAuth.

The OpenAPI description represents the resulting HTTP authorization requirement as a bearer security scheme because the Worker receives an authenticated bearer credential after the Access OAuth flow.

This does not mean users manually paste a static bearer token. ChatGPT and other standards-compliant MCP clients should obtain the token through Cloudflare Access Managed OAuth.

OAuth discovery/authorization metadata remains owned by Cloudflare Access rather than duplicated into `openapi.yaml` with guessed production endpoints.

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

CI should lint/validate `openapi.yaml` before deployment.

Use a validator that supports OpenAPI 3.2.0. Do not silently downgrade the file to OpenAPI 3.0/3.1 solely because an outdated linter cannot parse it; update the shared CI toolchain or document an accepted compatibility decision.

Swagger UI/Editor rendering should also be checked when the documentation tooling changes.

## Source-of-truth hierarchy

When documents disagree:

1. accepted OpenSpec requirements define intended behavior;
2. `openapi.yaml` defines the intended HTTP contract;
3. MCP schemas define the intended tool contract;
4. implementation and tests must conform to those contracts.

A drift between implementation and `openapi.yaml` is a defect, not a documentation-only issue.
