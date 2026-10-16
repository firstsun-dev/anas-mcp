import { z } from "zod";

/**
 * Shared Google OAuth token provider (GA4 now, Search Console in Phase 3).
 *
 * Google API authorization is separate from Cloudflare Access authentication of MCP clients: this module never sees or
 * validates `Cf-Access-Jwt-Assertion`. The only credential is ONE `authorized_user` JSON read from the Secrets Store
 * binding; short-lived access tokens live only in isolate memory and are never persisted or logged.
 */

/** Fixed official endpoint. Never taken from tool input or configuration. */
export const GOOGLE_TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";

export const GOOGLE_SCOPES = {
  analyticsReadonly: "https://www.googleapis.com/auth/analytics.readonly",
  searchConsoleReadonly: "https://www.googleapis.com/auth/webmasters.readonly",
} as const;
const APPROVED_SCOPES: readonly string[] = Object.values(GOOGLE_SCOPES);

const TOKEN_TIMEOUT_MS = 10_000;
/** Refresh this long before Google's reported expiry. */
const EXPIRY_SKEW_MS = 60_000;

export type GoogleAuthErrorCode =
  | "credentials_not_configured"
  | "credentials_invalid"
  | "authorization_revoked"
  | "credentials_rejected"
  | "scope_missing"
  | "unavailable";

const MESSAGES: Record<GoogleAuthErrorCode, string> = {
  credentials_not_configured: "The Google credential binding is not configured.",
  credentials_invalid: "The stored Google credential is malformed or outside the approved read-only scope contract.",
  authorization_revoked: "Google authorization was revoked or expired (invalid_grant). The operator must re-authorize and rotate the credential.",
  credentials_rejected: "Google rejected the stored OAuth client credential. The operator must check the credential.",
  scope_missing: "The Google authorization does not include the required read-only scope.",
  unavailable: "Google authentication is temporarily unavailable. Retry later.",
};

/** Carries only a fixed code and message; never credential material, response bodies, or tokens. */
export class GoogleAuthError extends Error {
  constructor(readonly code: GoogleAuthErrorCode) {
    super(MESSAGES[code]);
    this.name = "GoogleAuthError";
  }
}

/** Documented shape (see docs/ga4.md); no values are ever committed. */
export const googleCredentialSchema = z.object({
  type: z.literal("authorized_user"),
  client_id: z.string().min(1),
  client_secret: z.string().min(1),
  refresh_token: z.string().min(1),
  /** Optional documentation of what the operator authorized; must be a subset of the approved read-only scopes. */
  scopes: z.array(z.enum(APPROVED_SCOPES as [string, ...string[]])).min(1).optional(),
});
export type GoogleCredential = z.infer<typeof googleCredentialSchema>;

const tokenResponseSchema = z.object({
  access_token: z.string().min(1),
  expires_in: z.number().positive(),
  token_type: z.string().optional(),
  scope: z.string().optional(),
});

interface CachedToken {
  accessToken: string;
  expiresAt: number;
  scopes: string[];
}

// Module-level (per isolate) so the cache survives the per-request createServer(); keyed by credential fingerprint so a
// rotated credential never reuses the old token. Both maps hold at most a few entries.
const tokenCache = new Map<string, CachedToken>();
const inflight = new Map<string, Promise<CachedToken>>();

export interface GoogleTokenProviderOptions {
  /** Secrets Store binding (asynchronous `get()`); undefined means not configured. */
  secret: SecretsStoreSecret | undefined;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

async function fingerprint(raw: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(raw));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

export class GoogleTokenProvider {
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;

  constructor(private readonly options: GoogleTokenProviderOptions) {
    this.fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init));
    this.now = options.now ?? Date.now;
  }

  get configured(): boolean {
    return this.options.secret !== undefined;
  }

  /**
   * Returns a valid access token carrying `requiredScope`. The secret is re-read on every call (cheap, async binding)
   * so rotation takes effect immediately. `forceRefresh` discards the cached token (used after an upstream 401).
   */
  async getAccessToken(requiredScope: string, forceRefresh = false): Promise<string> {
    const { raw, credential } = await this.readCredential();
    if (credential.scopes && !credential.scopes.includes(requiredScope)) throw new GoogleAuthError("scope_missing");
    const key = await fingerprint(raw);
    // A rotated credential invalidates every other cached entry.
    for (const k of tokenCache.keys()) if (k !== key) tokenCache.delete(k);

    if (forceRefresh) tokenCache.delete(key);
    const cached = tokenCache.get(key);
    if (cached && cached.expiresAt - EXPIRY_SKEW_MS > this.now()) return this.checkScope(cached, requiredScope);

    let pending = inflight.get(key);
    if (!pending) {
      pending = this.refresh(credential).finally(() => inflight.delete(key));
      inflight.set(key, pending);
    }
    const fresh = await pending;
    tokenCache.set(key, fresh);
    return this.checkScope(fresh, requiredScope);
  }

  private checkScope(token: CachedToken, requiredScope: string): string {
    // Google omits `scope` only for unrestricted grants; when present it must contain the required scope.
    if (token.scopes.length > 0 && !token.scopes.includes(requiredScope)) throw new GoogleAuthError("scope_missing");
    return token.accessToken;
  }

  private async readCredential(): Promise<{ raw: string; credential: GoogleCredential }> {
    if (!this.options.secret) throw new GoogleAuthError("credentials_not_configured");
    let raw: string;
    try {
      raw = await this.options.secret.get();
    } catch {
      // Missing secret or Secrets Store outage: fail closed without echoing the platform error.
      throw new GoogleAuthError("credentials_not_configured");
    }
    if (typeof raw !== "string" || raw.trim() === "") throw new GoogleAuthError("credentials_not_configured");
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new GoogleAuthError("credentials_invalid");
    }
    const result = googleCredentialSchema.safeParse(parsed);
    if (!result.success) throw new GoogleAuthError("credentials_invalid");
    return { raw, credential: result.data };
  }

  private async refresh(credential: GoogleCredential): Promise<CachedToken> {
    let response: Response;
    try {
      response = await this.fetchImpl(GOOGLE_TOKEN_ENDPOINT, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
        // No `scope` parameter: a refresh-token grant can only return the scopes the operator already authorized.
        body: new URLSearchParams({
          grant_type: "refresh_token",
          client_id: credential.client_id,
          client_secret: credential.client_secret,
          refresh_token: credential.refresh_token,
        }),
        signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS),
      });
    } catch {
      console.warn(JSON.stringify({ event: "google_token_refresh_failed", reason: "network" }));
      throw new GoogleAuthError("unavailable");
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      body = undefined;
    }

    if (!response.ok) {
      const error = typeof (body as { error?: unknown } | undefined)?.error === "string" ? (body as { error: string }).error : "";
      let code: GoogleAuthErrorCode;
      if (error === "invalid_grant") code = "authorization_revoked";
      else if (response.status === 429 || response.status >= 500) code = "unavailable";
      else code = "credentials_rejected";
      // Fixed reason code and HTTP status only; never the body.
      console.warn(JSON.stringify({ event: "google_token_refresh_failed", reason: code, status: response.status }));
      throw new GoogleAuthError(code);
    }

    const parsed = tokenResponseSchema.safeParse(body);
    if (!parsed.success) {
      console.warn(JSON.stringify({ event: "google_token_refresh_failed", reason: "malformed_response" }));
      throw new GoogleAuthError("unavailable");
    }
    return {
      accessToken: parsed.data.access_token,
      expiresAt: this.now() + parsed.data.expires_in * 1000,
      scopes: parsed.data.scope ? parsed.data.scope.split(/\s+/).filter(Boolean) : [],
    };
  }
}

/** Test helper: the cache is deliberately module-level, so tests reset it between cases. */
export function resetGoogleTokenCache(): void {
  tokenCache.clear();
  inflight.clear();
}
