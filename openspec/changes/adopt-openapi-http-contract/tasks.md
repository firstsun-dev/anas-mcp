# Tasks: OpenAPI HTTP contract

## Contract
- [x] Add repository-root `openapi.yaml` using OpenAPI 3.2.0.
- [x] Document the implemented `GET /health` contract.
- [x] Document `POST /mcp` as the MCP Streamable HTTP transport boundary.
- [x] Represent production `/mcp` protection as Cloudflare Access-managed bearer authorization without introducing a static-token flow.
- [x] Document that MCP tools remain MCP-native schemas rather than fake REST endpoints.
- [x] Add `docs/api.md` describing OpenAPI/Swagger ownership and drift rules.

## Project policy
- [ ] Add the OpenAPI requirement to `AGENTS.md`.
- [ ] Add the OpenAPI/Swagger contract to `README.md` and `openspec/project.md`.
- [ ] Add baseline OpenSpec requirements for HTTP/OpenAPI synchronization.

## Validation
- [ ] Select and pin an OpenAPI 3.2-capable validator compatible with the project package-manager decision.
- [ ] Add `check:openapi` or equivalent.
- [ ] Include OpenAPI validation in the project's aggregate `check` command.
- [ ] Ensure the centralized `firstsun-dev/.github` deployment path runs the aggregate check before deploy.
- [ ] Validate `openapi.yaml` with the selected validator.
- [ ] Render the file with a Swagger UI/Editor version supporting OpenAPI 3.2.0 and confirm there are no rendering errors.

## Optional Swagger UI serving
- [ ] Decide whether runtime Swagger UI is needed.
- [ ] If accepted, define `/docs` and `/openapi.yaml` serving behavior in OpenSpec before implementation.
- [ ] Decide whether documentation routes are public or Access-protected.
- [ ] Do not expose sensitive examples or infrastructure details.

## Verification evidence

On 2026-09-08 the current Worker route implementation was inspected before writing the initial contract. `src/index.ts` implements `GET /health` returning `{ "service": "anas-mcp", "status": "ok" }` and delegates the MCP route to `createMcpHandler()` at `/mcp`. The OpenAPI file and documentation were created from that observed surface. Automated OpenAPI validation and Swagger rendering remain pending until an OpenAPI 3.2-capable validator/tooling choice is added to the project.
