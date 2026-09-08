# Proposal: adopt OpenAPI HTTP contract

## Why

`anas-mcp` needs a machine-readable HTTP API contract that can be rendered and inspected with Swagger-compatible tooling and validated in CI.

The service exposes both ordinary HTTP routes and an MCP Streamable HTTP transport. Without an explicit HTTP contract, route/auth/media-type behavior can drift independently from implementation and operator documentation.

## What changes

- Make repository-root `openapi.yaml` the canonical HTTP API description.
- Adopt OpenAPI 3.2.0 for the HTTP surface.
- Require Swagger-compatible rendering/tooling for human inspection.
- Document `/health` and `/mcp` transport behavior in OpenAPI.
- Keep MCP tool schemas authoritative in MCP/Zod rather than representing tools as fake REST endpoints.
- Require HTTP route/auth/payload changes to update OpenAPI in the same change.
- Require CI validation of `openapi.yaml` with an OpenAPI 3.2-capable validator before deployment.

## In scope

- HTTP API contract ownership.
- OpenAPI version and file location.
- Swagger tooling expectations.
- MCP/OpenAPI boundary.
- CI validation requirement.

## Out of scope

- Exposing every MCP tool as REST.
- Replacing MCP tool schemas with OpenAPI schemas.
- Serving Swagger UI from the Worker in this documentation change.
- Adding new REST analytics endpoints.
- Changing Cloudflare Access authentication behavior.

## Success criteria

- `openapi.yaml` exists and matches the currently implemented HTTP routes.
- The OpenSpec baseline requires OpenAPI updates for HTTP surface changes.
- Project instructions require agents to keep OpenAPI synchronized.
- CI work is tracked to validate OpenAPI before centralized Cloudflare deployment.
