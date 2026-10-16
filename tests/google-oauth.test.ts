import { beforeEach, describe, expect, it, vi } from "vitest";
import { GOOGLE_SCOPES, GOOGLE_TOKEN_ENDPOINT, GoogleAuthError, GoogleTokenProvider, resetGoogleTokenCache } from "../src/auth/google-oauth";

const SCOPE = GOOGLE_SCOPES.analyticsReadonly;
const cred = (over: Record<string, unknown> = {}) =>
  JSON.stringify({ type: "authorized_user", client_id: "test-client-id", client_secret: "test-client-secret", refresh_token: "test-refresh-token", ...over });
const secret = (value: string | (() => Promise<string>)): SecretsStoreSecret => ({ get: typeof value === "string" ? async () => value : value }) as SecretsStoreSecret;
const tokenResponse = (token = "access-1", extra: Record<string, unknown> = {}) =>
  Response.json({ access_token: token, expires_in: 3600, token_type: "Bearer", scope: SCOPE, ...extra });

function setup(s: SecretsStoreSecret | undefined, responses: (() => Response | Promise<Response>)[] = []) {
  const fetchImpl = vi.fn(async (_url: unknown, _init?: RequestInit) => {
    const next = responses.shift();
    if (!next) throw new Error("unexpected fetch");
    return next();
  });
  let now = 1_000_000;
  const provider = new GoogleTokenProvider({ secret: s, fetchImpl: fetchImpl as never, now: () => now });
  return { provider, fetchImpl, advance: (ms: number) => (now += ms) };
}
const code = async (p: Promise<unknown>) => ((await p.catch((e) => e)) as GoogleAuthError).code;

beforeEach(() => resetGoogleTokenCache());

describe("GoogleTokenProvider", () => {
  it("refreshes against the fixed token endpoint with the refresh-token grant and no scope parameter", async () => {
    const { provider, fetchImpl } = setup(secret(cred()), [() => tokenResponse()]);
    expect(await provider.getAccessToken(SCOPE)).toBe("access-1");
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe(GOOGLE_TOKEN_ENDPOINT);
    const body = new URLSearchParams(String(init!.body));
    expect(Object.fromEntries(body)).toEqual({ grant_type: "refresh_token", client_id: "test-client-id", client_secret: "test-client-secret", refresh_token: "test-refresh-token" });
  });
  it("fails closed without a binding, with an unreadable/empty secret, or invalid JSON", async () => {
    for (const s of [undefined, secret(async () => { throw new Error("store down: refresh_token=leak"); }), secret(" "), secret("not json"), secret("{}"), secret(cred({ type: "service_account" })), secret(cred({ refresh_token: "" }))]) {
      const { provider, fetchImpl } = setup(s);
      const c = await code(provider.getAccessToken(SCOPE));
      expect(["credentials_not_configured", "credentials_invalid"]).toContain(c);
      expect(fetchImpl).not.toHaveBeenCalled();
    }
  });
  it("rejects scopes outside the approved read-only contract and credentials that omit the required scope", async () => {
    const { provider } = setup(secret(cred({ scopes: ["https://www.googleapis.com/auth/analytics.edit"] })));
    expect(await code(provider.getAccessToken(SCOPE))).toBe("credentials_invalid");
    const { provider: p2 } = setup(secret(cred({ scopes: [GOOGLE_SCOPES.searchConsoleReadonly] })));
    expect(await code(p2.getAccessToken(SCOPE))).toBe("scope_missing");
  });
  it("rejects a token whose granted scope lacks the required one", async () => {
    const { provider } = setup(secret(cred()), [() => tokenResponse("a", { scope: GOOGLE_SCOPES.searchConsoleReadonly })]);
    expect(await code(provider.getAccessToken(SCOPE))).toBe("scope_missing");
  });
  it("caches until shortly before expiry, then refreshes", async () => {
    const { provider, fetchImpl, advance } = setup(secret(cred()), [() => tokenResponse("a1"), () => tokenResponse("a2")]);
    expect(await provider.getAccessToken(SCOPE)).toBe("a1");
    advance(3_000_000);
    expect(await provider.getAccessToken(SCOPE)).toBe("a1");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    advance(560_000); // inside the 60 s skew of the 3600 s expiry
    expect(await provider.getAccessToken(SCOPE)).toBe("a2");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
  it("coalesces concurrent refreshes into one token request", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { provider, fetchImpl } = setup(secret(cred()), [async () => { await gate; return tokenResponse("shared"); }]);
    const all = Promise.all([1, 2, 3, 4].map(() => provider.getAccessToken(SCOPE)));
    await new Promise((r) => setTimeout(r, 5));
    release();
    expect(await all).toEqual(["shared", "shared", "shared", "shared"]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
  it("picks up a rotated credential on the next call without reusing the old token", async () => {
    let current = cred();
    const { provider, fetchImpl } = setup(secret(async () => current), [() => tokenResponse("old"), () => tokenResponse("new")]);
    expect(await provider.getAccessToken(SCOPE)).toBe("old");
    current = cred({ refresh_token: "rotated-refresh-token" });
    expect(await provider.getAccessToken(SCOPE)).toBe("new");
    expect(new URLSearchParams(String(fetchImpl.mock.calls[1]![1]!.body)).get("refresh_token")).toBe("rotated-refresh-token");
  });
  it("forceRefresh discards the cached token", async () => {
    const { provider, fetchImpl } = setup(secret(cred()), [() => tokenResponse("a1"), () => tokenResponse("a2")]);
    await provider.getAccessToken(SCOPE);
    expect(await provider.getAccessToken(SCOPE, true)).toBe("a2");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
  it.each([
    [400, { error: "invalid_grant" }, "authorization_revoked"],
    [401, { error: "invalid_client" }, "credentials_rejected"],
    [400, { error: "invalid_request" }, "credentials_rejected"],
    [429, {}, "unavailable"],
    [503, {}, "unavailable"],
  ])("maps token endpoint %i %j to %s and does not cache failure", async (status, body, expected) => {
    const { provider, fetchImpl } = setup(secret(cred()), [() => Response.json(body, { status }), () => tokenResponse("ok")]);
    expect(await code(provider.getAccessToken(SCOPE))).toBe(expected);
    expect(await provider.getAccessToken(SCOPE)).toBe("ok");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
  it("maps network failure and malformed responses to unavailable", async () => {
    const { provider } = setup(secret(cred()), [() => { throw new Error("boom"); }, () => Response.json({ nope: true })]);
    expect(await code(provider.getAccessToken(SCOPE))).toBe("unavailable");
    expect(await code(provider.getAccessToken(SCOPE))).toBe("unavailable");
  });
  it("never leaks credential material or tokens in errors or logs", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const bad = Response.json({ error: "invalid_grant", error_description: "refresh_token test-refresh-token revoked" }, { status: 400 });
    const { provider } = setup(secret(cred()), [() => bad]);
    const err = (await provider.getAccessToken(SCOPE).catch((e) => e)) as Error;
    const seen = JSON.stringify([err.message, warn.mock.calls, log.mock.calls]);
    for (const s of ["test-refresh-token", "test-client-secret", "test-client-id"]) expect(seen).not.toContain(s);
    warn.mockRestore();
    log.mockRestore();
  });
});
