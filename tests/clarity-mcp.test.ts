import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/index";
import { accessEnv, mcpCall, rawMcpRequest } from "./helpers";

// Fake pg driver so requests go through the real worker -> MCP -> repository -> hyperdriveRunner path.
const db = vi.hoisted(() => ({
  statements: [] as string[],
  handler: ((_text: string, _values: unknown[]) => []) as (text: string, values: unknown[]) => Record<string, unknown>[],
  connectError: undefined as Error | undefined,
  connections: 0,
}));
vi.mock("pg", () => ({
  Client: class {
    async connect() {
      db.connections++;
      if (db.connectError) throw db.connectError;
    }
    async query(text: string, values: unknown[] = []) {
      db.statements.push(text.trim().split(/\s+/).slice(0, 4).join(" "));
      if (/^(BEGIN|COMMIT|ROLLBACK)/.test(text)) return { rows: [] };
      return { rows: db.handler(text, values) };
    }
    async end() {}
  },
}));

const binding = { connectionString: "postgres://hyperdrive.invalid/db" } as unknown as Hyperdrive;
const env: Env = { ANALYTICS_DB: binding, CLARITY_PROJECT_KEYS: "proj-a" };
const call = (name: string, args: Record<string, unknown>, e: Env = env) => mcpCall(e, "tools/call", { name, arguments: args });
const payload = (r: Awaited<ReturnType<typeof call>>) => r.json.result.structuredContent;
const errorOf = (r: Awaited<ReturnType<typeof call>>) => JSON.parse(r.json.result.content[0].text).error;

const runRow = {
  id: "7",
  status: "success",
  truncated_suspected: false,
  fetched_at: new Date(),
  window_start_at: new Date(Date.now() - 86_400_000),
  window_end_at: new Date(),
  logical_date: "2026-10-15",
  num_days: 1,
  row_count: 2,
  normalizer_version: 1,
};
function healthy(text: string) {
  if (text.includes("clarity_fetch_runs")) return [runRow];
  if (text.includes("GROUP BY url_normalized")) return [{ url_normalized: "/blog/a/" }];
  if (text.includes("GROUP BY dimension_hash")) return [{ dimension_hash: "h", source: "bing", medium: "organic", campaign: null, channel: null }];
  if (text.includes("FROM blog_analytics.clarity_metric_rows")) {
    return [{ url_normalized: "/blog/a/", dimension_hash: "h", device: null, source: null, metric_name: "Traffic", metric_values: { totalSessionCount: "5" }, group_rows: "1" }];
  }
  return [];
}

beforeEach(() => {
  db.statements = [];
  db.connectError = undefined;
  db.connections = 0;
  db.handler = healthy;
});

describe("tool registration and health", () => {
  it("registers the four Clarity tools next to Bing and health, all read-only", async () => {
    const tools = (await mcpCall(env, "tools/list")).json.result.tools;
    expect(tools.map((t: any) => t.name).sort()).toEqual([
      "bing_list_sites",
      "bing_search_performance",
      "clarity_acquisition",
      "clarity_overview",
      "clarity_page",
      "clarity_pages",
      "health",
    ]);
    for (const t of tools.filter((t: any) => t.name.startsWith("clarity_"))) {
      expect(t.annotations).toEqual({ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false });
    }
  });
  it("exposes no SQL, write, or Clarity-API tool", async () => {
    const names: string[] = (await mcpCall(env, "tools/list")).json.result.tools.map((t: any) => t.name);
    for (const n of names.filter((n) => n.startsWith("clarity_"))) expect(n).not.toMatch(/sql|query|execute|write|sync|fetch|export/i);
  });
  it("bounds inputs: schemas cap limit/offset and carry no SQL-like argument", async () => {
    const tools = (await mcpCall(env, "tools/list")).json.result.tools;
    const pages = tools.find((t: any) => t.name === "clarity_pages").inputSchema.properties;
    expect(pages.limit).toMatchObject({ minimum: 1, maximum: 100 });
    expect(pages.offset).toMatchObject({ minimum: 0, maximum: 100000 });
    expect(Object.keys(pages).sort()).toEqual(["limit", "offset", "pagePrefix", "projectKey"]);
  });
  it("health marks Clarity enabled only when binding and project allowlist exist, keeping plannedSources", async () => {
    const health = async (e: Env) => JSON.parse((await mcpCall(e, "tools/call", { name: "health", arguments: {} })).json.result.content[0].text);
    expect(await health(env)).toEqual({ service: "anas-mcp", status: "ok", enabledSources: ["bing", "clarity"], plannedSources: ["ga4", "search-console"] });
    expect((await health({ ANALYTICS_DB: binding })).enabledSources).toEqual(["bing"]);
    expect((await health({ ANALYTICS_DB: binding, CLARITY_PROJECT_KEYS: "bad key" })).enabledSources).toEqual(["bing"]);
    expect((await health({ CLARITY_PROJECT_KEYS: "proj-a" })).enabledSources).toEqual([]);
    expect((await health({})).plannedSources).toEqual(["ga4", "search-console"]);
  });
});

describe("authentication precedes MCP and database access", () => {
  it("rejects an unauthenticated Clarity call without opening a database connection", async () => {
    const res = await rawMcpRequest(accessEnv(env), {}, { method: "tools/call", params: { name: "clarity_overview", arguments: {} } });
    expect(res.status).toBe(401);
    expect(db.connections).toBe(0);
    expect(db.statements).toEqual([]);
  });
});

describe("clarity tools over MCP", () => {
  it("clarity_overview returns structured content, JSON text, and runs inside a read-only transaction", async () => {
    const r = await call("clarity_overview", {});
    expect(r.json.result.isError).toBeUndefined();
    const body = payload(r);
    expect(body).toMatchObject({ projectKey: "proj-a", queryKey: "site_overall", sourceTruncated: false, responseTruncated: false, responseComplete: true, rowCount: 1 });
    expect(body.coverage.sourceComplete).toBe(true);
    expect(JSON.parse(r.json.result.content[0].text)).toEqual(body);
    expect(db.statements[0]).toBe("BEGIN ISOLATION LEVEL REPEATABLE");
    expect(db.statements.at(-1)).toBe("COMMIT");
  });
  it("clarity_pages / clarity_acquisition / clarity_page return their shapes", async () => {
    expect(payload(await call("clarity_pages", { limit: 5, pagePrefix: "/blog/" })).rows[0]).toEqual({ page: "/blog/a/", metrics: { Traffic: [{ totalSessionCount: "5" }] }, metricsTruncated: false, metricRowTotal: 1 });
    expect(payload(await call("clarity_acquisition", {})).rows[0]).toMatchObject({ source: "bing", medium: "organic", campaign: null, channel: null });
    const page = payload(await call("clarity_page", { page: "/blog/a" }));
    expect(page.page).toBe("/blog/a/");
    expect(page.observation.metrics).toEqual({ Traffic: [{ totalSessionCount: "5" }] });
  });
  it("applies schema defaults and rejects out-of-range input at the MCP layer", async () => {
    const r = await call("clarity_pages", { limit: 1000 });
    expect(r.json.error ?? r.json.result.isError).toBeTruthy();
    expect(db.connections).toBe(0);
  });
  it("returns validation for a bad page without database access", async () => {
    const r = await call("clarity_page", { page: "//evil.example/x" });
    expect(r.json.result.isError).toBe(true);
    expect(errorOf(r).code).toBe("validation");
    expect(db.connections).toBe(0);
  });
  it("rejects a project outside the allowlist (isolation)", async () => {
    const r = await call("clarity_overview", { projectKey: "proj-b" });
    expect(errorOf(r).code).toBe("validation");
    expect(db.connections).toBe(0);
  });
  it("scopes every statement to the allowlisted project", async () => {
    const seen: unknown[][] = [];
    db.handler = (text, values) => {
      seen.push(values);
      return healthy(text);
    };
    await call("clarity_pages", {});
    expect(seen.every((v) => v[0] === "proj-a" || v[1] === "proj-a")).toBe(true);
  });
  it("fails closed with missing_configuration without project allowlist or binding", async () => {
    expect(errorOf(await call("clarity_overview", {}, { ANALYTICS_DB: binding })).code).toBe("missing_configuration");
    expect(errorOf(await call("clarity_overview", {}, { CLARITY_PROJECT_KEYS: "proj-a" })).code).toBe("missing_configuration");
    expect(db.connections).toBe(0);
  });
  it("reports data_unavailable, not zero traffic, when nothing was ingested", async () => {
    db.handler = () => [];
    const e = errorOf(await call("clarity_overview", {}));
    expect(e.code).toBe("data_unavailable");
    expect(e.message).toMatch(/no traffic/);
  });
  it("reports a page dataset without URLs as data_quality over MCP, with a safe message", async () => {
    db.handler = (text) => (text.includes("clarity_fetch_runs") ? [{ ...runRow, row_count: 286 }] : text.includes("EXISTS") ? [{ has_url: false }] : []);
    for (const [tool, args] of [["clarity_pages", {}], ["clarity_page", { page: "/blog/a/" }]] as const) {
      const r = await call(tool, args);
      expect(r.json.result.isError).toBe(true);
      expect(errorOf(r).code).toBe("data_quality");
      expect(errorOf(r).message).toMatch(/not an absence of pages or traffic/);
      expect(r.text).not.toMatch(/SELECT|raw_payload|postgres:\/\//i);
    }
  });
  it("keeps overview and acquisition working when the page dataset has no URLs", async () => {
    db.handler = (text) => {
      if (text.includes("EXISTS")) return [{ has_url: false }];
      return healthy(text);
    };
    expect(payload(await call("clarity_overview", {})).queryKey).toBe("site_overall");
    expect(payload(await call("clarity_acquisition", {})).rows[0].source).toBe("bing");
  });
  it("sanitizes database failures", async () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    db.connectError = Object.assign(new Error("connect to postgres://u:hunter2@db.internal failed"), { code: "ECONNREFUSED" });
    const r = await call("clarity_overview", {});
    expect(r.text).not.toMatch(/hunter2|db\.internal|postgres:\/\//);
    expect(errorOf(r).code).toBe("database_unavailable");
    expect(JSON.stringify(spy.mock.calls)).not.toMatch(/hunter2|db\.internal/);
    spy.mockRestore();
  });
});

describe("Bing regression", () => {
  it("bing_list_sites still works beside Clarity", async () => {
    db.handler = () => [{ site_url: "https://example.com/", is_verified: true, fetched_at: new Date() }];
    const r = await call("bing_list_sites", {});
    expect(payload(r).sites).toEqual([{ url: "https://example.com/", isVerified: true }]);
  });
  it("Bing keeps working when Clarity is unconfigured", async () => {
    db.handler = () => [{ site_url: "https://example.com/", is_verified: true, fetched_at: new Date() }];
    const r = await call("bing_list_sites", {}, { ANALYTICS_DB: binding });
    expect(r.json.result.isError).toBeUndefined();
  });
});
