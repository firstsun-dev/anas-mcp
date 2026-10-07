/**
 * Cloudflare Access origin validation for `/mcp`.
 *
 * Both production auth modes (Managed OAuth and Access Service Token) terminate at Cloudflare Access, which then
 * forwards the request with a signed application assertion in `Cf-Access-Jwt-Assertion`. The Worker never inspects
 * raw OAuth bearer tokens or Service Token headers: it only verifies that assertion (signature via the team JWKS,
 * issuer, application AUD, exp/nbf) before any MCP, tool, or database code runs.
 *
 * The assertion, JWKS material, and expected AUD must never be logged or echoed in a response.
 */
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";

export const ACCESS_ASSERTION_HEADER = "cf-access-jwt-assertion";

export interface AccessConfig {
  /** Cloudflare Zero Trust team domain, e.g. `<team>.cloudflareaccess.com` (non-secret). */
  teamDomain?: string;
  /** Audience (AUD) tag of the Access application protecting `/mcp` (non-secret). */
  audience?: string;
}

export type AccessResult =
  | { ok: true }
  /** Missing/invalid assertion. `reason` is a fixed, non-sensitive code safe to log. */
  | { ok: false; kind: "unauthorized"; reason: string }
  /** Worker is not configured to validate assertions; fails closed. */
  | { ok: false; kind: "misconfigured"; reason: string };

const TEAM_DOMAIN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.cloudflareaccess\.com$/i;
/** Small allowance for clock skew between Cloudflare and the Worker isolate, in seconds. */
const CLOCK_TOLERANCE_SECONDS = 5;

const remoteKeySets = new Map<string, JWTVerifyGetKey>();

/** Cached remote JWKS per team domain. jose caches keys and refreshes on unknown `kid`. */
function remoteKeySet(host: string): JWTVerifyGetKey {
  let keys = remoteKeySets.get(host);
  if (!keys) {
    keys = createRemoteJWKSet(new URL(`https://${host}/cdn-cgi/access/certs`));
    remoteKeySets.set(host, keys);
  }
  return keys;
}

/**
 * Verify the Access assertion on a request. `getKey` is injectable so tests use locally generated signing keys;
 * production uses the team's remote JWKS.
 */
export async function verifyAccessAssertion(
  request: Request,
  config: AccessConfig,
  getKey?: JWTVerifyGetKey,
): Promise<AccessResult> {
  const host = config.teamDomain?.trim().toLowerCase();
  const audience = config.audience?.trim();
  if (!host || !TEAM_DOMAIN.test(host) || !audience) {
    return { ok: false, kind: "misconfigured", reason: "access_not_configured" };
  }

  const assertion = request.headers.get(ACCESS_ASSERTION_HEADER)?.trim();
  if (!assertion) return { ok: false, kind: "unauthorized", reason: "missing_assertion" };

  try {
    await jwtVerify(assertion, getKey ?? remoteKeySet(host), {
      issuer: `https://${host}`,
      audience,
      algorithms: ["RS256"],
      requiredClaims: ["exp", "iss", "aud"],
      clockTolerance: CLOCK_TOLERANCE_SECONDS,
    });
    return { ok: true };
  } catch (error) {
    // Only jose's stable error code is surfaced; never the token, claims, or key material.
    const code = typeof (error as { code?: unknown })?.code === "string" ? (error as { code: string }).code : "verification_failed";
    return { ok: false, kind: "unauthorized", reason: code };
  }
}

/** Generic 401. Identical for every failure cause so it reveals nothing about the assertion or Access policy. */
export function unauthorizedResponse(): Response {
  return new Response(JSON.stringify({ error: "unauthorized" }), {
    status: 401,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

/** Generic 503 for a Worker that cannot validate Access assertions (missing/invalid non-secret config). */
export function authUnavailableResponse(): Response {
  return new Response(JSON.stringify({ error: "auth_unavailable" }), {
    status: 503,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}
