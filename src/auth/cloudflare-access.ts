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
import { JOSEError, JWKSTimeout } from "jose/errors";

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
  | { ok: false; kind: "misconfigured"; reason: string }
  /** Assertion could not be verified because the Access JWKS could not be fetched; fails closed. */
  | { ok: false; kind: "unavailable"; reason: string };

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

    // `createRemoteJWKSet`'s key getter throws when the JWKS itself could not be fetched (network error, non-200,
    // bad JSON, or a timeout) rather than when the token/claims are invalid. That is a service-availability
    // problem, not proof the caller is unauthorized, so it fails closed as 503 instead of a misleading 401.
    // `JWKSNoMatchingKey` (wrong/unknown `kid` in an otherwise-fetched JWKS) and `JWKSMultipleMatchingKeys` are
    // deliberately NOT included here: the JWKS fetch succeeded, so an unrecognized key is a verification failure
    // (unauthorized), not an availability failure.
    const isJwksUnavailable =
      error instanceof JWKSTimeout || // request timed out
      (error instanceof JOSEError && error.code === "ERR_JOSE_GENERIC") || // generic fetch/non-200/JSON-parse failure
      !(error instanceof JOSEError); // raw network error (DNS, TLS, fetch rejection) not wrapped by jose
    if (isJwksUnavailable) {
      return { ok: false, kind: "unavailable", reason: "jwks_unavailable" };
    }

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
