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
    dimensionHeaders: [{ name: "pagePathPlusQueryString" }],
    metricHeaders: [{ name: "screenPageViews", type: "TYPE_INTEGER" }],
    rows: [{ dimensionValues: [{ value: "/blog/a?utm=1" }], metricValues: [{ value: "9" }] }],
    rowCount: 1,
    metadata: { timeZone: "Asia/Taipei" },
    ...over,
  });

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
  it("ga4_pages: query strings stay distinct, deterministic order, prefix filter, pagination echoed", async () => {
    reportResponse = () => okReport({ rowCount: 120 });
    const p = payload(await call("ga4_pages", { startDate: "2026-09-01", endDate: "2026-09-28", limit: 1, offset: 10, pagePath: "/blog/" }));
    const body = googleCalls[0]!.body;
    expect(body.dimensions).toEqual([{ name: "pagePathPlusQueryString" }]);
    expect(body.limit).toBe("1");
    expect(body.offset).toBe("10");
    expect(body.orderBys[0]).toEqual({ metric: { metricName: "screenPageViews" }, desc: true });
    expect(body.dimensionFilter.filter.stringFilter).toMatchObject({ matchType: "BEGINS_WITH", value: "/blog/" });
    expect(p.rows[0].dimensions.pagePathPlusQueryString).toBe("/blog/a?utm=1");
    expect(p.pagination).toEqual({ limit: 1, offset: 10, hasMore: true, nextOffset: 11 });
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
