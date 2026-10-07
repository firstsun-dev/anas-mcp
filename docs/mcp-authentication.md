# MCP authentication (concurrent Cloudflare Access OAuth + Service Token)

Decision: `openspec/changes/support-dual-access-auth/`. This supersedes the Worker-local bearer API key (`openspec/changes/use-mcp-api-key-auth/`, historical) and the OAuth-only `add-cloudflare-access-auth` design (historical).

```text
Mode A  ChatGPT / OAuth-capable client --Managed OAuth (auth code + PKCE)--+
Mode B  Agent / CI / automation --CF-Access-Client-Id + -Secret------------+
                                                                          v
                                          Cloudflare Access (one application, https://mcp.firstsun.org/mcp)
                                                                          | Cf-Access-Jwt-Assertion
                                                                          v
                                          Worker anas-mcp: verify assertion (src/auth/cloudflare-access.ts)
                                                                          v
                                          createMcpHandler() -> read-only tools
```

Mode A and Mode B are enabled **at the same time** on the same Access application and the same `/mcp` URL. This is not a feature flag, a fallback chain, or two endpoints. Cloudflare Access looks at each request's credentials and applies the matching policy:

| Mode | Client | Credential | Access policy |
| --- | --- | --- | --- |
| A | ChatGPT, MCP Inspector, other OAuth clients | Managed OAuth (discovery, auth code + PKCE) | identity `Allow` (default deny) |
| B | Headless agents, CI, automation | `CF-Access-Client-Id` + `CF-Access-Client-Secret` | `Service Auth` for approved Service Tokens |

Cloudflare configuration (custom domain, Access application, Managed OAuth, policies, Service Tokens) is owned by `firstsun-dev/infra-config` (issue #59) and Terraform-managed. This repository does not create or change any of it.

## Worker behavior

- Every request except `GET /health` is checked **before** MCP initialization, `createServer()`, or any tool or database (Hyperdrive/PostgreSQL) access.
- The Worker reads `Cf-Access-Jwt-Assertion` and verifies, with `jose`: RS256 signature against the team JWKS (`https://<team>.cloudflareaccess.com/cdn-cgi/access/certs`), issuer `https://<team>.cloudflareaccess.com`, application AUD, `exp`, and `nbf` (5 s clock tolerance). `exp`, `iss`, and `aud` are required claims; other algorithms (including `none`) are rejected.
- The Worker does **not** try to tell OAuth from Service Token. Both arrive as the same Access assertion. It never reads `Authorization`, `CF-Access-Client-Id`, or `CF-Access-Client-Secret`.
- Missing or invalid assertion: `401 {"error":"unauthorized"}` (identical for every cause).
- Missing or invalid Worker configuration (`ACCESS_TEAM_DOMAIN`, `ACCESS_AUD`): `503 {"error":"auth_unavailable"}`. The Worker fails closed rather than skipping validation.
- Rejections log only `{"event":"access_rejected","reason":"<fixed code>"}` (for example `missing_assertion`, `ERR_JWT_EXPIRED`). Assertions, tokens, headers, claims, and the AUD are never logged or returned.
- `GET /health` is public and returns only `{"service":"anas-mcp","status":"ok"}`. Access protects `/mcp` only.

## Worker configuration (non-secret)

`wrangler.jsonc` `vars`:

| Var | Value |
| --- | --- |
| `ACCESS_TEAM_DOMAIN` | `<team>.cloudflareaccess.com` (infra-config output `anas_mcp_access_team_domain`) |
| `ACCESS_AUD` | Access application AUD tag (infra-config output `anas_mcp_access_aud`) |

Both are identifiers, not credentials. They are empty in source until the Access application exists; deploying a Worker with empty values makes `/mcp` return `503`. Fill them as part of the coordinated rollout (see `docs/cloudflare-access.md`). No Secrets Store binding or Worker secret is used for authentication.

## Client setup

### Mode A: Managed OAuth

Point the client at `https://mcp.firstsun.org/mcp`. OAuth discovery, dynamic client registration, authorization, and tokens are served by Cloudflare Access; the user logs in with the approved identity provider. The Worker implements no OAuth endpoints and stores no OAuth state.

### Mode B: Service Token

Send both headers on every request:

```http
CF-Access-Client-Id: <CLIENT_ID>
CF-Access-Client-Secret: <CLIENT_SECRET>
```

The Client Secret belongs to the machine client's operator secret manager. It is never stored in this repository, in Worker configuration, or in the Worker Secrets Store. Service Tokens are machine identities, not users.

Single-header agents are only supported if a target client actually needs it (Access `read_service_tokens_from_header` with a dedicated header, never `Authorization`). See `openspec/changes/support-dual-access-auth/design.md`.

## Local development

Production `/mcp` requires an Access assertion, which only Cloudflare Access can mint. For local work:

- the test suite signs assertions with a locally generated RSA key and injects a local JWKS (`tests/helpers.ts`); no real credentials are involved;
- `wrangler dev` has no Access in front of it. To exercise `/mcp` by hand you must supply your own test assertion signed by a key you also serve as JWKS, which is what the tests do. Do not weaken the Worker or add an auth bypass for development.

## Not substitutes

`CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, Bing/Google/Clarity credentials, PostgreSQL/Hyperdrive credentials, and CI deployment tokens must never be used for MCP authentication. Do not accept credentials via query string, and do not rely on IP allowlisting or User-Agent checks.
