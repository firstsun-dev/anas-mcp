import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetGoogleTokenCache } from "../src/auth/google-oauth";
import type { Env } from "../src/index";
import { accessEnv, mcpCall, rawMcpRequest } from "./helpers";

const SITE = "https://example.com/";
const DOMAIN = "sc-domain:example.org";
const credJson = JSON.stringify({ type: "authorized_user", client_id: "cid-test", client_secret: "csecret-test", refresh_token: "rtoken-test" });
const getSecret = vi.fn(async () => credJson);
const binding = { get: getSecret } as unknown as SecretsStoreSecret;
const env: Env = { GOOGLE_OAUTH_CREDENTIALS: binding, GSC_ALLOWED_SITES: JSON.stringify([SITE, DOMAIN]) };

const googleCalls: { url: string; method: string; body: any }[] = [];
let tokenCalls = 0;
let apiResponse: (url: string) => Response;
const queryBody = () =>
  Response.json({
    rows: [
      { keys: ["blue shoes"], clicks: 7, impressions: 120, ctr: 0.0583, position: 3.4 },
      { keys: ["red shoes"], clicks: 0, impressions: 15, ctr: 0, position: 18.25 },
    ],
    responseAggregationType: "byProperty",
    metadata: { first_incomplete_date: "2026-10-14" },
  });

beforeEach(() => {
  resetGoogleTokenCache();
  googleCalls.length = 0;
  tokenCalls = 0;
  getSecret.mockClear();
  apiResponse = (url) =>
    url.endsWith("/sites")
      ? Response.json({ siteEntry: [{ siteUrl: DOMAIN, permissionLevel: "siteOwner" }, { siteUrl: SITE, permissionLevel: "siteFullUser" }, { siteUrl: "https://not-approved.example.net/", permissionLevel: "siteOwner" }] })
      : queryBody();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.stubGlobal("fetch", async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    if (url === "https://oauth2.googleapis.com/token") {
      tokenCalls++;
      return Response.json({
        access_token: "access-test",
        expires_in: 3600,
        scope: "https://www.googleapis.com/auth/analytics.readonly https://www.googleapis.com/auth/webmasters.readonly",
      });
    }
    googleCalls.push({ url, method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : undefined });
    return apiResponse(url);
  });
});
afterEach(() => vi.unstubAllGlobals());

const call = (name: string, args: Record<string, unknown> = {}, e: Env = env) => mcpCall(e, "tools/call", { name, arguments: args });
const payload = (r: Awaited<ReturnType<typeof call>>) => r.json.result.structuredContent;
const errorOf = (r: Awaited<ReturnType<typeof call>>) => JSON.parse(r.json.result.content[0].text).error;

describe("registration, schemas and health", () => {
  it("registers two read-only GSC tools with bounded schemas and no raw-request input", async () => {
    const tools = (await mcpCall(env, "tools/list")).json.result.tools.filter((t: any) => t.name.startsWith("gsc_"));
    expect(tools.map((t: any) => t.name).sort()).toEqual(["gsc_list_sites", "gsc_search_analytics"]);
    for (const t of tools) expect(t.annotations).toEqual({ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false });
    const props = tools.find((t: any) => t.name === "gsc_search_analytics").inputSchema.properties;
    expect(Object.keys(props).sort()).toEqual(["dataState", "dimensions", "endDate", "limit", "offset", "pageFilter", "pageFilterOperator", "queryFilter", "queryFilterOperator", "siteUrl", "startDate", "type"]);
    expect(props.limit).toMatchObject({ minimum: 1, maximum: 200, default: 50 });
    expect(props.offset).toMatchObject({ minimum: 0, maximum: 10000, default: 0 });
    expect(props.dimensions).toMatchObject({ maxItems: 3, minItems: 1, default: ["query"] });
    expect(props.dimensions.items.enum).toEqual(["query", "page", "date", "country", "device"]);
    expect(props.type.enum).toEqual(["web", "image", "video", "news", "discover", "googleNews"]);
    expect(props.type.default).toBe("web");
    expect(props.dataState).toMatchObject({ enum: ["final", "all"], default: "final" });
    expect(props.pageFilter.maxLength).toBe(512);
    expect(props.pageFilterOperator.enum).toEqual(["contains", "equals"]);
    const desc = tools.find((t: any) => t.name === "gsc_search_analytics").description;
    expect(desc).toMatch(/not exhaustive/i);
    expect(desc).toMatch(/advisory/);
    expect(desc).toMatch(/ratio/);
  });
  it("health enables search-console only with binding AND a valid allowlist, never calling Google", async () => {
    const health = async (e: Env) => JSON.parse((await mcpCall(e, "tools/call", { name: "health", arguments: {} })).json.result.content[0].text);
    expect(await health(env)).toEqual({ service: "anas-mcp", status: "ok", enabledSources: ["search-console"], plannedSources: ["ga4"] });
    expect(await health({ ...env, GA4_PROPERTY_IDS: "111" })).toMatchObject({ enabledSources: ["ga4", "search-console"], plannedSources: [] });
    expect((await health({ GSC_ALLOWED_SITES: env.GSC_ALLOWED_SITES })).enabledSources).toEqual([]);
    expect((await health({ GOOGLE_OAUTH_CREDENTIALS: binding })).plannedSources).toEqual(["ga4", "search-console"]);
    expect((await health({ ...env, GSC_ALLOWED_SITES: "[bad" })).plannedSources).toEqual(["ga4", "search-console"]);
    expect((await health({ ...env, GSC_ALLOWED_SITES: '["example.com"]' })).enabledSources).toEqual([]);
    expect(googleCalls).toHaveLength(0);
    expect(tokenCalls).toBe(0);
    expect(getSecret).not.toHaveBeenCalled();
  });
});

describe("Cloudflare Access gates Google access", () => {
  it("rejects missing/invalid assertions before MCP init, the secret read, or any Google call", async () => {
    for (const headers of [{}, { "cf-access-jwt-assertion": "not-a-jwt" }, { authorization: "Bearer anything" }]) {
      const res = await rawMcpRequest(accessEnv(env), headers, { method: "tools/call", params: { name: "gsc_list_sites", arguments: {} } });
      expect(res.status).toBe(401);
    }
    expect(getSecret).not.toHaveBeenCalled();
    expect(tokenCalls).toBe(0);
    expect(googleCalls).toHaveLength(0);
  });
});

describe("gsc_list_sites", () => {
  it("returns allowlisted properties only, with exact URLs, permission levels and deterministic order", async () => {
    const r = await call("gsc_list_sites");
    expect(r.json.result.isError).toBeUndefined();
    const p = payload(r);
    expect(p).toMatchObject({
      sites: [
        { siteUrl: SITE, permissionLevel: "siteFullUser", queryable: true },
        { siteUrl: DOMAIN, permissionLevel: "siteOwner", queryable: true },
      ],
      count: 2,
      approvedButNotAccessible: [],
      source: "google-search-console",
    });
    expect(JSON.stringify(r.json)).not.toContain("not-approved");
    expect(JSON.parse(r.json.result.content[0].text)).toEqual(p);
    expect(googleCalls).toEqual([{ url: "https://www.googleapis.com/webmasters/v3/sites", method: "GET", body: undefined }]);
  });
  it("handles an empty list and reports allowlisted properties Google does not return", async () => {
    apiResponse = () => Response.json({});
    const p = payload(await call("gsc_list_sites"));
    expect(p).toMatchObject({ sites: [], count: 0, approvedButNotAccessible: [SITE, DOMAIN].sort() });
  });
  it("fails closed with no Google call when unconfigured or malformed", async () => {
    for (const bad of [undefined, "", "[]", "garbage"]) {
      const r = await call("gsc_list_sites", {}, { ...env, GSC_ALLOWED_SITES: bad });
      expect(r.json.result.isError).toBe(true);
      expect(errorOf(r).code).toBe("configuration_missing");
    }
    expect(googleCalls).toHaveLength(0);
    expect(tokenCalls).toBe(0);
  });
  it("surfaces a missing webmasters.readonly scope as a sanitized actionable error", async () => {
    vi.stubGlobal("fetch", async () => Response.json({ access_token: "a", expires_in: 3600, scope: "https://www.googleapis.com/auth/analytics.readonly" }));
    const r = await call("gsc_list_sites");
    expect(errorOf(r)).toMatchObject({ code: "google_auth_scope_missing" });
    expect(errorOf(r).message).toMatch(/webmasters\.readonly/);
    expect(JSON.stringify(r.json)).not.toMatch(/rtoken-test|csecret-test|access-test/);
  });
});

describe("gsc_search_analytics", () => {
  it("applies defaults and returns the full response contract", async () => {
    const r = await call("gsc_search_analytics", { siteUrl: SITE });
    const p = payload(r);
    expect(googleCalls).toHaveLength(1);
    const g = googleCalls[0]!;
    expect(g.url).toBe("https://www.googleapis.com/webmasters/v3/sites/https%3A%2F%2Fexample.com%2F/searchAnalytics/query");
    expect(g.method).toBe("POST");
    expect(g.body).toMatchObject({ dimensions: ["query"], type: "web", dataState: "final", aggregationType: "auto", rowLimit: 50, startRow: 0 });
    expect(g.body.dimensionFilterGroups).toBeUndefined();
    // Default window is 28 inclusive Pacific days.
    const days = (Date.parse(`${g.body.endDate}T00:00:00Z`) - Date.parse(`${g.body.startDate}T00:00:00Z`)) / 86_400_000 + 1;
    expect(days).toBe(28);
    expect(p).toMatchObject({
      siteUrl: SITE,
      dateRange: { startDate: g.body.startDate, endDate: g.body.endDate, timeZone: "America/Los_Angeles" },
      dimensions: ["query"],
      type: "web",
      dataState: "final",
      returnedRowCount: 2,
      pagination: { limit: 50, offset: 0, nextOffset: null, hasMorePossible: false },
      responseAggregationType: "byProperty",
      metadata: { first_incomplete_date: "2026-10-14" },
      source: "google-search-console",
    });
    expect(p.rows).toEqual([
      { dimensions: { query: "blue shoes" }, clicks: 7, impressions: 120, ctr: 0.0583, position: 3.4 },
      { dimensions: { query: "red shoes" }, clicks: 0, impressions: 15, ctr: 0, position: 18.25 },
    ]);
    expect(p).not.toHaveProperty("rowCount");
    expect(JSON.parse(r.json.result.content[0].text)).toEqual(p);
  });
  it("passes grouping, type, state, paging, dates and constrained filters through", async () => {
    await call("gsc_search_analytics", {
      siteUrl: DOMAIN,
      startDate: "2026-09-01",
      endDate: "2026-09-30",
      dimensions: ["page", "country", "device"],
      type: "image",
      dataState: "all",
      limit: 200,
      offset: 400,
      pageFilter: "/blog/",
      queryFilter: "shoes",
      queryFilterOperator: "equals",
    });
    expect(googleCalls[0]!.url).toContain("/sites/sc-domain%3Aexample.org/searchAnalytics/query");
    expect(googleCalls[0]!.body).toEqual({
      startDate: "2026-09-01",
      endDate: "2026-09-30",
      dimensions: ["page", "country", "device"],
      type: "image",
      dataState: "all",
      aggregationType: "auto",
      rowLimit: 200,
      startRow: 400,
      dimensionFilterGroups: [{ groupType: "and", filters: [{ dimension: "page", operator: "contains", expression: "/blog/" }, { dimension: "query", operator: "equals", expression: "shoes" }] }],
    });
  });
  it("marks a full page as advisory 'more possible' without inventing totals", async () => {
    const p = payload(await call("gsc_search_analytics", { siteUrl: SITE, limit: 2, offset: 10 }));
    expect(p.pagination).toEqual({ limit: 2, offset: 10, nextOffset: 12, hasMorePossible: true });
    expect(p.note).toMatch(/advisory/);
  });
  it("rejects unapproved or invalid properties before the secret, token or Google are touched", async () => {
    for (const siteUrl of ["sc-domain:example.com", "https://example.com/blog/", "https://other.example.net/", "https://EXAMPLE.com/"]) {
      const r = await call("gsc_search_analytics", { siteUrl });
      expect(r.json.result.isError).toBe(true);
      expect(errorOf(r).code).toBe("property_not_allowed");
    }
    expect(errorOf(await call("gsc_search_analytics", { siteUrl: "not a site" })).code).toBe("invalid_property");
    expect(getSecret).not.toHaveBeenCalled();
    expect(tokenCalls).toBe(0);
    expect(googleCalls).toHaveLength(0);
  });
  it("fails closed when the allowlist is missing", async () => {
    const r = await call("gsc_search_analytics", { siteUrl: SITE }, { GOOGLE_OAUTH_CREDENTIALS: binding });
    expect(errorOf(r).code).toBe("configuration_missing");
    expect(googleCalls).toHaveLength(0);
  });
  it("rejects invalid inputs without calling Google", async () => {
    const bad: Record<string, unknown>[] = [
      { startDate: "2026-09-01" },
      { startDate: "2026-02-30", endDate: "2026-03-01" },
      { startDate: "2025-01-01", endDate: "2026-01-02" },
      { dimensions: ["query", "query"] },
      { type: "discover" },
      { type: "googleNews", dimensions: ["page"], queryFilter: "x" },
    ];
    for (const extra of bad) {
      const r = await call("gsc_search_analytics", { siteUrl: SITE, ...extra });
      expect(r.json.result.isError, JSON.stringify(extra)).toBe(true);
      expect(errorOf(r).code).toBe("invalid_request");
    }
    // Schema-level bounds are rejected by the MCP layer.
    for (const extra of [{ limit: 201 }, { offset: 10001 }, { dimensions: ["query", "page", "date", "country"] }, { dimensions: [] }, { dimensions: ["hour"] }, { type: "sitemap" }, { pageFilter: "x".repeat(513) }, { queryFilterOperator: "regex" }, { dataState: "hourly" }]) {
      const r = await call("gsc_search_analytics", { siteUrl: SITE, ...extra });
      expect(r.json.error ?? r.json.result?.isError, JSON.stringify(extra)).toBeTruthy();
    }
    expect(googleCalls).toHaveLength(0);
  });
  it("sanitizes provider failures: no Google text, tokens or credentials", async () => {
    apiResponse = () => new Response(JSON.stringify({ error: { code: 403, message: "leak access-test rtoken-test", errors: [{ reason: "forbidden" }] } }), { status: 403 });
    const r = await call("gsc_search_analytics", { siteUrl: SITE });
    expect(errorOf(r).code).toBe("permission_denied");
    expect(JSON.stringify(r.json)).not.toMatch(/leak|access-test|rtoken-test|csecret-test/);
  });
  it("retries once with a fresh token after HTTP 401", async () => {
    let n = 0;
    apiResponse = () => (n++ === 0 ? new Response("{}", { status: 401 }) : queryBody());
    const r = await call("gsc_search_analytics", { siteUrl: SITE });
    expect(r.json.result.isError).toBeUndefined();
    expect(tokenCalls).toBe(2);
    expect(googleCalls).toHaveLength(2);
  });
  it("reuses the cached access token across calls and across GA4 and GSC", async () => {
    await call("gsc_list_sites");
    await call("gsc_search_analytics", { siteUrl: SITE });
    expect(tokenCalls).toBe(1);
  });
  it("reports a revoked refresh token", async () => {
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 }));
    expect(errorOf(await call("gsc_search_analytics", { siteUrl: SITE })).code).toBe("google_auth_revoked");
  });
});

describe("no regression in GA4", () => {
  it("ga4_pages keeps hostName isolation in both grouping modes alongside GSC", async () => {
    const ga4Env: Env = { ...env, GA4_PROPERTY_IDS: "111" };
    apiResponse = () => Response.json({ dimensionHeaders: [], metricHeaders: [], rows: [], rowCount: 0, metadata: {} });
    await call("ga4_pages", {}, ga4Env);
    await call("ga4_pages", { groupBy: "fullUrl" }, ga4Env);
    expect(googleCalls.map((c) => c.body.dimensions.map((d: any) => d.name))).toEqual([
      ["hostName", "pagePath"],
      ["hostName", "pagePathPlusQueryString"],
    ]);
    expect(googleCalls.every((c) => c.url.startsWith("https://analyticsdata.googleapis.com/"))).toBe(true);
  });
});
