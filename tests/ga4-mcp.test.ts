import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetGoogleTokenCache } from "../src/auth/google-oauth";
import type { Env } from "../src/index";
import { mcpCall, rawMcpRequest, accessEnv } from "./helpers";

const credJson = JSON.stringify({ type: "authorized_user", client_id: "cid-test", client_secret: "csecret-test", refresh_token: "rtoken-test" });
const getSecret = vi.fn(async () => credJson);
const binding = { get: getSecret } as unknown as SecretsStoreSecret;
const env: Env = { GOOGLE_OAUTH_CREDENTIALS: binding, GA4_PROPERTY_IDS: "111" };

const googleCalls: { url: string; body: any }[] = [];
let reportResponse: () => Response;
const okReport = (over: Record<string, unknown> = {}) =>
  Response.json({
    dimensionHeaders: [{ name: "hostName" }, { name: "pagePathPlusQueryString" }],
    metricHeaders: [{ name: "screenPageViews", type: "TYPE_INTEGER" }],
    rows: [{ dimensionValues: [{ value: "a.example.com" }, { value: "/blog/a?utm=1" }], metricValues: [{ value: "9" }] }],
    rowCount: 1,
    metadata: { timeZone: "Asia/Taipei" },
    ...over,
  });

const pathReportBody = {
  dimensionHeaders: [{ name: "hostName" }, { name: "pagePath" }],
  metricHeaders: [
    { name: "screenPageViews", type: "TYPE_INTEGER" },
    { name: "activeUsers", type: "TYPE_INTEGER" },
    { name: "sessions", type: "TYPE_INTEGER" },
    { name: "engagementRate", type: "TYPE_FLOAT" },
    { name: "userEngagementDuration", type: "TYPE_SECONDS" },
  ],
  rows: [
    { dimensionValues: [{ value: "www.example.com" }, { value: "/tools/calendar-generator/2027/" }], metricValues: [{ value: "130" }, { value: "41" }, { value: "57" }, { value: "0.6123" }, { value: "4210" }] },
    { dimensionValues: [{ value: "blog.example.com" }, { value: "/tools/calendar-generator/2027/" }], metricValues: [{ value: "9" }, { value: "6" }, { value: "7" }, { value: "0.5" }, { value: "80" }] },
  ],
  rowCount: 2,
  metadata: {
    timeZone: "Asia/Taipei",
    subjectToThresholding: true,
    dataLossFromOtherRow: true,
    samplingMetadatas: [{ samplesReadCount: "100", samplingSpaceSize: "1000" }],
  },
};
const pathReport = (over: Record<string, unknown> = {}) => Response.json({ ...pathReportBody, ...over });

beforeEach(() => {
  resetGoogleTokenCache();
  googleCalls.length = 0;
  getSecret.mockClear();
  reportResponse = () => okReport();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.stubGlobal("fetch", async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    if (url === "https://oauth2.googleapis.com/token") {
      return Response.json({ access_token: "access-test", expires_in: 3600, scope: "https://www.googleapis.com/auth/analytics.readonly" });
    }
    googleCalls.push({ url, body: JSON.parse(String(init!.body)) });
    return reportResponse();
  });
});
afterEach(() => vi.unstubAllGlobals());

const call = (name: string, args: Record<string, unknown> = {}, e: Env = env) => mcpCall(e, "tools/call", { name, arguments: args });
const payload = (r: Awaited<ReturnType<typeof call>>) => r.json.result.structuredContent;
const errorOf = (r: Awaited<ReturnType<typeof call>>) => JSON.parse(r.json.result.content[0].text).error;

describe("registration, schemas and health", () => {
  it("registers four read-only GA4 tools with bounded schemas and no raw-request input", async () => {
    const tools = (await mcpCall(env, "tools/list")).json.result.tools.filter((t: any) => t.name.startsWith("ga4_"));
    expect(tools.map((t: any) => t.name).sort()).toEqual(["ga4_acquisition", "ga4_overview", "ga4_pages", "ga4_run_report"]);
    for (const t of tools) expect(t.annotations).toEqual({ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false });
    const run = tools.find((t: any) => t.name === "ga4_run_report").inputSchema.properties;
    expect(Object.keys(run).sort()).toEqual(["dimensions", "endDate", "limit", "metrics", "offset", "propertyId", "startDate"]);
    expect(run.limit).toMatchObject({ minimum: 1, maximum: 200 });
    expect(run.metrics).toMatchObject({ maxItems: 6 });
    expect(run.dimensions).toMatchObject({ maxItems: 4 });
    expect(run.metrics.items.enum).toContain("sessions");
  });
  it("health advertises ga4 only when binding and a valid allowlist exist, and keeps search-console planned", async () => {
    const health = async (e: Env) => JSON.parse((await mcpCall(e, "tools/call", { name: "health", arguments: {} })).json.result.content[0].text);
    expect(await health(env)).toEqual({ service: "anas-mcp", status: "ok", enabledSources: ["ga4"], plannedSources: ["search-console"] });
    expect((await health({ GA4_PROPERTY_IDS: "111" })).enabledSources).toEqual([]);
    expect((await health({ GOOGLE_OAUTH_CREDENTIALS: binding })).enabledSources).toEqual([]);
    expect((await health({ ...env, GA4_PROPERTY_IDS: "abc" })).enabledSources).toEqual([]);
    expect((await health({})).plannedSources).toEqual(["ga4", "search-console"]);
    expect(googleCalls).toHaveLength(0);
    expect(getSecret).not.toHaveBeenCalled(); // health never reads the secret or calls Google
  });
  it("/health HTTP route is unchanged and makes no Google call", async () => {
    const { handler } = await import("./helpers");
    const res = await handler.fetch!(new Request("http://localhost/health") as never, env, {} as ExecutionContext);
    expect(await res.json()).toEqual({ service: "anas-mcp", status: "ok" });
    expect(googleCalls).toHaveLength(0);
  });
});

describe("Cloudflare Access gates Google access", () => {
  it("rejects missing/invalid assertions before MCP init, the secret read, or any Google call", async () => {
    for (const headers of [{}, { "cf-access-jwt-assertion": "not-a-jwt" }, { authorization: "Bearer anything" }]) {
      const res = await rawMcpRequest(accessEnv(env), headers, { method: "tools/call", params: { name: "ga4_overview", arguments: {} } });
      expect(res.status).toBe(401);
    }
    const unconfigured = await rawMcpRequest(env, {}, { method: "tools/call", params: { name: "ga4_overview", arguments: {} } });
    expect(unconfigured.status).toBe(503);
    expect(getSecret).not.toHaveBeenCalled();
    expect(googleCalls).toHaveLength(0);
  });
});

describe("tools", () => {
  it("ga4_overview: default previous-28-days range, no dimensions, provider metadata preserved", async () => {
    reportResponse = () =>
      Response.json({
        metricHeaders: [{ name: "activeUsers", type: "TYPE_INTEGER" }, { name: "engagementRate", type: "TYPE_FLOAT" }],
        rows: [{ dimensionValues: [], metricValues: [{ value: "12" }, { value: "0.5" }] }],
        rowCount: 1,
        metadata: { timeZone: "Asia/Taipei", subjectToThresholding: true },
        propertyQuota: { tokensPerDay: { consumed: 1, remaining: 199 } },
      });
    const r = await call("ga4_overview");
    expect(r.json.result.isError).toBeUndefined();
    expect(googleCalls[0]!.url).toBe("https://analyticsdata.googleapis.com/v1beta/properties/111:runReport");
    expect(googleCalls[0]!.body.dateRanges).toEqual([{ startDate: "28daysAgo", endDate: "yesterday" }]);
    expect(googleCalls[0]!.body.dimensions).toEqual([]);
    expect(googleCalls[0]!.body.metrics.map((m: any) => m.name)).toEqual(["activeUsers", "totalUsers", "sessions", "engagedSessions", "engagementRate", "screenPageViews", "averageSessionDuration"]);
    const p = payload(r);
    expect(p).toMatchObject({ propertyId: "111", propertyTimeZone: "Asia/Taipei", dateRange: { startDate: "28daysAgo", endDate: "yesterday" } });
    expect(p.rows[0].metrics).toEqual({ activeUsers: 12, engagementRate: 0.5 });
    expect(p.metadata.subjectToThresholding).toBe(true);
    expect(p.propertyQuota.tokensPerDay).toEqual({ consumed: 1, remaining: 199 });
    expect(JSON.parse(r.json.result.content[0].text)).toEqual(p);
  });
  it("ga4_pages fullUrl: query strings stay distinct, deterministic order, prefix filter, pagination echoed", async () => {
    reportResponse = () => okReport({ rowCount: 120 });
    const p = payload(await call("ga4_pages", { startDate: "2026-09-01", endDate: "2026-09-28", limit: 1, offset: 10, pagePath: "/blog/", groupBy: "fullUrl" }));
    const body = googleCalls[0]!.body;
    expect(body.dimensions).toEqual([{ name: "hostName" }, { name: "pagePathPlusQueryString" }]);
    expect(body.limit).toBe("1");
    expect(body.offset).toBe("10");
    expect(body.orderBys).toEqual([{ metric: { metricName: "screenPageViews" }, desc: true }, { dimension: { dimensionName: "hostName" } }, { dimension: { dimensionName: "pagePathPlusQueryString" } }]);
    expect(body.dimensionFilter.filter).toMatchObject({ fieldName: "pagePath", stringFilter: { matchType: "BEGINS_WITH", value: "/blog/" } });
    expect(p.groupBy).toBe("fullUrl");
    expect(p.dimensionHeaders).toEqual(["hostName", "pagePathPlusQueryString"]);
    expect(p.rows[0].dimensions).toEqual({ hostName: "a.example.com", pagePathPlusQueryString: "/blog/a?utm=1" });
    expect(p.pagination).toEqual({ limit: 1, offset: 10, hasMore: true, nextOffset: 11 });
  });
  it("ga4_pages defaults to groupBy=path and asks Google to group by hostName + pagePath (no query string)", async () => {
    reportResponse = () => pathReport();
    const p = payload(await call("ga4_pages", { startDate: "2026-09-01", endDate: "2026-09-28" }));
    const body = googleCalls[0]!.body;
    expect(body.dimensions).toEqual([{ name: "hostName" }, { name: "pagePath" }]);
    expect(JSON.stringify(body)).not.toContain("pagePathPlusQueryString");
    expect(body.orderBys).toEqual([
      { metric: { metricName: "screenPageViews" }, desc: true },
      { dimension: { dimensionName: "hostName" } },
      { dimension: { dimensionName: "pagePath" } },
    ]);
    expect(body.dateRanges).toEqual([{ startDate: "2026-09-01", endDate: "2026-09-28" }]);
    expect(body.dimensionFilter).toBeUndefined();
    expect(p.groupBy).toBe("path");
    expect(p.dimensionHeaders).toEqual(["hostName", "pagePath"]);
  });
  it("path mode: previously fragmented share/utm/fbclid/gclid URLs are one page identity with Google's metrics preserved exactly", async () => {
    // Google already aggregated /tools/calendar-generator/2027/ plus its ?share=, ?utm_*, ?fbclid=, ?gclid= variants.
    // Values are deliberately NOT the sum of any per-variant rows; they must pass through untouched.
    reportResponse = () => pathReport();
    const p = payload(await call("ga4_pages"));
    expect(p.rows).toHaveLength(2);
    expect(p.rows[0]).toEqual({
      dimensions: { hostName: "www.example.com", pagePath: "/tools/calendar-generator/2027/" },
      metrics: { screenPageViews: 130, activeUsers: 41, sessions: 57, engagementRate: 0.6123, userEngagementDuration: 4210 },
    });
    const text = JSON.stringify(p.rows);
    expect(text).not.toMatch(/share=|utm_|fbclid|gclid/);
    expect(p.metricHeaders).toEqual(pathReportBody.metricHeaders);
    expect(p.rowCount).toBe(2);
    expect(p.metadata).toEqual({ subjectToThresholding: true, samplingMetadatas: [{ samplesReadCount: "100", samplingSpaceSize: "1000" }], dataLossFromOtherRow: true, schemaRestrictionResponse: null });
  });
  it("path mode keeps same path on different hosts as separate rows (hostName isolation)", async () => {
    reportResponse = () => pathReport();
    const p = payload(await call("ga4_pages"));
    const hosts = p.rows.map((r: any) => r.dimensions.hostName);
    expect(hosts).toEqual(["www.example.com", "blog.example.com"]);
    expect(p.rows.map((r: any) => r.dimensions.pagePath)).toEqual(["/tools/calendar-generator/2027/", "/tools/calendar-generator/2027/"]);
  });
  const fullUrlReport = (rows: [string, string, string, string?, string?][], over: Record<string, unknown> = {}) =>
    Response.json({
      dimensionHeaders: [{ name: "hostName" }, { name: "pagePathPlusQueryString" }],
      metricHeaders: [{ name: "screenPageViews", type: "TYPE_INTEGER" }, { name: "activeUsers", type: "TYPE_INTEGER" }],
      rows: rows.map(([h, u, v, a]) => ({ dimensionValues: [{ value: h }, { value: u }], metricValues: [{ value: v }, { value: a ?? "0" }] })),
      rowCount: rows.length,
      metadata: {},
      ...over,
    });
  it("fullUrl mode: same / on two hosts stays two rows with Google's per-host values (never summed)", async () => {
    // Pre-aggregated by Google per host; active users deliberately do not add up to any total.
    reportResponse = () => fullUrlReport([["firstsun.heavenfortress.com", "/", "96", "40"], ["firstsun-blog.pages.dev", "/", "4", "3"]]);
    const p = payload(await call("ga4_pages", { groupBy: "fullUrl" }));
    expect(p.rows).toEqual([
      { dimensions: { hostName: "firstsun.heavenfortress.com", pagePathPlusQueryString: "/" }, metrics: { screenPageViews: 96, activeUsers: 40 } },
      { dimensions: { hostName: "firstsun-blog.pages.dev", pagePathPlusQueryString: "/" }, metrics: { screenPageViews: 4, activeUsers: 3 } },
    ]);
    expect(p.rowCount).toBe(2);
    expect(p.groupBy).toBe("fullUrl");
  });
  it("fullUrl mode: identical path+query on two hosts stays two rows", async () => {
    reportResponse = () => fullUrlReport([["a.example.com", "/p/?x=1", "5", "2"], ["b.example.com", "/p/?x=1", "3", "2"]]);
    const p = payload(await call("ga4_pages", { groupBy: "fullUrl" }));
    expect(p.rows.map((r: any) => [r.dimensions.hostName, r.dimensions.pagePathPlusQueryString])).toEqual([["a.example.com", "/p/?x=1"], ["b.example.com", "/p/?x=1"]]);
  });
  it("fullUrl mode: distinct query strings on one host stay distinct rows", async () => {
    reportResponse = () => fullUrlReport([["h.example.com", "/search?q=react", "7"], ["h.example.com", "/search?q=python", "5"], ["h.example.com", "/p/?share=tok", "3"], ["h.example.com", "/p/?fbclid=x", "2"]]);
    const p = payload(await call("ga4_pages", { groupBy: "fullUrl" }));
    expect(p.rows.map((r: any) => r.dimensions.pagePathPlusQueryString)).toEqual(["/search?q=react", "/search?q=python", "/p/?share=tok", "/p/?fbclid=x"]);
    expect(new Set(p.rows.map((r: any) => r.dimensions.hostName))).toEqual(new Set(["h.example.com"]));
  });
  it("fullUrl mode: pages through Google offset/limit with stable ordering on every dimension; metadata and empty reports pass through", async () => {
    reportResponse = () => fullUrlReport([["a", "/", "1"]], { rowCount: 9, metadata: { subjectToThresholding: true, samplingMetadatas: [{ samplesReadCount: "1", samplingSpaceSize: "2" }] } });
    const p = payload(await call("ga4_pages", { groupBy: "fullUrl", limit: 1, offset: 3 }));
    expect(googleCalls[0]!.body.orderBys.map((o: any) => o.metric?.metricName ?? o.dimension.dimensionName)).toEqual(["screenPageViews", "hostName", "pagePathPlusQueryString"]);
    expect(p.pagination).toEqual({ limit: 1, offset: 3, hasMore: true, nextOffset: 4 });
    expect(p.metadata.subjectToThresholding).toBe(true);
    expect(p.metadata.samplingMetadatas).toEqual([{ samplesReadCount: "1", samplingSpaceSize: "2" }]);
    reportResponse = () => Response.json({ metricHeaders: [], rows: [], rowCount: 0, metadata: { emptyReason: "no data" } });
    expect(payload(await call("ga4_pages", { groupBy: "fullUrl" }))).toMatchObject({ empty: true, groupBy: "fullUrl", rows: [] });
  });
  it("path mode applies the prefix filter to pagePath and pages through Google offset/limit", async () => {
    reportResponse = () => pathReport({ rowCount: 25 });
    const p = payload(await call("ga4_pages", { pagePath: "/tools/", limit: 2, offset: 4 }));
    const body = googleCalls[0]!.body;
    expect(body.dimensionFilter.filter).toEqual({ fieldName: "pagePath", stringFilter: { matchType: "BEGINS_WITH", value: "/tools/", caseSensitive: true } });
    expect(body.limit).toBe("2");
    expect(body.offset).toBe("4");
    expect(p.pagination).toEqual({ limit: 2, offset: 4, hasMore: true, nextOffset: 6 });
  });
  it("path mode: empty page response is empty (not zero) and missing metric values stay null", async () => {
    reportResponse = () => Response.json({ metricHeaders: [], rows: [], rowCount: 0, metadata: { emptyReason: "no data" } });
    const empty = payload(await call("ga4_pages"));
    expect(empty).toMatchObject({ empty: true, groupBy: "path", emptyReason: "no data", rows: [] });
    reportResponse = () =>
      Response.json({
        dimensionHeaders: [{ name: "hostName" }, { name: "pagePath" }],
        metricHeaders: [{ name: "screenPageViews" }, { name: "engagementRate" }],
        rows: [{ dimensionValues: [{ value: "h" }, { value: "/a" }], metricValues: [{ value: "4" }, { value: "" }] }],
        rowCount: 1,
        metadata: {},
      });
    expect(payload(await call("ga4_pages")).rows[0].metrics).toEqual({ screenPageViews: 4, engagementRate: null });
  });
  it("ga4_pages rejects an invalid groupBy and an unapproved property before any Google call", async () => {
    const bad = await call("ga4_pages", { groupBy: "host" });
    expect(bad.json.result.isError ?? bad.json.error).toBeTruthy();
    expect(errorOf(await call("ga4_pages", { propertyId: "999", groupBy: "path" })).code).toBe("property_not_allowed");
    expect(googleCalls).toHaveLength(0);
  });
  it("ga4_pages advertises groupBy (enum, default path) and the other tools are unchanged", async () => {
    const tools = (await mcpCall(env, "tools/list")).json.result.tools;
    const pages = tools.find((t: any) => t.name === "ga4_pages").inputSchema.properties;
    expect(Object.keys(pages).sort()).toEqual(["endDate", "groupBy", "limit", "offset", "pagePath", "propertyId", "startDate"]);
    expect(pages.groupBy).toMatchObject({ enum: ["path", "fullUrl"], default: "path" });
    await call("ga4_run_report", { propertyId: "111", startDate: "2026-09-01", endDate: "2026-09-02", dimensions: ["pagePathPlusQueryString"], metrics: ["sessions"] });
    expect(googleCalls[0]!.body.dimensions).toEqual([{ name: "pagePathPlusQueryString" }]);
  });
  it("ga4_acquisition: session-scoped dimensions only", async () => {
    await call("ga4_acquisition");
    const names = googleCalls[0]!.body.dimensions.map((d: any) => d.name);
    expect(names).toEqual(["sessionDefaultChannelGroup", "sessionSource", "sessionMedium"]);
    expect(names.some((n: string) => n.startsWith("firstUser"))).toBe(false);
  });
  it("ga4_run_report: catalog fields pass; incompatible and out-of-catalog requests never reach Google", async () => {
    const args = { propertyId: "111", startDate: "2026-09-01", endDate: "2026-09-07", dimensions: ["date", "country"], metrics: ["sessions"] };
    expect((await call("ga4_run_report", args)).json.result.isError).toBeUndefined();
    expect(googleCalls).toHaveLength(1);
    const before = googleCalls.length;
    const mixed = await call("ga4_run_report", { ...args, dimensions: ["sessionSource", "firstUserSource"] });
    expect(errorOf(mixed).code).toBe("invalid_request");
    const outside = await call("ga4_run_report", { ...args, metrics: ["totalRevenue"] });
    expect(outside.json.result?.isError ?? true).toBeTruthy();
    for (const bad of [{ dimensions: ["a", "b"] }, { limit: 1000 }, { startDate: "2020-01-01" }, { metrics: [] }]) {
      const r = await call("ga4_run_report", { ...args, ...bad });
      expect(googleCalls.length).toBe(before);
      expect(r.json.result?.isError ?? r.json.error).toBeTruthy();
    }
    expect(googleCalls.length).toBe(before);
    // Unknown properties such as filters are not part of the schema and are never forwarded to Google.
    await call("ga4_run_report", { ...args, filter: { fieldName: "country" }, dimensionFilter: {} });
    expect(JSON.stringify(googleCalls.at(-1)!.body)).not.toMatch(/country"\s*,\s*"stringFilter|dimensionFilter/);
  });
  it("rejects unapproved properties before any Google call and requires an explicit one when several are approved", async () => {
    const r = await call("ga4_pages", { propertyId: "999" });
    expect(errorOf(r).code).toBe("property_not_allowed");
    const multi: Env = { ...env, GA4_PROPERTY_IDS: "111,222" };
    expect(errorOf(await call("ga4_overview", {}, multi)).code).toBe("property_required");
    expect(payload(await call("ga4_overview", { propertyId: "222" }, multi)).propertyId).toBe("222");
    expect(googleCalls).toHaveLength(1);
    expect(googleCalls[0]!.url).toContain("/properties/222:");
  });
  it("fails closed with configuration_missing / google_auth_not_configured and never calls Google", async () => {
    expect(errorOf(await call("ga4_overview", {}, { GOOGLE_OAUTH_CREDENTIALS: binding })).code).toBe("configuration_missing");
    expect(errorOf(await call("ga4_overview", {}, { GA4_PROPERTY_IDS: "111" })).code).toBe("google_auth_not_configured");
    expect(googleCalls).toHaveLength(0);
  });
  it("reports empty results as empty and surfaces Google failures with distinct sanitized codes", async () => {
    reportResponse = () => Response.json({ metricHeaders: [], rows: [], rowCount: 0, metadata: {} });
    expect(payload(await call("ga4_pages")).empty).toBe(true);
    for (const [status, code] of [[403, "permission_denied"], [400, "invalid_request"], [401, "google_auth_invalid"]] as const) {
      reportResponse = () => new Response(JSON.stringify({ error: { message: "leak rtoken-test access-test" } }), { status });
      const r = await call("ga4_pages");
      expect(errorOf(r).code).toBe(code);
      expect(r.text).not.toMatch(/rtoken-test|access-test|csecret-test/);
    }
    reportResponse = () => new Response("{}", { status: 429, headers: { "retry-after": "600" } });
    expect(errorOf(await call("ga4_pages"))).toMatchObject({ code: "quota_exceeded", retryAfterSeconds: 600 });
  });
  it("never leaks credential material, tokens or the Access assertion in any response or log", async () => {
    const warn = vi.mocked(console.warn);
    const r = await call("ga4_overview");
    const seen = r.text + JSON.stringify(warn.mock.calls);
    for (const s of ["rtoken-test", "csecret-test", "cid-test", "access-test"]) expect(seen).not.toContain(s);
  });
});
