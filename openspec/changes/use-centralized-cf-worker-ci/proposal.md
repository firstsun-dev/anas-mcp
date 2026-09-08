# Proposal: use centralized Cloudflare Worker CI/CD

## Why

Firstsun already maintains a reusable Cloudflare Worker pipeline in `firstsun-dev/.github`. `anas-mcp` should consume that organization-managed workflow instead of maintaining an independent deployment implementation.

Centralizing deployment behavior reduces drift in Cloudflare credentials, version deployment semantics, rollback behavior, runner conventions, and future CI improvements.

## What changes

- Make `firstsun-dev/.github/.github/workflows/_cf-worker-template.yml` the required production deployment implementation for `anas-mcp`.
- Allow `anas-mcp` to keep only a thin caller workflow containing repository-specific triggers and inputs.
- Forbid copying/forking the shared deploy steps into this repository without a new accepted OpenSpec exception.
- Document the GitHub Actions bootstrap-secret exception to the Secrets Store first runtime credential policy.
- Verify package-manager compatibility between this npm-based repository and the shared pipeline before enabling production deployment.
- Keep Cloudflare Access authentication verification as a deployment smoke concern without duplicating generic CI logic locally.

## In scope

- CI/CD ownership boundary.
- Reusable workflow contract.
- Caller-workflow responsibilities.
- Deployment credential ownership.
- Pre-deploy compatibility checks.
- Documentation and OpenSpec requirements.

## Out of scope

- Modifying `firstsun-dev/.github` in this change.
- Deploying the Worker to production.
- Provisioning Cloudflare Access, Secrets Store, Hyperdrive, or production DNS.
- Inventing unresolved production URLs or resource IDs.
- Replacing the current npm package-manager setup without a separate implementation decision if alignment is required.

## Success criteria

- Project documentation states that production Cloudflare Worker deployment must use the reusable workflow from `firstsun-dev/.github`.
- A local workflow, when added, is a thin caller only.
- Runtime credentials remain Secrets Store first; GitHub Actions holds only deployment/bootstrap credentials required by the shared pipeline.
- Shared-workflow package-manager compatibility is verified before deployment is enabled.
- No duplicate local Cloudflare deployment implementation is introduced.
