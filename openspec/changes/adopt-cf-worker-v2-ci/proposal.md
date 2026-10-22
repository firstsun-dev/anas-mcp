# Proposal: adopt Cloudflare Worker CI/CD v2 (production-only)

Issue: firstsun-dev/anas-mcp#32. Supersedes the caller details of `use-centralized-cf-worker-ci` (v1 `_cf-worker-template.yml@v1.5.0`); the central-ownership decision stands.

## Why
The organization moves Cloudflare Worker repositories to `_cf-worker-v2.yml` (parallel CI jobs, one delivery engine, audited config, SHA-pinned tooling).

## What
- `cicd.yml` calls `firstsun-dev/.github/.github/workflows/_cf-worker-v2.yml@3cf1d52891f04cde737af10ea303f9b7d6b2e6ef` with `tools_ref` set to the same SHA.
- `deployment_strategy: production-only`; no Native Preview, Shared Dev or persistent Dev; no Preview/Dev credentials.
- `pr-verify.yml` is removed (duplicated by the shared CI jobs, which run on every branch push).
- Cloudflare Access protection, `workers_dev:false`/`preview_urls:false`, bindings and the unauthenticated production smoke script are unchanged; `production_rollback_policy: manual`.

## Out of scope / non-goals
Changing the shared repository, Cloudflare infrastructure, or Worker behaviour.
