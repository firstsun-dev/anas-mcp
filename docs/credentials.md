# Credential policy

`anas-mcp` follows a **Secrets Store first** policy.

## Default rule

Any long-lived secret that is consumed directly by the `anas-mcp` Worker MUST be stored in Cloudflare Secrets Store and bound to the Worker from there whenever the platform supports that secret type.

Examples include:

- Google OAuth credential JSON
- OAuth client secrets owned by `anas-mcp`
- API tokens used directly by `anas-mcp`
- application signing/encryption secrets owned by `anas-mcp`
- future provider credentials consumed by this Worker

Do not use plaintext `vars`, committed configuration, `.env` files, `.dev.vars`, or source code as the production source of truth for these values.

Do not introduce `wrangler secret` / per-Worker secret storage for a production credential when Cloudflare Secrets Store can provide the same credential. A fallback requires an accepted OpenSpec change that documents why Secrets Store cannot be used.

## What is not a Secrets Store credential

### Hyperdrive database credentials

PostgreSQL credentials are owned by the Cloudflare Hyperdrive connection. The Worker consumes the `ANALYTICS_DB` Hyperdrive binding and MUST NOT duplicate the database password into Secrets Store or Worker configuration.

The PostgreSQL role used by Hyperdrive must remain read-only for the analytics schema exposed to `anas-mcp`.

### Microsoft Clarity token

`anas-mcp` does not call Microsoft Clarity directly. The Clarity API token remains owned by `firstsun-dev/windmill-flows` and MUST NOT be copied into this repository or this Worker's Secrets Store.

### Short-lived access tokens

Google OAuth access tokens and similar derived short-lived tokens are runtime artifacts, not stored credentials. They may be cached in Worker isolate memory until shortly before expiry, but MUST NOT be persisted to Secrets Store, KV, D1, logs, analytics, or source control.

### CI/deployment bootstrap credentials

A credential needed to authenticate the deployment system to Cloudflare may need to live outside Cloudflare Secrets Store because it is required before the Worker or its bindings can be accessed. Prefer workload identity/OIDC when supported. Otherwise use the CI provider's protected secret store with least privilege and document the exception.

## Non-secret configuration

The following may use Wrangler `vars` when they are not sensitive:

- GA4 property ID
- Search Console site URL
- feature flags that contain no credential material
- safe limits and defaults
- environment names

When in doubt, classify a value as secret until reviewed.

## Secret naming

Prefer names that identify application, environment, and purpose, for example:

```text
ANAS_PROD_GOOGLE_OAUTH_CREDENTIALS
ANAS_STAGING_GOOGLE_OAUTH_CREDENTIALS
ANAS_PROD_MCP_OAUTH_CLIENT_SECRET
```

Development, staging, and production credentials MUST be separate and independently rotatable.

## Runtime access

Secrets Store bindings are asynchronous. Code must retrieve the secret through the binding, validate structured values before use, and avoid logging the raw value.

For structured credentials such as Google OAuth JSON:

1. Retrieve the bound secret.
2. Parse JSON.
3. Validate required fields.
4. Exchange long-lived credential material for a short-lived provider token.
5. Keep the short-lived token only in runtime memory.
6. Redact all credential material from errors and telemetry.

## Review checklist

Before introducing any credential, answer:

1. Does `anas-mcp` consume it directly?
2. Can Cloudflare Secrets Store hold and bind it?
3. If yes, is Secrets Store the sole production source of truth?
4. If no, which platform owns it and why?
5. Is the value accidentally duplicated in GitHub Actions, Wrangler config, `.env`, Hyperdrive, or another store?
6. Is rotation possible without a source-code change?
