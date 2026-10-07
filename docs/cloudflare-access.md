# Cloudflare Access authentication (superseded)

> **Superseded (2026-10-07).** `anas-mcp` does **not** use Cloudflare Access Managed OAuth. Production `/mcp` authentication is a dedicated bearer API key stored in Cloudflare Secrets Store: see `docs/mcp-authentication.md` and `openspec/changes/use-mcp-api-key-auth/`.

The earlier Access Managed OAuth rationale is retained only in `openspec/changes/add-cloudflare-access-auth/`. Revisit Access/OAuth only through a new accepted OpenSpec change, e.g. when multiple independently authorized users, per-user revocation/audit, SSO, or per-tool authorization are required.
