import { beforeEach, describe, expect, it, vi } from "vitest";
import { GoogleTokenProvider, resetGoogleTokenCache } from "../src/auth/google-oauth";
import {
  Ga4Error,
  GoogleAnalyticsClient,
  buildRequestBody,
  parsePropertyIds,
  resolveDateRange,
  resolveProperty,
  shapeReport,
  validateSpec,
  type ReportSpec,
} from "../src/services/google-analytics";

const credJson = JSON.stringify({ type: "authorized_user", client_id: "cid", client_secret: "csecret", refresh_token: "rtoken" });
const secret = { get: async () => credJson } as SecretsStoreSecret;
const spec: ReportSpec = { dimensions: ["pagePathPlusQueryString"], metrics: ["screenPageViews", "activeUsers"], dateRange: { startDate: "2026-09-01", endDate: "2026-09-28" }, limit: 2, offset: 0 };

const report = (over: Record<string, unknown> = {}) => ({
  dimensionHeaders: [{ name: "pagePathPlusQueryString" }],
  metricHeaders: [{ name: "screenPageViews", type: "TYPE_INTEGER" }, { name: "activeUsers", type: "TYPE_INTEGER" }],
  rows: [
    { dimensionValues: [{ value: "/a?x=1" }], metricValues: [{ value: "10" }, { value: "4" }] },
    { dimensionValues: [{ value: "/a" }], metricValues: [{ value: "7" }, { value: "3" }] },
  ],
  rowCount: 5,
  metadata: { timeZone: "Asia/Taipei", currencyCode: "USD" },
  ...over,
});

function setup(responses: (() => Response)[]) {
  const calls: { url: string; init: RequestInit }[] = [];
  const tokenFetch = vi.fn(async () => Response.json({ access_token: `tok-${tokenFetch.mock.calls.length}`, expires_in: 3600, scope: "https://www.googleapis.com/auth/analytics.readonly" }));
  const tokens = new GoogleTokenProvider({ secret, fetchImpl: tokenFetch as never });
  const fetchImpl = vi.fn(async (url: unknown, init?: RequestInit) => {
    calls.push({ url: String(url), init: init! });
    const next = responses.shift();
    if (!next) throw new Error("unexpected fetch");
    return next();
  });
  const sleeps: number[] = [];
  const client = new GoogleAnalyticsClient({ tokens, fetchImpl: fetchImpl as never, sleep: async (ms) => void sleeps.push(ms), timeoutMs: 50 });
  return { client, calls, sleeps, tokenFetch };
}
const err = async (p: Promise<unknown>) => (await p.catch((e) => e)) as Ga4Error;
const googleError = (status: number, gstatus: string, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify({ error: { code: status, status: gstatus, message: "secret detail rtoken" } }), { status, headers });

beforeEach(() => {
  resetGoogleTokenCache();
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("configuration and request validation", () => {
  it("parses the property allowlist and fails closed on any malformed entry", () => {
    expect(parsePropertyIds("123, 456,123")).toEqual(["123", "456"]);
    expect(parsePropertyIds(undefined)).toEqual([]);
    expect(parsePropertyIds("")).toEqual([]);
    expect(parsePropertyIds("123,properties/456")).toEqual([]);
    expect(parsePropertyIds("123,")).toEqual([]);
  });
  it("resolves the property: single default, explicit required for several, allowlist enforced", () => {
    expect(resolveProperty(["1"], undefined)).toBe("1");
    expect(resolveProperty(["1", "2"], "2")).toBe("2");
    expect(() => resolveProperty([], "1")).toThrowError(expect.objectContaining({ code: "configuration_missing" }));
    expect(() => resolveProperty(["1", "2"], undefined)).toThrowError(expect.objectContaining({ code: "property_required" }));
    expect(() => resolveProperty(["1"], "9")).toThrowError(expect.objectContaining({ code: "property_not_allowed" }));
  });
  it("defaults dates to relative completed days and validates explicit ranges", () => {
    expect(resolveDateRange()).toEqual({ startDate: "28daysAgo", endDate: "yesterday" });
    expect(resolveDateRange("2026-01-01", "2026-12-31")).toEqual({ startDate: "2026-01-01", endDate: "2026-12-31" }); // 365 days
    for (const [s, e] of [["2026-01-01", undefined], ["2026-02-30", "2026-03-01"], ["2026-03-02", "2026-03-01"], ["2025-01-01", "2026-12-31"], ["yesterday", "yesterday"]] as const) {
      expect(() => resolveDateRange(s, e), `${s} ${e}`).toThrowError(expect.objectContaining({ code: "invalid_request" }));
    }
    expect(() => resolveDateRange("2026-01-01", "2027-01-02")).toThrow(); // 367 days inclusive
    expect(resolveDateRange("2026-01-01", "2026-12-31").endDate).toBe("2026-12-31");
  });
  it("rejects incompatible or oversized specs", () => {
    const bad = (o: Partial<ReportSpec>) => expect(() => validateSpec({ ...spec, ...o })).toThrowError(expect.objectContaining({ code: "invalid_request" }));
    bad({ dimensions: ["sessionSource", "firstUserSource"] });
    bad({ dimensions: ["country", "country"] });
    bad({ metrics: [] });
    bad({ metrics: ["sessions", "activeUsers", "totalUsers", "newUsers", "engagedSessions", "bounceRate", "eventCount", "engagementRate", "screenPageViews", "averageSessionDuration", "userEngagementDuration"] });
    bad({ dimensions: ["date", "country", "deviceCategory", "browser", "pagePath"] });
    bad({ limit: 201 });
    bad({ limit: 0 });
    bad({ offset: 10_001 });
    bad({ offset: -1 });
    bad({ dimensions: ["notADimension" as never] });
    bad({ metrics: ["notAMetric" as never] });
  });
  it("builds only the fixed body shape with deterministic ordering and a constrained prefix filter", () => {
    const body = buildRequestBody({ ...spec, pagePathPrefix: "/blog/" });
    expect(Object.keys(body).sort()).toEqual(["dateRanges", "dimensionFilter", "dimensions", "limit", "metrics", "offset", "orderBys", "returnPropertyQuota"]);
    expect(body.orderBys).toEqual([{ metric: { metricName: "screenPageViews" }, desc: true }, { dimension: { dimensionName: "pagePathPlusQueryString" } }]);
    expect(body.dimensionFilter).toEqual({ filter: { fieldName: "pagePath", stringFilter: { matchType: "BEGINS_WITH", value: "/blog/", caseSensitive: true } } });
    expect(buildRequestBody({ ...spec, dimensions: ["country", "date"] }).orderBys).toEqual([{ dimension: { dimensionName: "date" } }, { dimension: { dimensionName: "country" } }]);
  });
});

describe("GoogleAnalyticsClient", () => {
  it("POSTs to the fixed runReport URL with a bearer token and parses the report", async () => {
    const { client, calls } = setup([() => Response.json(report())]);
    const r = await client.runReport("123", spec);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://analyticsdata.googleapis.com/v1beta/properties/123:runReport");
    expect((calls[0]!.init.headers as Record<string, string>).authorization).toBe("Bearer tok-1");
    expect(JSON.parse(String(calls[0]!.init.body)).limit).toBe("2");
    expect(r.rows).toHaveLength(2);
  });
  it("refuses a non-numeric property id before any request", async () => {
    const { client, calls, tokenFetch } = setup([]);
    expect((await err(client.runReport("123/../x", spec))).code).toBe("invalid_request");
    expect(calls).toHaveLength(0);
    expect(tokenFetch).not.toHaveBeenCalled();
  });
  it("retries 5xx then succeeds; gives up as provider_unavailable", async () => {
    const a = setup([() => googleError(503, "UNAVAILABLE"), () => Response.json(report())]);
    expect((await a.client.runReport("1", spec)).rowCount).toBe(5);
    expect(a.sleeps).toEqual([200]);
    const b = setup([() => googleError(500, "INTERNAL"), () => googleError(502, "X"), () => googleError(503, "X")]);
    expect((await err(b.client.runReport("1", spec))).code).toBe("provider_unavailable");
    expect(b.calls).toHaveLength(3);
  });
  it("honors a short Retry-After on 429 and surfaces long waits as quota_exceeded", async () => {
    const a = setup([() => googleError(429, "RESOURCE_EXHAUSTED", { "retry-after": "2" }), () => Response.json(report())]);
    await a.client.runReport("1", spec);
    expect(a.sleeps).toEqual([2000]);
    const b = setup([() => googleError(429, "RESOURCE_EXHAUSTED", { "retry-after": "3600" })]);
    const e = await err(b.client.runReport("1", spec));
    expect(e).toMatchObject({ code: "quota_exceeded", retryAfterSeconds: 3600 });
    expect(b.calls).toHaveLength(1);
    const c = setup([() => googleError(403, "RESOURCE_EXHAUSTED")]);
    expect((await err(c.client.runReport("1", spec))).code).toBe("quota_exceeded");
  });
  it("401 triggers exactly one forced token refresh, then fails as google_auth_invalid", async () => {
    const a = setup([() => googleError(401, "UNAUTHENTICATED"), () => Response.json(report())]);
    await a.client.runReport("1", spec);
    expect(a.tokenFetch).toHaveBeenCalledTimes(2);
    expect((a.calls[1]!.init.headers as Record<string, string>).authorization).toBe("Bearer tok-2");
    const b = setup([() => googleError(401, "X"), () => googleError(401, "X")]);
    expect((await err(b.client.runReport("1", spec))).code).toBe("google_auth_invalid");
    expect(b.calls).toHaveLength(2);
  });
  it("maps 403 and 404 to permission_denied and 400 to invalid_request without forwarding Google text", async () => {
    for (const [status, code] of [[403, "permission_denied"], [404, "permission_denied"], [400, "invalid_request"]] as const) {
      const { client } = setup([() => googleError(status, "PERMISSION_DENIED")]);
      const e = await err(client.runReport("1", spec));
      expect(e.code).toBe(code);
      expect(e.message).not.toContain("rtoken");
      expect(e.message).not.toContain("secret detail");
    }
  });
  it("times out, retries, and reports provider_unavailable", async () => {
    const timeoutErr = () => { throw new DOMException("timeout", "TimeoutError"); };
    const { client, calls } = setup([timeoutErr, timeoutErr, timeoutErr]);
    expect((await err(client.runReport("1", spec))).code).toBe("provider_unavailable");
    expect(calls).toHaveLength(3);
  });
  it("maps Google token failures to google_auth_* codes without calling the Data API", async () => {
    const tokens = new GoogleTokenProvider({ secret: undefined });
    const fetchImpl = vi.fn();
    const client = new GoogleAnalyticsClient({ tokens, fetchImpl: fetchImpl as never });
    expect((await err(client.runReport("1", spec))).code).toBe("google_auth_not_configured");
    expect(fetchImpl).not.toHaveBeenCalled();
    const revoked = new GoogleTokenProvider({ secret, fetchImpl: (async () => Response.json({ error: "invalid_grant" }, { status: 400 })) as never });
    resetGoogleTokenCache();
    const c2 = new GoogleAnalyticsClient({ tokens: revoked, fetchImpl: fetchImpl as never });
    expect((await err(c2.runReport("1", spec))).code).toBe("google_auth_revoked");
  });
  it("rejects oversized responses (declared and streamed)", async () => {
    const declared = setup([() => new Response("{}", { headers: { "content-length": String(3 * 1024 * 1024) } })]);
    expect((await err(declared.client.runReport("1", spec))).code).toBe("response_too_large");
    const big = "x".repeat(3 * 1024 * 1024);
    const streamed = setup([() => new Response(JSON.stringify({ rows: [], pad: big }))]);
    expect((await err(streamed.client.runReport("1", spec))).code).toBe("response_too_large");
  });
  it("treats malformed JSON as provider_unavailable", async () => {
    const { client } = setup([() => new Response("<html>")]);
    expect((await err(client.runReport("1", spec))).code).toBe("provider_unavailable");
  });
  it("logs only sanitized fields (no token, body, or credential)", async () => {
    const warn = vi.mocked(console.warn);
    const { client } = setup([() => googleError(503, "UNAVAILABLE"), () => Response.json(report())]);
    await client.runReport("123", spec);
    const logged = JSON.stringify(warn.mock.calls);
    expect(logged).toContain("ga4_request");
    for (const s of ["tok-1", "rtoken", "csecret", "secret detail", "Bearer"]) expect(logged).not.toContain(s);
  });
});

describe("shapeReport", () => {
  it("maps rows by Google header names, preserves metadata, and paginates by provider rowCount", () => {
    const out = shapeReport("123", spec, report({ metadata: { timeZone: "Asia/Taipei", subjectToThresholding: true, samplingMetadatas: [{ samplesReadCount: "10", samplingSpaceSize: "100" }], dataLossFromOtherRow: true } }));
    expect(out.rows[0]).toEqual({ dimensions: { pagePathPlusQueryString: "/a?x=1" }, metrics: { screenPageViews: 10, activeUsers: 4 } });
    expect(out.rows[1]!.dimensions.pagePathPlusQueryString).toBe("/a"); // distinct query strings are never merged
    expect(out).toMatchObject({ propertyId: "123", propertyTimeZone: "Asia/Taipei", rowCount: 5, returnedRowCount: 2, empty: false, responseTruncated: false, responseComplete: false });
    expect(out.pagination).toEqual({ limit: 2, offset: 0, hasMore: true, nextOffset: 2 });
    expect(out.metadata).toMatchObject({ subjectToThresholding: true, dataLossFromOtherRow: true, samplingMetadatas: [{ samplesReadCount: "10", samplingSpaceSize: "100" }] });
    expect(out).not.toHaveProperty("dataThrough");
  });
  it("last page has no continuation", () => {
    const out = shapeReport("1", { ...spec, offset: 3 }, report());
    expect(out.pagination).toEqual({ limit: 2, offset: 3, hasMore: false, nextOffset: null });
    expect(out.responseComplete).toBe(true);
  });
  it("empty responses are empty (not zero) and surface the provider reason", () => {
    const out = shapeReport("1", spec, { dimensionHeaders: [], metricHeaders: [], rows: [], rowCount: 0, metadata: { emptyReason: "no data" } });
    expect(out).toMatchObject({ rows: [], empty: true, emptyReason: "no data", rowCount: 0, pagination: { hasMore: false, nextOffset: null } });
  });
  it("flags local truncation if Google returns more rows than requested, and keeps missing values null", () => {
    const rows = [1, 2, 3].map((i) => ({ dimensionValues: [{ value: `/p${i}` }], metricValues: [{ value: "1" }] }));
    const out = shapeReport("1", spec, report({ rows, rowCount: 3 }));
    expect(out.returnedRowCount).toBe(2);
    expect(out.responseTruncated).toBe(true);
    expect(out.responseComplete).toBe(false);
    expect(out.rows[0]!.metrics.activeUsers).toBeNull(); // metric header present but value missing => null, never 0
  });
});
