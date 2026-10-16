import { describe, expect, it } from "vitest";
import {
  ClarityAnalyticsError,
  ClarityAnalyticsRepository,
  MAX_ROW_LIMIT,
  clarityHyperdriveRunner,
  normalizePageUrl,
  pageCandidates,
  parseProjectKeys,
  validatePagePrefix,
} from "../src/services/clarity-analytics";
import type { SessionRunner, SqlSession } from "../src/services/sql-session";

const NOW = new Date("2026-10-16T06:00:00Z");
const PROJECT = "proj-a";

interface Call {
  text: string;
  values: unknown[];
}
function fakeRunner(handler: (text: string, values: unknown[]) => Record<string, unknown>[]) {
  const calls: Call[] = [];
  const session: SqlSession = {
    async query(text, values = []) {
      calls.push({ text, values });
      return { rows: handler(text, values) };
    },
  };
  const run: SessionRunner = (fn) => fn(session);
  return { run, calls };
}
const logs: Record<string, unknown>[] = [];
const repo = (run: SessionRunner, keys = [PROJECT]) => new ClarityAnalyticsRepository(run, keys, () => NOW, (e) => logs.push(e));
const codeOf = async (p: Promise<unknown>) => (await p.then(() => undefined, (e) => e)) as ClarityAnalyticsError;

const runRow = (over: Record<string, unknown> = {}) => ({
  id: "41",
  status: "success",
  truncated_suspected: false,
  fetched_at: new Date("2026-10-16T00:30:10Z"),
  window_start_at: new Date("2026-10-15T00:30:00Z"),
  window_end_at: new Date("2026-10-16T00:30:00Z"),
  logical_date: "2026-10-15",
  num_days: 1,
  row_count: 3,
  normalizer_version: 1,
  ...over,
});

describe("parseProjectKeys", () => {
  it("parses, trims and de-duplicates", () => expect(parseProjectKeys(" a1 , b2,a1 ")).toEqual(["a1", "b2"]));
  it("treats missing or blank as unconfigured", () => {
    expect(parseProjectKeys(undefined)).toEqual([]);
    expect(parseProjectKeys("  ")).toEqual([]);
  });
  it("one malformed entry invalidates the whole allowlist (fail closed)", () => {
    expect(parseProjectKeys("a1,b 2")).toEqual([]);
    expect(parseProjectKeys("a1,,b2")).toEqual([]);
    expect(parseProjectKeys("a1;DROP")).toEqual([]);
  });
});

describe("normalizePageUrl (mirrors windmill-flows normalize_url)", () => {
  it.each([
    ["/", "/"],
    ["/blog", "/blog/"],
    ["/blog/post/", "/blog/post/"],
    ["https://example.com/blog/post", "/blog/post/"],
    ["https://example.com", "/"],
    ["https://example.com/a/?utm_source=x&gclid=1&fbclid=2", "/a/"],
    ["/a?b=2&a=1", "/a/?a=1&b=2"],
    ["/a?q=hello+world", "/a/?q=hello+world"],
    ["/a?q=it's", "/a/?q=it%27s"],
    ["/a?share=1&x=2", "/a/"],
    ["/a?SHARE", "/a/"],
    ["/a#frag", "/a/"],
    ["/a?flag", "/a/?flag="],
  ])("%s -> %s", (input, expected) => expect(normalizePageUrl(input)).toBe(expected));

  it.each(["", "   ", "blog/post", "//evil.example/x", "javascript:alert(1)", "ftp://example.com/a", "/a b", "/a\nb", "/a\u0000"])(
    "rejects %j",
    (input) => expect(() => normalizePageUrl(input)).toThrow(ClarityAnalyticsError),
  );
  it("rejects over-long input", () => expect(() => normalizePageUrl(`/${"a".repeat(2048)}`)).toThrow(ClarityAnalyticsError));
  it("offers the percent-decoded twin for Unicode paths", () => {
    expect(pageCandidates("/%E6%B8%AC/")).toEqual(["/%E6%B8%AC/", "/測/"]);
    expect(pageCandidates("/plain/")).toEqual(["/plain/"]);
  });
});

describe("validatePagePrefix", () => {
  it("accepts path prefixes", () => expect(validatePagePrefix("/blog/")).toBe("/blog/"));
  it.each(["blog", "//x", "/a?b", "/a#b", "/a b", ""])("rejects %j", (p) => expect(() => validatePagePrefix(p)).toThrow(ClarityAnalyticsError));
});

describe("configuration and validation", () => {
  it("fails closed with missing_configuration when no project allowlist exists", async () => {
    const { run, calls } = fakeRunner(() => []);
    const err = await codeOf(repo(run, []).overview());
    expect(err.code).toBe("missing_configuration");
    expect(calls).toHaveLength(0);
  });
  it("fails closed with missing_configuration when the Hyperdrive binding is absent", async () => {
    const err = await codeOf(repo(clarityHyperdriveRunner(undefined)).overview());
    expect(err.code).toBe("missing_configuration");
  });
  it("rejects a project that is not on the allowlist before touching the database", async () => {
    const { run, calls } = fakeRunner(() => []);
    const err = await codeOf(repo(run).overview({ projectKey: "other-project" }));
    expect(err.code).toBe("validation");
    expect(calls).toHaveLength(0);
  });
  it("requires an explicit project when several are approved", async () => {
    const { run } = fakeRunner(() => []);
    expect((await codeOf(repo(run, ["a", "b"]).overview())).code).toBe("validation");
  });
  it.each([
    { limit: 0, offset: 0 },
    { limit: MAX_ROW_LIMIT + 1, offset: 0 },
    { limit: 1.5, offset: 0 },
    { limit: 10, offset: -1 },
    { limit: 10, offset: 100_001 },
  ])("rejects paging %j", async (paging) => {
    const { run, calls } = fakeRunner(() => []);
    expect((await codeOf(repo(run).pages(paging))).code).toBe("validation");
    expect((await codeOf(repo(run).acquisition(paging))).code).toBe("validation");
    expect(calls).toHaveLength(0);
  });
});

describe("canonical run selection (statement contract)", () => {
  it("selects by project + query, only success/truncated runs with data, newest window first, and no unbounded read", async () => {
    const { run, calls } = fakeRunner(() => []);
    await codeOf(repo(run).overview());
    const sql = calls[0].text.replace(/\s+/g, " ");
    expect(calls[0].values).toEqual([PROJECT, "site_overall"]);
    expect(sql).toContain("r.project_key = $1 AND r.query_key = $2");
    expect(sql).toContain("r.status IN ('success', 'truncated')");
    expect(sql).toContain("r.fetched_at IS NOT NULL");
    expect(sql).toContain("r.row_count > 0");
    expect(sql).toContain("ORDER BY r.window_end_at DESC, r.fetched_at DESC, r.id DESC LIMIT 1");
  });
  it("reads rows of exactly the selected run, project and query only (one run, never merged)", async () => {
    const { run, calls } = fakeRunner((text) => (text.includes("clarity_fetch_runs") ? [runRow()] : [{ metric_name: "Traffic", metric_values: {} }]));
    await repo(run).overview();
    expect(calls).toHaveLength(2);
    expect(calls[1].values.slice(0, 3)).toEqual(["41", PROJECT, "site_overall"]);
    expect(calls[1].text).toMatch(/fetch_run_id = \$1 AND project_key = \$2 AND query_key = \$3/);
  });
  it("reports data_unavailable (not zero traffic) when no usable run exists", async () => {
    const { run } = fakeRunner(() => []);
    const err = await codeOf(repo(run).overview());
    expect(err.code).toBe("data_unavailable");
    expect(err.message).toMatch(/does not mean there was no traffic/);
  });
});

describe("overview mapping", () => {
  const rows = [
    { metric_name: "Engagement Time", metric_values: { totalTime: "120", activeTime: null } },
    { metric_name: "Traffic", metric_values: { totalSessionCount: "10", unknownFutureField: 7 } },
  ];
  const make = (over: Record<string, unknown> = {}) =>
    fakeRunner((text) => (text.includes("clarity_fetch_runs") ? [runRow(over)] : rows)).run;

  it("passes JSONB values through untouched, keeps nulls null, and reports coverage from the actual window", async () => {
    const r = await repo(make()).overview();
    expect(r.rows).toEqual([
      { metric: "Engagement Time", values: { totalTime: "120", activeTime: null } },
      { metric: "Traffic", values: { totalSessionCount: "10", unknownFutureField: 7 } },
    ]);
    expect(r.rowCount).toBe(2);
    expect(r.projectKey).toBe(PROJECT);
    expect(r.queryKey).toBe("site_overall");
    expect(r.coverage).toEqual({
      logicalDate: "2026-10-15",
      windowStart: "2026-10-15T00:30:00.000Z",
      windowEnd: "2026-10-16T00:30:00.000Z",
      numDays: 1,
      status: "success",
      complete: true,
      normalizerVersion: 1,
    });
    // dataThrough is the provider window boundary, not the Taipei logical date.
    expect(r.freshness).toEqual({ fetchedAt: "2026-10-16T00:30:10.000Z", dataThrough: "2026-10-16T00:30:00.000Z", stale: false });
    expect(r.truncated).toBe(false);
    expect(JSON.stringify(r)).not.toMatch(/raw_payload/);
  });
  it("flags a truncated run as incomplete", async () => {
    const r = await repo(make({ status: "truncated", truncated_suspected: true })).overview();
    expect(r.truncated).toBe(true);
    expect(r.coverage.complete).toBe(false);
    expect(r.coverage.status).toBe("truncated");
  });
  it("never reports a run complete when truncation is suspected even if status says success", async () => {
    const r = await repo(make({ truncated_suspected: true })).overview();
    expect(r.coverage.complete).toBe(false);
    expect(r.truncated).toBe(true);
  });
  it("marks old data stale and tolerates a missing fetch time as unknown", async () => {
    expect((await repo(make({ fetched_at: new Date("2026-10-01T00:00:00Z") })).overview()).freshness.stale).toBe(true);
    expect((await repo(make({ fetched_at: null })).overview()).freshness.stale).toBe("unknown");
  });
  it("replaces a non-object metric_values with null instead of inventing a number", async () => {
    const run = fakeRunner((t) => (t.includes("clarity_fetch_runs") ? [runRow()] : [{ metric_name: "Traffic", metric_values: 5 }])).run;
    expect((await repo(run).overview()).rows[0].values).toBeNull();
  });
});

describe("pages", () => {
  const handler = (hasMore: boolean) => (text: string) => {
    if (text.includes("clarity_fetch_runs")) return [runRow()];
    if (text.includes("GROUP BY url_normalized")) return hasMore ? [{ url_normalized: "/a/" }, { url_normalized: "/b/" }] : [{ url_normalized: "/a/" }];
    return [
      { url_normalized: "/a/", metric_name: "Scroll Depth", metric_values: { averageScrollDepth: 41.5 } },
      { url_normalized: "/a/", metric_name: "Traffic", metric_values: { totalSessionCount: "3" } },
      { url_normalized: "/a/", metric_name: "Traffic", metric_values: { totalSessionCount: "4" } },
    ];
  };
  it("groups metrics per page without summing duplicate observations and detects another page of results", async () => {
    const { run, calls } = fakeRunner(handler(true));
    const r = await repo(run).pages({ limit: 1, offset: 0 });
    expect(r.rows).toEqual([
      {
        page: "/a/",
        metrics: {
          "Scroll Depth": [{ averageScrollDepth: 41.5 }],
          Traffic: [{ totalSessionCount: "3" }, { totalSessionCount: "4" }],
        },
      },
    ]);
    expect(r.hasMore).toBe(true);
    expect(r.rowCount).toBe(1);
    expect(r.queryKey).toBe("page");
    // limit+1 fetched for has-more detection; offset bound as a parameter.
    expect(calls[1].values).toEqual(["41", PROJECT, "page", null, 2, 0]);
    expect(calls[2].values).toEqual(["41", PROJECT, "page", ["/a/"]]);
  });
  it("is deterministic: statements order by collation-independent keys", async () => {
    const { run, calls } = fakeRunner(handler(false));
    await repo(run).pages({ limit: 5, offset: 10, pagePrefix: "/blog/" });
    expect(calls[1].text).toContain('ORDER BY url_normalized COLLATE "C"');
    expect(calls[2].text).toContain('ORDER BY url_normalized COLLATE "C", metric_name COLLATE "C", row_hash COLLATE "C"');
    expect(calls[1].values[3]).toBe("/blog/");
    expect(calls[1].values.slice(4)).toEqual([6, 10]);
  });
  it("binds hostile prefixes as parameters or rejects them; SQL text never contains caller input", async () => {
    const payload = "/x'; DROP TABLE blog_analytics.clarity_metric_rows;--";
    const { run, calls } = fakeRunner(handler(false));
    // Whitespace makes this a validation error...
    expect((await codeOf(repo(run).pages({ limit: 5, offset: 0, pagePrefix: payload }))).code).toBe("validation");
    // ...and the whitespace-free variant is bound, never concatenated.
    const tight = "/x';DROP/**/TABLE--";
    await repo(run).pages({ limit: 5, offset: 0, pagePrefix: tight });
    for (const c of calls) expect(c.text).not.toContain("DROP");
    expect(calls[1].values).toContain(tight);
  });
  it("reports data_unavailable without a usable page run", async () => {
    const { run } = fakeRunner(() => []);
    expect((await codeOf(repo(run).pages({ limit: 5, offset: 0 }))).code).toBe("data_unavailable");
  });
});

describe("acquisition", () => {
  it("preserves null attribution and keeps cells separate", async () => {
    const { run } = fakeRunner((text) => {
      if (text.includes("clarity_fetch_runs")) return [runRow()];
      if (text.includes("GROUP BY dimension_hash")) {
        return [
          { dimension_hash: "h1", source: "google", medium: "organic", campaign: null, channel: "Search" },
          { dimension_hash: "h2", source: null, medium: null, campaign: null, channel: null },
        ];
      }
      return [
        { dimension_hash: "h1", metric_name: "Traffic", metric_values: { totalSessionCount: "5" } },
        { dimension_hash: "h2", metric_name: "Traffic", metric_values: { totalSessionCount: "9" } },
      ];
    });
    const r = await repo(run).acquisition({ limit: 10, offset: 0 });
    expect(r.queryKey).toBe("acquisition");
    expect(r.rows).toEqual([
      { source: "google", medium: "organic", campaign: null, channel: "Search", metrics: { Traffic: [{ totalSessionCount: "5" }] } },
      { source: null, medium: null, campaign: null, channel: null, metrics: { Traffic: [{ totalSessionCount: "9" }] } },
    ]);
    expect(r.hasMore).toBe(false);
    expect(JSON.stringify(r)).not.toMatch(/"total"/);
  });
});

describe("page", () => {
  const dispatch = (text: string, values: unknown[]) => {
    if (text.includes("clarity_fetch_runs")) {
      if (values[1] === "page") return [runRow({ id: "1" })];
      if (values[1] === "page_device") return [runRow({ id: "2", status: "truncated", truncated_suspected: true })];
      return []; // no usable page_source run
    }
    if (values[2] === "page") return [{ device: null, source: null, metric_name: "Traffic", metric_values: { totalSessionCount: "7" } }];
    return [
      { device: "Mobile", source: null, metric_name: "Traffic", metric_values: { totalSessionCount: "4" } },
      { device: "PC", source: null, metric_name: "Traffic", metric_values: { totalSessionCount: "3" } },
    ];
  };
  it("returns the page observation and separate device breakdown with its own coverage; missing breakdown is null", async () => {
    const { run, calls } = fakeRunner(dispatch);
    const r = await repo(run).page({ page: "https://example.com/Blog/Post?utm_medium=x" });
    expect(r.page).toBe("/Blog/Post/");
    expect(r.observation?.metrics).toEqual({ Traffic: [{ totalSessionCount: "7" }] });
    expect(r.observation?.coverage.complete).toBe(true);
    expect(r.breakdowns.device?.rows).toEqual([
      { device: "Mobile", metrics: { Traffic: [{ totalSessionCount: "4" }] } },
      { device: "PC", metrics: { Traffic: [{ totalSessionCount: "3" }] } },
    ]);
    expect(r.breakdowns.device?.truncated).toBe(true);
    expect(r.breakdowns.device?.coverage.complete).toBe(false);
    expect(r.breakdowns.source).toBeNull();
    // Candidate identities are bound as an array parameter.
    expect(calls.find((c) => c.text.includes("url_normalized = ANY"))?.values[3]).toEqual(["/Blog/Post/"]);
  });
  it("returns data_unavailable when the page has no rows anywhere", async () => {
    const { run } = fakeRunner((text) => (text.includes("clarity_fetch_runs") ? [runRow()] : []));
    expect((await codeOf(repo(run).page({ page: "/missing/" }))).code).toBe("data_unavailable");
  });
  it("rejects invalid pages before any query", async () => {
    const { run, calls } = fakeRunner(() => []);
    expect((await codeOf(repo(run).page({ page: "javascript:alert(1)" }))).code).toBe("validation");
    expect(calls).toHaveLength(0);
  });
});

describe("database failure sanitization", () => {
  it("returns a fixed message and logs only the SQLSTATE", async () => {
    logs.length = 0;
    const boom = Object.assign(new Error("connect ECONNREFUSED postgres://user:hunter2@db.internal:5432/x SELECT secret"), { code: "08006" });
    const err = await codeOf(repo((async () => Promise.reject(boom)) as SessionRunner).overview());
    expect(err.code).toBe("database_unavailable");
    expect(err.message).not.toMatch(/hunter2|db\.internal|SELECT/);
    expect(JSON.stringify(logs)).not.toMatch(/hunter2|db\.internal|SELECT/);
    expect(logs.at(-1)).toMatchObject({ operation: "clarity_overview", status: "database_error", sqlState: "08006" });
  });
  it("logs success without metric values", async () => {
    logs.length = 0;
    const { run } = fakeRunner((t) => (t.includes("clarity_fetch_runs") ? [runRow()] : [{ metric_name: "Traffic", metric_values: { totalSessionCount: "999" } }]));
    await repo(run).overview();
    expect(JSON.stringify(logs)).not.toContain("999");
    expect(Object.keys(logs.at(-1)!).sort()).toEqual(["latencyMs", "operation", "status"]);
  });
});

describe("static SQL safety", () => {
  it("clarity service contains no write statements and uses only the shared read-only runner", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(new URL("../src/services/clarity-analytics.ts", import.meta.url), "utf8").replace(/^\s*\/\/.*$/gm, "");
    expect(src).not.toMatch(/\b(INSERT|UPDATE|DELETE|DROP|ALTER|TRUNCATE|CREATE|GRANT)\b\s/);
    expect(src).not.toMatch(/raw_payload|\bapi_token\b|clarity\.ms/i);
    expect(src).not.toMatch(/from\s+"pg"/);
    const shared = readFileSync(new URL("../src/services/sql-session.ts", import.meta.url), "utf8");
    expect(shared).toContain("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
  });
});
