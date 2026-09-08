# Design: OpenAPI HTTP contract

## Canonical document

Use repository-root:

```text
openapi.yaml
```

as the canonical machine-readable HTTP API contract.

Version:

```yaml
openapi: 3.2.0
```

OpenAPI 3.2 is selected because the service has a streaming protocol endpoint and current Swagger UI versions support OAS 3.2.0.

## Contract boundary

There are two related but distinct contracts:

```text
HTTP surface
  -> OpenAPI

MCP tools/resources/prompts
  -> MCP SDK schemas / Zod / MCP protocol
```

Do not duplicate MCP tools as REST operations.

OpenAPI documents `/mcp` only as the Streamable HTTP transport boundary: route, HTTP method, security requirement, media types, and HTTP status behavior.

Tool discovery remains MCP `tools/list` and tool schemas remain MCP-native.

## Current routes

### `GET /health`

Document the exact currently implemented response:

```json
{
  "service": "anas-mcp",
  "status": "ok"
}
```

The route may remain unauthenticated if Cloudflare Access protects `/mcp` specifically.

### `POST /mcp`

Document:

- MCP Streamable HTTP transport
- JSON request envelope
- JSON or event-stream response shape where negotiated by the MCP transport
- Cloudflare Access authorization boundary
- safe HTTP errors

The OpenAPI MCP envelope schema remains intentionally open because the MCP SDK/protocol is authoritative and may evolve independently of the application HTTP surface.

## Authentication representation

Cloudflare Access Managed OAuth owns interactive OAuth discovery and token issuance.

OpenAPI represents the resulting protected HTTP request using an HTTP bearer security scheme. This representation describes what reaches the protected resource; it does not introduce a static bearer-token workflow.

Do not guess or hardcode Cloudflare Access OAuth authorization/token URLs in OpenAPI before the actual deployment configuration is known. Access remains the source of truth for its discovery metadata.

## Swagger

Swagger-compatible tooling should render `openapi.yaml` for human inspection.

A future implementation may expose:

```text
/docs
/openapi.yaml
```

but this is not required for the initial documentation change.

If Swagger UI is introduced, use a version that supports OpenAPI 3.2.0 and keep it out of the critical MCP runtime path.

## CI validation

The centralized CI/CD design remains unchanged: deployment is driven by the reusable workflow in `firstsun-dev/.github`.

The `anas-mcp` caller/build/check contract must include OpenAPI validation before deploy.

Preferred implementation direction:

- add a local script such as `npm run check:openapi`
- invoke it from `npm run check`
- use an OpenAPI 3.2-capable validator
- let the central reusable workflow execute the project's check command

If the generic Firstsun Worker pipeline should standardize OpenAPI validation across repositories, implement that reusable behavior in `firstsun-dev/.github` instead of duplicating it.

## Drift policy

Any implementation change affecting HTTP routes must update OpenAPI in the same PR/change.

Examples include:

- method/path changes
- auth changes
- status-code changes
- stable request/response payload changes
- content-type changes

A tool-only MCP contract change updates MCP schemas/OpenSpec but does not require fake REST paths.

## Security

OpenAPI/Swagger examples must not contain:

- real OAuth credentials
- Access tokens or assertions
- Google access/refresh tokens
- Clarity tokens
- database credentials
- production analytics rows containing private data

Public exposure of Swagger documentation, if added later, must be reviewed separately from the `/mcp` Access policy.
