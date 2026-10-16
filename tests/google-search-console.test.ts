import { beforeEach, describe, expect, it, vi } from "vitest";
import { GoogleTokenProvider, resetGoogleTokenCache } from "../src/auth/google-oauth";
import {
  GoogleSearchConsoleClient,
  GscError,
  buildRequestBody,
  pacificToday,
  parseAllowedSites,
  resolveDateRange,
  resolveSite,
  shapeSearchAnalytics,
  shapeSites,
  validateSpec,
  type SearchAnalyticsSpec,
} from "../src/services/google-search-console";

const SCOPE = "https://www.googleapis.com/auth/webmasters.readonly";
const credJson = JSON.stringify({ type: "authorized_user", client_id: "cid", client_secret: "csecret", refresh_token: "rtoken" });
const SITE = "https://example.com/";
const DOMAIN = "sc-domain:example.org";
const spec: SearchAnalyticsSpec = {
  dimensions: ["query"],
  type: "web",
  dataState: "final",
  dateRange: { startDate: "2026-09-01", endDate: "2026-09-28" },
  limit: 2,
  offset: 0,
};

function setup(responses: (() => Response)[], scope: string | undefined = SCOPE, secretJson = credJson) {
  const calls: { url: string; init: RequestInit }[] = [];
  const tokenFetch = vi.fn(async () => Response.json({ access_token: `tok-${tokenFetch.mock.calls.length}`, expires_in: 3600, ...(scope ? { scope } : {}) }));
  const tokens = new GoogleTokenProvider({ secret: { get: async () => secretJson } as SecretsStoreSecret, fetchImpl: tokenFetch as never });
  const fetchImpl = vi.fn(async (url: unknown, init?: RequestInit) => {
    calls.push({ url: String(url), init: init! });
    const next = responses.shift();
    if (!next) throw new Error("unexpected fetch");
    return next();
  });
  const sleeps: number[] = [];
  const client = new GoogleSearchConsoleClient({ tokens, fetchImpl: fetchImpl as never, sleep: async (ms) => void sleeps.push(ms), timeoutMs: 50 });
  return { client, calls, sleeps, tokenFetch, fetchImpl };
}
const err = async (p: Promise<unknown>) => (await p.catch((e) => e)) as GscError;
const googleError = (status: number, body: Record<string, unknown> = {}, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify({ error: { code: status, message: "secret detail rtoken", ...body } }), { status, headers });
const queryOk = () => Response.json({ rows: [{ keys: ["a"], clicks: 3, impressions: 10, ctr: 0.3, position: 4.2 }], responseAggregationType: "byProperty" });

beforeEach(() => {
  resetGoogleTokenCache();
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("allowlist parsing and property resolution", () => {
  it("accepts URL-prefix and sc-domain identifiers exactly as given", () => {
    expect(parseAllowedSites(JSON.stringify([SITE, DOMAIN, "http://a.example.com/blog/"]))).toEqual([SITE, DOMAIN, "http://a.example.com/blog/"]);
  });
  it("fails closed on missing or malformed input", () => {
    for (const bad of [undefined, "", "  ", "not json", "{}", "[]", '"https://example.com/"', "[1]", '["example.com"]', '["https://example.com"]', '["sc-domain:"]', '["sc-domain:nodot"]', '["https://example.com/", "bad"]', '["https://exa mple.com/"]', '["https://example.com/?q=1"]']) {
      expect(parseAllowedSites(bad), String(bad)).toEqual([]);
    }
    expect(parseAllowedSites(JSON.stringify(Array.from({ length: 51 }, (_, i) => `https://h${i}.example.com/`)))).toEqual([]);
  });
  it("dedupes", () => expect(parseAllowedSites(JSON.stringify([SITE, SITE]))).toEqual([SITE]));
  it("requires exact membership and never widens a URL prefix to a domain", () => {
    const allowed = [SITE];
    expect(resolveSite(allowed, SITE)).toBe(SITE);
    for (const other of ["sc-domain:example.com", "https://example.com/blog/", "https://EXAMPLE.com/", "http://example.com/"]) {
      expect(() => resolveSite(allowed, other)).toThrow(expect.objectContaining({ code: "property_not_allowed" }));
    }
    expect(() => resolveSite(allowed, "javascript:alert(1)")).toThrow(expect.objectContaining({ code: "invalid_property" }));
    expect(() => resolveSite([], SITE)).toThrow(expect.objectContaining({ code: "configuration_missing" }));
  });
});

describe("Pacific-time dates", () => {
  const iso = (s: string) => new Date(s);
  it("defaults to the previous 28 completed Pacific days", () => {
    expect(resolveDateRange(undefined, undefined, iso("2026-10-16T12:00:00Z"))).toEqual({ startDate: "2026-09-18", endDate: "2026-10-15" });
  });
  it("uses the Pacific calendar day, not UTC or Asia/Taipei", () => {
    // 03:00Z on Oct 16 is still 20:00 PDT on Oct 15 (UTC date Oct 16, Taipei date Oct 16).
    expect(pacificToday(iso("2026-10-16T03:00:00Z"))).toBe("2026-10-15");
    expect(resolveDateRange(undefined, undefined, iso("2026-10-16T03:00:00Z")).endDate).toBe("2026-10-14");
    // 07:00Z is 00:00 PDT on Oct 16.
    expect(resolveDateRange(undefined, undefined, iso("2026-10-16T07:00:00Z")).endDate).toBe("2026-10-15");
  });
  it("is correct around the spring-forward transition (2026-03-08, 10:00Z)", () => {
    expect(pacificToday(iso("2026-03-08T09:59:00Z"))).toBe("2026-03-08"); // 01:59 PST
    expect(resolveDateRange(undefined, undefined, iso("2026-03-08T09:59:00Z")).endDate).toBe("2026-03-07");
    expect(resolveDateRange(undefined, undefined, iso("2026-03-09T06:59:00Z")).endDate).toBe("2026-03-07"); // 23:59 PDT Mar 8
    expect(resolveDateRange(undefined, undefined, iso("2026-03-09T07:00:00Z"))).toEqual({ startDate: "2026-02-09", endDate: "2026-03-08" }); // spans the transition, 28 calendar days
  });
  it("is correct around the fall-back transition (2026-11-01, 09:00Z)", () => {
    expect(resolveDateRange(undefined, undefined, iso("2026-11-01T08:30:00Z")).endDate).toBe("2026-10-31"); // 01:30 PDT
    expect(resolveDateRange(undefined, undefined, iso("2026-11-01T09:30:00Z")).endDate).toBe("2026-10-31"); // 01:30 PST (repeated hour)
    expect(resolveDateRange(undefined, undefined, iso("2026-11-02T07:59:00Z")).endDate).toBe("2026-10-31"); // 23:59 PST Nov 1
    expect(resolveDateRange(undefined, undefined, iso("2026-11-02T08:00:00Z"))).toEqual({ startDate: "2026-10-05", endDate: "2026-11-01" });
  });
  it("validates explicit dates", () => {
    expect(resolveDateRange("2026-01-01", "2026-12-31")).toEqual({ startDate: "2026-01-01", endDate: "2026-12-31" }); // 365 days
    expect(resolveDateRange("2024-01-01", "2024-12-31")).toEqual({ startDate: "2024-01-01", endDate: "2024-12-31" }); // 366 days
    for (const [s, e] of [["2026-01-01", undefined], [undefined, "2026-01-01"], ["2026-02-30", "2026-03-01"], ["2026-13-01", "2026-13-02"], ["2026-1-1", "2026-01-02"], ["2026-02-02", "2026-02-01"], ["2025-01-01", "2026-01-02"]] as const) {
      expect(() => resolveDateRange(s, e), `${s} ${e}`).toThrow(expect.objectContaining({ code: "invalid_request" }));
    }
  });
});

describe("spec validation and request body", () => {
  const bad = (over: Partial<SearchAnalyticsSpec>) => () => validateSpec({ ...spec, ...over });
  it("bounds dimensions, limit, offset, type, state and filters", () => {
    expect(bad({ dimensions: [] })).toThrow(/dimensions/);
    expect(bad({ dimensions: ["query", "page", "date", "country"] as never })).toThrow(/dimensions/);
    expect(bad({ dimensions: ["query", "query"] })).toThrow(/repeat/);
    expect(bad({ dimensions: ["hour" as never] })).toThrow(/dimension/);
    expect(bad({ type: "gopher" as never })).toThrow(/search type/);
    expect(bad({ dataState: "hourly" as never })).toThrow(/dataState/);
    expect(bad({ limit: 0 })).toThrow(/limit/);
    expect(bad({ limit: 201 })).toThrow(/limit/);
    expect(bad({ limit: 1.5 })).toThrow(/limit/);
    expect(bad({ offset: -1 })).toThrow(/offset/);
    expect(bad({ offset: 10_001 })).toThrow(/offset/);
    expect(bad({ pageFilter: { operator: "contains", expression: "x".repeat(513) } })).toThrow(/Filter/);
    expect(bad({ pageFilter: { operator: "contains", expression: "" } })).toThrow(/Filter/);
    expect(bad({ queryFilter: { operator: "contains", expression: "a\nb" } })).toThrow(/Filter/);
    expect(bad({ queryFilter: { operator: "regex" as never, expression: "a.*" } })).toThrow(/operator/);
    expect(() => validateSpec({ ...spec, dimensions: ["query", "page", "date"], limit: 200, offset: 10_000 })).not.toThrow();
  });
  it("rejects query data for discover and googleNews, allows other dimensions", () => {
    for (const type of ["discover", "googleNews"] as const) {
      expect(bad({ type })).toThrow(/query/);
      expect(bad({ type, dimensions: ["page"], queryFilter: { operator: "contains", expression: "x" } })).toThrow(/query/);
      expect(() => validateSpec({ ...spec, type, dimensions: ["page", "country"] })).not.toThrow();
    }
    for (const type of ["web", "image", "video", "news"] as const) expect(() => validateSpec({ ...spec, type })).not.toThrow();
  });
  it("builds only the fixed request shape", () => {
    expect(buildRequestBody({ ...spec, limit: 50, offset: 100 })).toEqual({
      startDate: "2026-09-01", endDate: "2026-09-28", dimensions: ["query"], type: "web", dataState: "final", aggregationType: "auto", rowLimit: 50, startRow: 100,
    });
    expect(
      buildRequestBody({
        ...spec,
        dimensions: ["page", "device"],
        pageFilter: { operator: "equals", expression: "https://example.com/a" },
        queryFilter: { operator: "contains", expression: "shoes" },
      }),
    ).toMatchObject({
      dimensions: ["page", "device"],
      dimensionFilterGroups: [{ groupType: "and", filters: [{ dimension: "page", operator: "equals", expression: "https://example.com/a" }, { dimension: "query", operator: "contains", expression: "shoes" }] }],
    });
  });
  it("groups by each approved dimension", () => {
    for (const d of ["query", "page", "date", "country", "device"] as const) expect(buildRequestBody({ ...spec, dimensions: [d] }).dimensions).toEqual([d]);
  });
});

describe("client: endpoints, encoding, scope and token reuse", () => {
  it("lists sites with GET on the fixed endpoint and read-only scope", async () => {
    const { client, calls } = setup([() => Response.json({ siteEntry: [{ siteUrl: SITE, permissionLevel: "siteOwner" }] })]);
    expect(await client.listSites()).toEqual([{ siteUrl: SITE, permissionLevel: "siteOwner" }]);
    expect(calls[0]!.url).toBe("https://www.googleapis.com/webmasters/v3/sites");
    expect(calls[0]!.init.method).toBe("GET");
    expect(calls[0]!.init.body).toBeUndefined();
  });
  it("treats a response without siteEntry as an empty list", async () => {
    const { client } = setup([() => Response.json({})]);
    expect(await client.listSites()).toEqual([]);
  });
  it("encodes the siteUrl as one path component for both property kinds", async () => {
    const { client, calls } = setup([queryOk, queryOk]);
    await client.querySearchAnalytics(SITE, spec);
    await client.querySearchAnalytics(DOMAIN, spec);
    expect(calls[0]!.url).toBe("https://www.googleapis.com/webmasters/v3/sites/https%3A%2F%2Fexample.com%2F/searchAnalytics/query");
    expect(calls[1]!.url).toBe("https://www.googleapis.com/webmasters/v3/sites/sc-domain%3Aexample.org/searchAnalytics/query");
    expect(calls[0]!.init.method).toBe("POST");
    expect(JSON.parse(String(calls[0]!.init.body))).toMatchObject({ aggregationType: "auto", rowLimit: 2, startRow: 0 });
  });
  it("refuses an invalid property or invalid spec before any token or Google call", async () => {
    const { client, fetchImpl, tokenFetch } = setup([]);
    expect((await err(client.querySearchAnalytics("https://example.com/../x?y", spec))).code).toBe("invalid_property");
    expect((await err(client.querySearchAnalytics(SITE, { ...spec, limit: 999 }))).code).toBe("invalid_request");
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(tokenFetch).not.toHaveBeenCalled();
  });
  it("reuses the cached access token across requests with the same credential", async () => {
    const { client, tokenFetch, calls } = setup([queryOk, queryOk]);
    await client.querySearchAnalytics(SITE, spec);
    await client.querySearchAnalytics(SITE, spec);
    expect(tokenFetch).toHaveBeenCalledTimes(1);
    expect((calls[1]!.init.headers as Record<string, string>).authorization).toBe("Bearer tok-1");
  });
  it("reports scope_missing with an actionable message when the token lacks webmasters.readonly", async () => {
    const { client, fetchImpl } = setup([], "https://www.googleapis.com/auth/analytics.readonly");
    const e = await err(client.listSites());
    expect(e.code).toBe("google_auth_scope_missing");
    expect(e.message).toMatch(/webmasters\.readonly/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it("reports scope_missing when the credential documents scopes without webmasters.readonly", async () => {
    const json = JSON.stringify({ ...JSON.parse(credJson), scopes: ["https://www.googleapis.com/auth/analytics.readonly"] });
    const { client } = setup([], SCOPE, json);
    expect((await err(client.listSites())).code).toBe("google_auth_scope_missing");
  });
  it("maps a 403 insufficient-scope response to google_auth_scope_missing", async () => {
    const { client } = setup([() => googleError(403, { status: "PERMISSION_DENIED", details: [{ reason: "ACCESS_TOKEN_SCOPE_INSUFFICIENT" }] })]);
    expect((await err(client.listSites())).code).toBe("google_auth_scope_missing");
  });
});

describe("client: authentication failures", () => {
  it("forces exactly one token refresh and retry after HTTP 401", async () => {
    const { client, tokenFetch, calls } = setup([() => googleError(401), queryOk]);
    expect((await client.querySearchAnalytics(SITE, spec)).rows).toHaveLength(1);
    expect(tokenFetch).toHaveBeenCalledTimes(2);
    expect(calls.map((c) => (c.init.headers as Record<string, string>).authorization)).toEqual(["Bearer tok-1", "Bearer tok-2"]);
  });
  it("fails with google_auth_invalid when the refreshed token is also rejected (no third attempt)", async () => {
    const { client, tokenFetch, calls } = setup([() => googleError(401), () => googleError(401)]);
    expect((await err(client.querySearchAnalytics(SITE, spec))).code).toBe("google_auth_invalid");
    expect(tokenFetch).toHaveBeenCalledTimes(2);
    expect(calls).toHaveLength(2);
  });
  it("reports a revoked or expired refresh token", async () => {
    const calls: unknown[] = [];
    const tokens = new GoogleTokenProvider({
      secret: { get: async () => credJson } as SecretsStoreSecret,
      fetchImpl: (async () => new Response(JSON.stringify({ error: "invalid_grant", error_description: "Token has been expired or revoked." }), { status: 400 })) as never,
    });
    const client = new GoogleSearchConsoleClient({ tokens, fetchImpl: (async (...a: unknown[]) => void calls.push(a)) as never });
    const e = await err(client.listSites());
    expect(e.code).toBe("google_auth_revoked");
    expect(JSON.stringify(e)).not.toMatch(/rtoken|csecret/);
    expect(calls).toHaveLength(0);
  });
  it("reports a missing credential without calling Google", async () => {
    const tokens = new GoogleTokenProvider({ secret: undefined });
    const fetchImpl = vi.fn();
    const client = new GoogleSearchConsoleClient({ tokens, fetchImpl: fetchImpl as never });
    expect((await err(client.listSites())).code).toBe("google_auth_not_configured");
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("client: provider errors, retries and limits", () => {
  it("distinguishes permission denied from API disabled", async () => {
    expect((await err(setup([() => googleError(403, { status: "PERMISSION_DENIED", errors: [{ reason: "forbidden" }] })]).client.listSites())).code).toBe("permission_denied");
    expect((await err(setup([() => googleError(403, { errors: [{ reason: "accessNotConfigured" }] })]).client.listSites())).code).toBe("api_disabled");
    expect((await err(setup([() => googleError(403, { details: [{ reason: "SERVICE_DISABLED" }] })]).client.listSites())).code).toBe("api_disabled");
    expect((await err(setup([() => googleError(404)]).client.querySearchAnalytics(SITE, spec))).code).toBe("permission_denied");
  });
  it("maps 400 to invalid_request without echoing Google text", async () => {
    const e = await err(setup([() => googleError(400, { status: "INVALID_ARGUMENT" })]).client.querySearchAnalytics(SITE, spec));
    expect(e.code).toBe("invalid_request");
    expect(e.message).not.toMatch(/secret detail|rtoken/);
  });
  it("distinguishes quota exhaustion from rate limiting and never retries quota", async () => {
    const quota = setup([() => googleError(403, { errors: [{ reason: "quotaExceeded" }] })]);
    expect((await err(quota.client.listSites())).code).toBe("quota_exceeded");
    expect(quota.calls).toHaveLength(1);
    const daily = setup([() => googleError(429, { status: "RESOURCE_EXHAUSTED" }, { "retry-after": "1" })]);
    expect((await err(daily.client.listSites())).code).toBe("quota_exceeded");
    const rate = setup([() => googleError(403, { errors: [{ reason: "rateLimitExceeded" }] })]);
    expect((await err(rate.client.listSites())).code).toBe("rate_limited");
    const bare429 = setup([() => googleError(429)]);
    expect((await err(bare429.client.listSites())).code).toBe("rate_limited");
  });
  it("honors a short Retry-After on rate limiting, then surfaces it; long waits are not slept", async () => {
    const retried = setup([() => googleError(429, {}, { "retry-after": "2" }), queryOk]);
    expect((await retried.client.querySearchAnalytics(SITE, spec)).rows).toHaveLength(1);
    expect(retried.sleeps).toEqual([2000]);
    const exhausted = setup([() => googleError(429, {}, { "retry-after": "1" }), () => googleError(429, {}, { "retry-after": "1" }), () => googleError(429, {}, { "retry-after": "1" })]);
    const e = await err(exhausted.client.listSites());
    expect(e.code).toBe("rate_limited");
    expect(e.retryAfterSeconds).toBe(1);
    expect(exhausted.calls).toHaveLength(3);
    const long = setup([() => googleError(429, {}, { "retry-after": "120" })]);
    const le = await err(long.client.listSites());
    expect(le.retryAfterSeconds).toBe(120);
    expect(long.sleeps).toEqual([]);
  });
  it("honors a 5xx Retry-After exactly when within budget (2 s and 5 s), never shortening it", async () => {
    for (const seconds of [2, 5]) {
      const t = setup([() => googleError(503, {}, { "retry-after": String(seconds) }), queryOk]);
      expect((await t.client.querySearchAnalytics(SITE, spec)).rows).toHaveLength(1);
      expect(t.sleeps).toEqual([seconds * 1000]);
      expect(t.calls).toHaveLength(2);
    }
  });
  it("does not retry or sleep for a 5xx Retry-After of 120 s and surfaces retryAfterSeconds", async () => {
    const t = setup([() => googleError(503, {}, { "retry-after": "120" }), queryOk]);
    const e = await err(t.client.querySearchAnalytics(SITE, spec));
    expect(e.code).toBe("provider_unavailable");
    expect(e.retryAfterSeconds).toBe(120);
    expect(t.sleeps).toEqual([]);
    expect(t.calls).toHaveLength(1);
    // Also after an earlier in-budget retry: still no early retry.
    const later = setup([() => googleError(503), () => googleError(503, {}, { "retry-after": "120" }), queryOk]);
    const e2 = await err(later.client.querySearchAnalytics(SITE, spec));
    expect(e2.retryAfterSeconds).toBe(120);
    expect(later.sleeps).toEqual([200]);
    expect(later.calls).toHaveLength(2);
  });
  it("keeps the retry cap with Retry-After and does not treat quota as a transient failure", async () => {
    const t = setup([() => googleError(503, {}, { "retry-after": "1" }), () => googleError(503, {}, { "retry-after": "1" }), () => googleError(503, {}, { "retry-after": "1" })]);
    const e = await err(t.client.listSites());
    expect(e.code).toBe("provider_unavailable");
    expect(t.calls).toHaveLength(3);
    expect(t.sleeps).toEqual([1000, 1000]);
    expect((await err(setup([() => googleError(403, { errors: [{ reason: "quotaExceeded" }] }, { "retry-after": "1" })]).client.listSites())).code).toBe("quota_exceeded");
  });
  it("retries transient 5xx with bounded attempts", async () => {
    const ok = setup([() => googleError(503), () => googleError(500), queryOk]);
    expect((await ok.client.querySearchAnalytics(SITE, spec)).rows).toHaveLength(1);
    expect(ok.sleeps).toEqual([200, 400]);
    const down = setup([() => googleError(503), () => googleError(503), () => googleError(503)]);
    expect((await err(down.client.listSites())).code).toBe("provider_unavailable");
    expect(down.calls).toHaveLength(3);
  });
  it("reports timeouts distinctly after bounded retries", async () => {
    const hang = () => new Promise<Response>(() => {});
    const tokens = new GoogleTokenProvider({ secret: { get: async () => credJson } as SecretsStoreSecret, fetchImpl: (async () => Response.json({ access_token: "t", expires_in: 3600, scope: SCOPE })) as never });
    let n = 0;
    const client = new GoogleSearchConsoleClient({
      tokens,
      timeoutMs: 20,
      sleep: async () => {},
      fetchImpl: ((_u: unknown, init: RequestInit) => {
        n++;
        return new Promise((_r, reject) => init.signal!.addEventListener("abort", () => reject(init.signal!.reason)));
      }) as never,
    });
    void hang;
    expect((await err(client.listSites())).code).toBe("timeout");
    expect(n).toBe(3);
  });
  it("reports network failures as provider_unavailable", async () => {
    const tokens = new GoogleTokenProvider({ secret: { get: async () => credJson } as SecretsStoreSecret, fetchImpl: (async () => Response.json({ access_token: "t", expires_in: 3600, scope: SCOPE })) as never });
    const client = new GoogleSearchConsoleClient({ tokens, sleep: async () => {}, fetchImpl: (async () => { throw new TypeError("boom"); }) as never });
    expect((await err(client.listSites())).code).toBe("provider_unavailable");
  });
  it("rejects rows whose keys do not match the requested dimensions (missing, too few, too many)", async () => {
    const two = { ...spec, dimensions: ["query", "page"] as const };
    const bad: unknown[][] = [
      [{ clicks: 1 }], // keys missing
      [{ keys: [], clicks: 1 }],
      [{ keys: ["only-one"], clicks: 1 }], // too few
      [{ keys: ["a", "b", "c"], clicks: 1 }], // too many
      [{ keys: ["a", "b"], clicks: 1 }, { keys: ["a"], clicks: 1 }], // one bad row among valid rows
    ];
    for (const rows of bad) {
      const e = await err(setup([() => Response.json({ rows })]).client.querySearchAnalytics(SITE, two));
      expect(e.code, JSON.stringify(rows)).toBe("malformed_response");
      expect(e.message).not.toMatch(/only-one|"a"/);
    }
    expect((await err(setup([() => Response.json({ rows: [{ keys: ["a", "b"] }] })]).client.querySearchAnalytics(SITE, spec))).code).toBe("malformed_response"); // too many for one dimension
  });
  it("accepts valid multi-dimensional rows exactly, empty results, and null metrics", async () => {
    const three = { ...spec, dimensions: ["query", "page", "country"] as const };
    const rows = [{ keys: ["Blue  Shoes ", "https://example.com/a?x=1", "usa"], clicks: 2, impressions: 9, ctr: 0.2222, position: 5 }, { keys: ["", "https://example.com/b", "twn"] }];
    const r = await setup([() => Response.json({ rows })]).client.querySearchAnalytics(SITE, three);
    const shaped = shapeSearchAnalytics(SITE, three, r);
    expect(shaped.rows).toEqual([
      { dimensions: { query: "Blue  Shoes ", page: "https://example.com/a?x=1", country: "usa" }, clicks: 2, impressions: 9, ctr: 0.2222, position: 5 },
      { dimensions: { query: "", page: "https://example.com/b", country: "twn" }, clicks: null, impressions: null, ctr: null, position: null },
    ]);
    expect((await setup([() => Response.json({})]).client.querySearchAnalytics(SITE, three)).rows).toEqual([]);
    expect((await setup([() => Response.json({ rows: [] })]).client.querySearchAnalytics(SITE, three)).rows).toEqual([]);
  });
  it("rejects malformed and oversized responses", async () => {
    expect((await err(setup([() => new Response("<html>")]).client.listSites())).code).toBe("malformed_response");
    expect((await err(setup([() => Response.json({ rows: [{ keys: [1], clicks: "many" }] })]).client.querySearchAnalytics(SITE, spec))).code).toBe("malformed_response");
    expect((await err(setup([() => Response.json({ siteEntry: [{ siteUrl: 5 }] })]).client.listSites())).code).toBe("malformed_response");
    const big = new Response(JSON.stringify({ rows: [], pad: "x".repeat(2 * 1024 * 1024 + 10) }));
    expect((await err(setup([() => big]).client.querySearchAnalytics(SITE, spec))).code).toBe("response_too_large");
  });
  it("never logs queries, sites, tokens or bodies", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await err(setup([() => googleError(500), () => googleError(500), () => googleError(500)]).client.querySearchAnalytics(SITE, { ...spec, queryFilter: { operator: "contains", expression: "secret-query" } }));
    const logged = warn.mock.calls.flat().join("\n");
    expect(logged).toContain("gsc_request");
    expect(logged).not.toMatch(/secret-query|example\.com|tok-|rtoken|csecret|secret detail/);
  });
});

describe("shaping", () => {
  it("intersects with the allowlist, preserves permission levels and orders deterministically", () => {
    const shaped = shapeSites(
      [SITE, DOMAIN, "https://missing.example.com/"],
      [
        { siteUrl: "https://secret.example.net/", permissionLevel: "siteOwner" },
        { siteUrl: SITE, permissionLevel: "siteFullUser" },
        { siteUrl: DOMAIN, permissionLevel: "siteUnverifiedUser" },
      ],
    );
    expect(shaped).toMatchObject({
      sites: [
        { siteUrl: SITE, permissionLevel: "siteFullUser", queryable: true },
        { siteUrl: DOMAIN, permissionLevel: "siteUnverifiedUser", queryable: false },
      ],
      count: 2,
      approvedButNotAccessible: ["https://missing.example.com/"],
      source: "google-search-console",
    });
    expect(JSON.stringify(shaped)).not.toContain("secret.example.net");
    expect(shapeSites([SITE], [])).toMatchObject({ sites: [], count: 0, approvedButNotAccessible: [SITE] });
  });
  it("preserves ctr/position exactly, keeps absent metrics null and invents no totals", () => {
    const shaped = shapeSearchAnalytics(SITE, { ...spec, dimensions: ["query", "device"], limit: 3 }, {
      rows: [
        { keys: ["a", "MOBILE"], clicks: 0, impressions: 12, ctr: 0, position: 7.123456789 },
        { keys: ["b", "DESKTOP"], clicks: 5, impressions: 40, ctr: 0.125, position: 1 },
      ],
      responseAggregationType: "byProperty",
      metadata: { first_incomplete_date: "2026-09-27" },
    });
    expect(shaped.rows).toEqual([
      { dimensions: { query: "a", device: "MOBILE" }, clicks: 0, impressions: 12, ctr: 0, position: 7.123456789 },
      { dimensions: { query: "b", device: "DESKTOP" }, clicks: 5, impressions: 40, ctr: 0.125, position: 1 },
    ]);
    expect(shaped.responseAggregationType).toBe("byProperty");
    expect(shaped.metadata).toEqual({ first_incomplete_date: "2026-09-27" });
    expect(shaped.dateRange).toEqual({ startDate: "2026-09-01", endDate: "2026-09-28", timeZone: "America/Los_Angeles" });
    expect(shaped.pagination).toEqual({ limit: 3, offset: 0, nextOffset: null, hasMorePossible: false });
    expect(Object.keys(shaped)).not.toEqual(expect.arrayContaining(["rowCount", "totalRows", "totals"]));
    const missing = shapeSearchAnalytics(SITE, spec, { rows: [{ keys: ["x"] }] });
    expect(missing.rows[0]).toEqual({ dimensions: { query: "x" }, clicks: null, impressions: null, ctr: null, position: null });
    expect(missing.responseAggregationType).toBeNull();
    expect(missing.metadata).toEqual({});
  });
  it("an empty response is empty, not zero-filled; a full page is only advisory 'maybe more'", () => {
    const empty = shapeSearchAnalytics(SITE, spec, { rows: [] });
    expect(empty.rows).toEqual([]);
    expect(empty.returnedRowCount).toBe(0);
    expect(empty.pagination.hasMorePossible).toBe(false);
    const full = shapeSearchAnalytics(SITE, { ...spec, limit: 2, offset: 4 }, { rows: [{ keys: ["a"] }, { keys: ["b"] }] });
    expect(full.pagination).toEqual({ limit: 2, offset: 4, nextOffset: 6, hasMorePossible: true });
    expect(full.note).toMatch(/advisory/);
    expect(full.note).toMatch(/anonymized/);
  });
});
