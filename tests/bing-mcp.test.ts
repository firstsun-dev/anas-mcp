import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/index";
import { mcpCall } from "./helpers";

// Fake pg driver so requests go through the real worker -> MCP -> repository -> hyperdriveRunner path.
const db = vi.hoisted(() => ({
  statements: [] as string[],
  handler: ((_text: string, _values: unknown[]) => []) as (text: string, values: unknown[]) => Record<string, unknown>[],
  connectError: undefined as Error | undefined,
  connectionString: undefined as string | undefined,
}));
vi.mock("pg", () => ({
  Client: class {
    constructor(config: { connectionString: string }) {
      db.connectionString = config.connectionString;
    }
    async connect() {
      if (db.connectError) throw db.connectError;
    }
    async query(text: string, values: unknown[] = []) {
      db.statements.push(text.trim().split(/\s+/)[0]);
      if (/^(BEGIN|COMMIT|ROLLBACK)/.test(text)) return { rows: [] };
      return { rows: db.handler(text, values) };
    }
    async end() {}
  },
}));

const env: Env = { ANALYTICS_DB: { connectionString: "postgres://hyperdrive.invalid/db" } as unknown as Hyperdrive };
const call = (name: string, args: Record<string, unknown>, e: Env = env) => mcpCall(e, "tools/call", { name, arguments: args });
const SITE = "https://example.com/";

beforeEach(() => {
  db.statements = [];
  db.connectError = undefined;
  db.handler = () => [];
});

describe("MCP tool registration", () => {
  it("lists exactly health, bing_list_sites, bing_search_performance", async () => {
    const r = await mcpCall(env, "tools/list");
    const tools = r.json.result.tools;
    expect(tools.map((t: any) => t.name).sort()).toEqual(["bing_list_sites", "bing_search_performance", "health"]);
    for (const t of tools.filter((t: any) => t.name.startsWith("bing_"))) expect(t.annotations.readOnlyHint).toBe(true);
  });
  it("exposes no bing_url_info, write, or generic SQL tools", async () => {
    const names: string[] = (await mcpCall(env, "tools/list")).json.result.tools.map((t: any) => t.name);
    expect(names).not.toContain("bing_url_info");
    for (const n of names) expect(n).not.toMatch(/submit|delete|update|create|sitemap|add|remove|verify|configure|request|sql|query|execute/i);
  });
  it("adds no HTTP route beyond /health and /mcp", async () => {
    const { default: worker } = await import("../src/index");
    const res = await worker.fetch(new Request("http://localhost/bing"), {}, {} as ExecutionContext);
    expect(res.status).not.toBe(200);
  });
});

describe("bing_list_sites", () => {
  it("serves persisted sites with freshness and no verification codes", async () => {
    db.handler = () => [{ site_url: SITE, is_verified: true, fetched_at: new Date() }];
    const r = await call("bing_list_sites", {});
    const out = r.json.result.structuredContent;
    expect(out.sites).toEqual([{ url: SITE, isVerified: true }]);
    expect(out.freshness).toMatchObject({ stale: false, dataThrough: null });
    expect(out.freshness.fetchedAt).toEqual(expect.any(String));
    expect(r.text).not.toMatch(/AuthenticationCode|DnsVerificationCode/);
    expect(db.connectionString).toBe("postgres://hyperdrive.invalid/db");
  });

  it("runs inside a read-only transaction", async () => {
    db.handler = () => [{ site_url: SITE, is_verified: true, fetched_at: new Date() }];
    await call("bing_list_sites", {});
    expect(db.statements).toEqual(["BEGIN", "SELECT", "COMMIT"]);
  });

  it("returns data_unavailable when nothing was ingested yet", async () => {
    const r = await call("bing_list_sites", {});
    expect(r.json.result.isError).toBe(true);
    expect(JSON.parse(r.json.result.content[0].text).error.code).toBe("data_unavailable");
  });
});

describe("bing_search_performance", () => {
  const stat = { dimension_value: "firstsun", stat_date: "2026-09-17", impressions: "10", clicks: null, avg_click_position: null, avg_impression_position: 4 };
  const serve = (text: string) => (text.includes("bing_latest_search_runs") ? [{ fetch_run_id: "1", fetched_at: new Date("2026-09-20T18:30:00Z"), data_through: "2026-09-17" }] : [stat]);

  it("keys rows by the requested dimension and includes freshness", async () => {
    db.handler = serve;
    const out = (await call("bing_search_performance", { siteUrl: SITE, dimension: "page" })).json.result.structuredContent;
    expect(out.rows[0]).toEqual({ page: "firstsun", date: "2026-09-17", impressions: 10, clicks: null, avgClickPosition: null, avgImpressionPosition: 4 });
    expect(out.freshness).toMatchObject({ fetchedAt: "2026-09-20T18:30:00.000Z", dataThrough: "2026-09-17" });
    expect(["boolean", "string"]).toContain(typeof out.freshness.stale);
    expect(out).toMatchObject({ siteUrl: SITE, dimension: "page", rowCount: 1, offset: 0, truncated: false });
  });

  it("applies default limit/offset and dimension", async () => {
    let values: unknown[] = [];
    db.handler = (text, v) => {
      if (!text.includes("bing_latest_search_runs")) values = v;
      return serve(text);
    };
    await call("bing_search_performance", { siteUrl: SITE });
    expect(values).toEqual([SITE, "query", null, null, 26, 0]);
  });

  it("rejects out-of-range limits and bad dates at the schema boundary without querying", async () => {
    for (const args of [{ limit: 201 }, { limit: 0 }, { offset: -1 }, { startDate: "2026-13-01" }]) {
      const r = await call("bing_search_performance", { siteUrl: SITE, ...args });
      expect(r.json.error ?? r.json.result?.isError).toBeTruthy();
    }
    expect(db.statements).toEqual([]);
  });

  it("returns data_unavailable when the site has no successful ingestion", async () => {
    const r = await call("bing_search_performance", { siteUrl: SITE });
    expect(JSON.parse(r.json.result.content[0].text).error.code).toBe("data_unavailable");
  });

  it("returns a safe database_unavailable error without leaking connection details", async () => {
    db.connectError = new Error("connect ECONNREFUSED postgres://reader:hunter2@10.1.2.3:5432/windmill_pipeline");
    const r = await call("bing_search_performance", { siteUrl: SITE });
    expect(r.json.result.isError).toBe(true);
    expect(JSON.parse(r.json.result.content[0].text).error.code).toBe("database_unavailable");
    expect(r.text).not.toMatch(/hunter2|10\.1\.2\.3|reader|windmill_pipeline/);
  });

  it("reports missing_configuration when the Hyperdrive binding is absent", async () => {
    const r = await call("bing_list_sites", {}, {});
    expect(JSON.parse(r.json.result.content[0].text).error.code).toBe("missing_configuration");
  });
});
