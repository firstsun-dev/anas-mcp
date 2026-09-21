import { afterEach, describe, expect, it, vi } from "vitest";
import { TOKEN, envWithToken, mcpCall } from "./helpers";
import type { Env } from "../src/index";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function mockFetch(res: () => Response) {
  const f = vi.fn(async () => res());
  vi.stubGlobal("fetch", f);
  return f;
}
afterEach(() => vi.unstubAllGlobals());

async function callTool(env: Env, name: string, args: Record<string, unknown>) {
  const r = await mcpCall(env, "tools/call", { name, arguments: args });
  return r;
}

describe("MCP tool registration", () => {
  it("lists health and the three read-only Bing tools", async () => {
    const r = await mcpCall(envWithToken(), "tools/list");
    const names = r.json.result.tools.map((t: any) => t.name).sort();
    expect(names).toEqual(["bing_list_sites", "bing_search_performance", "bing_url_info", "health"]);
    for (const t of r.json.result.tools.filter((t: any) => t.name.startsWith("bing_"))) {
      expect(t.annotations.readOnlyHint).toBe(true);
    }
  });
  it("exposes no write or generic-request tools", async () => {
    const r = await mcpCall(envWithToken(), "tools/list");
    const names: string[] = r.json.result.tools.map((t: any) => t.name);
    for (const n of names) expect(n).not.toMatch(/submit|delete|update|create|sitemap|add|remove|verify|configure|request/i);
  });
  it("no HTTP route beyond /health and /mcp was added", async () => {
    const { default: worker } = await import("../src/index");
    const res = await worker.fetch(new Request("http://localhost/bing"), {}, {} as ExecutionContext);
    expect(res.status).not.toBe(200);
  });
});

describe("MCP tool behavior", () => {
  it("bing_list_sites returns normalized sites, no verification codes or token", async () => {
    mockFetch(() => json({ d: [{ AuthenticationCode: "AUTHSECRET", DnsVerificationCode: "DNSSECRET", IsVerified: true, Url: "https://example.com/" }] }));
    const r = await callTool(envWithToken(), "bing_list_sites", {});
    expect(r.json.result.structuredContent.sites).toEqual([{ url: "https://example.com/", isVerified: true }]);
    expect(r.text).not.toMatch(/SECRET|test-token/);
  });

  it("bing_search_performance returns bounded rows with offset/truncation", async () => {
    const d = Array.from({ length: 30 }, (_, i) => ({ Query: `q${i}`, Date: "/Date(1316156400000-0700)/", Impressions: i, Clicks: 1, AvgClickPosition: 2, AvgImpressionPosition: 3 }));
    mockFetch(() => json({ d }));
    const r = await callTool(envWithToken(), "bing_search_performance", { siteUrl: "https://example.com/", limit: 10, offset: 5 });
    const sc = r.json.result.structuredContent;
    expect(sc.rows).toHaveLength(10);
    expect(sc.rows[0].query).toBe("q5");
    expect(sc.totalRows).toBe(30);
    expect(sc.truncated).toBe(true);
  });

  it("date range filters on provider row date", async () => {
    mockFetch(() => json({ d: [
      { Query: "a", Date: "/Date(1316156400000-0700)/", Impressions: 1 },
      { Query: "b", Date: "/Date(1326156400000-0700)/", Impressions: 1 },
    ] }));
    const r = await callTool(envWithToken(), "bing_search_performance", { siteUrl: "https://example.com/", startDate: "2012-01-01", endDate: "2012-12-31" });
    expect(r.json.result.structuredContent.rows.map((x: any) => x.query)).toEqual(["b"]);
  });

  it("page dimension labels rows by page", async () => {
    mockFetch(() => json({ d: [{ Query: "https://example.com/a", Impressions: 1 }] }));
    const r = await callTool(envWithToken(), "bing_search_performance", { siteUrl: "https://example.com/", dimension: "page" });
    expect(r.json.result.structuredContent.rows[0].page).toBe("https://example.com/a");
  });

  it("bing_url_info succeeds and rejects cross-domain without calling upstream", async () => {
    const f = mockFetch(() => json({ d: { Url: "https://example.com/a", HttpStatus: 200, IsPage: true } }));
    const okRes = await callTool(envWithToken(), "bing_url_info", { siteUrl: "https://example.com", url: "https://example.com/a" });
    expect(okRes.json.result.structuredContent.info.httpStatus).toBe(200);
    f.mockClear();
    const bad = await callTool(envWithToken(), "bing_url_info", { siteUrl: "https://example.com", url: "https://other-domain.com/foo" });
    expect(bad.json.result.isError).toBe(true);
    expect(f).not.toHaveBeenCalled();
  });

  it.each([
    [{ siteUrl: "nope" }],
    [{ siteUrl: "ftp://example.com/" }],
    [{ siteUrl: "https://example.com/", limit: 0 }],
    [{ siteUrl: "https://example.com/", limit: -5 }],
    [{ siteUrl: "https://example.com/", limit: 100000 }],
    [{ siteUrl: "https://example.com/", startDate: "2024-13-99x" }],
    [{ siteUrl: "https://example.com/", startDate: "2024-02-01", endDate: "2024-01-01" }],
  ])("rejects invalid search args %j without upstream call", async (args) => {
    const f = mockFetch(() => json({ d: [] }));
    const r = await callTool(envWithToken(), "bing_search_performance", args);
    const failed = r.json.error !== undefined || r.json.result?.isError === true;
    expect(failed).toBe(true);
    expect(f).not.toHaveBeenCalled();
  });

  it("missing binding -> safe missing_configuration error", async () => {
    const r = await callTool({}, "bing_list_sites", {});
    expect(r.json.result.isError).toBe(true);
    expect(r.text).toContain("missing_configuration");
  });
  it("empty token -> missing_configuration", async () => {
    const r = await callTool(envWithToken(""), "bing_list_sites", {});
    expect(r.text).toContain("missing_configuration");
  });

  it("provider auth failure: safe error, token never in MCP result", async () => {
    mockFetch(() => json({ ErrorCode: 3, Message: `InvalidApiKey ${TOKEN}` }, 400));
    const r = await callTool(envWithToken(), "bing_list_sites", {});
    expect(r.json.result.isError).toBe(true);
    expect(r.text).toContain("authentication");
    expect(r.text).not.toContain(TOKEN);
    expect(r.text).not.toContain("InvalidApiKey");
  });
  it("429 and 5xx map to distinct safe codes", async () => {
    mockFetch(() => json({}, 429));
    expect((await callTool(envWithToken(), "bing_list_sites", {})).text).toContain("rate_limited");
    mockFetch(() => json({ raw: "internal stack" }, 502));
    const r = await callTool(envWithToken(), "bing_list_sites", {});
    expect(r.text).toContain("upstream");
    expect(r.text).not.toContain("internal stack");
  });
  it("network failure with token in error text does not leak", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError(`failed apikey=${TOKEN}`); }));
    const r = await callTool(envWithToken(), "bing_list_sites", {});
    expect(r.text).toContain("network");
    expect(r.text).not.toContain(TOKEN);
  });
});
