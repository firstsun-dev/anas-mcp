import { describe, expect, it } from "vitest";
import {
  ClarityAnalyticsError,
  ClarityAnalyticsRepository,
  MAX_DETAIL_ROWS,
  MAX_GROUP_ROWS,
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
      sourceComplete: true,
      normalizerVersion: 1,
    });
    // dataThrough is the provider window boundary, not the Taipei logical date.
    expect(r.freshness).toEqual({ fetchedAt: "2026-10-16T00:30:10.000Z", dataThrough: "2026-10-16T00:30:00.000Z", stale: false });
    expect(r.sourceTruncated).toBe(false);
    expect(r.responseTruncated).toBe(false);
    expect(r.responseComplete).toBe(true);
    expect(JSON.stringify(r)).not.toMatch(/raw_payload/);
  });
  it("flags a truncated run as incomplete", async () => {
    const r = await repo(make({ status: "truncated", truncated_suspected: true })).overview();
    expect(r.sourceTruncated).toBe(true);
    expect(r.coverage.sourceComplete).toBe(false);
    expect(r.coverage.status).toBe("truncated");
    // Ingestion state is preserved; the response itself dropped nothing, but is not effectively complete either.
    expect(r.responseTruncated).toBe(false);
    expect(r.responseComplete).toBe(false);
  });
  it("never reports a run complete when truncation is suspected even if status says success", async () => {
    const r = await repo(make({ truncated_suspected: true })).overview();
    expect(r.coverage.sourceComplete).toBe(false);
    expect(r.sourceTruncated).toBe(true);
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
      { url_normalized: "/a/", metric_name: "Scroll Depth", metric_values: { averageScrollDepth: 41.5 }, group_rows: "3" },
      { url_normalized: "/a/", metric_name: "Traffic", metric_values: { totalSessionCount: "3" }, group_rows: "3" },
      { url_normalized: "/a/", metric_name: "Traffic", metric_values: { totalSessionCount: "4" }, group_rows: "3" },
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
        metricsTruncated: false,
        metricRowTotal: 3,
      },
    ]);
    // Another page exists, but nothing was dropped: hasMore is independent of truncation.
    expect(r.hasMore).toBe(true);
    expect(r.nextOffset).toBe(1);
    expect(r.responseTruncated).toBe(false);
    expect(r.responseComplete).toBe(true);
    expect(r.rowCount).toBe(1);
    expect(r.queryKey).toBe("page");
    // limit+1 fetched for has-more detection; offset bound as a parameter.
    expect(calls[1].values).toEqual(["41", PROJECT, "page", null, 2, 0]);
    expect(calls[2].values).toEqual(["41", PROJECT, "page", ["/a/"], MAX_GROUP_ROWS, MAX_DETAIL_ROWS + 1]);
  });
  it("is deterministic: statements order by collation-independent keys", async () => {
    const { run, calls } = fakeRunner(handler(false));
    await repo(run).pages({ limit: 5, offset: 10, pagePrefix: "/blog/" });
    expect(calls[1].text).toContain('ORDER BY url_normalized COLLATE "C"');
    expect(calls[2].text).toContain('ORDER BY metric_name COLLATE "C", row_hash COLLATE "C"');
    expect(calls[2].text).toContain('ORDER BY url_normalized COLLATE "C", rn');
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

describe("page dataset data quality (zero normalized URLs)", () => {
  const noUrlRun = (text: string, values: unknown[] = []) => {
    if (text.includes("clarity_fetch_runs")) return [runRow({ row_count: 286 })];
    if (text.includes("EXISTS")) return [{ has_url: false }];
    return [];
  };
  const withUrls = (hasUrl: boolean, keys: Record<string, unknown>[] = []) => (text: string) => {
    if (text.includes("clarity_fetch_runs")) return [runRow({ row_count: 286 })];
    if (text.includes("EXISTS")) return [{ has_url: hasUrl }];
    if (text.includes("GROUP BY url_normalized")) return keys;
    return [];
  };

  it("a 286-row run with zero normalized URLs is a data_quality error, not an empty success", async () => {
    const { run } = fakeRunner(noUrlRun);
    const err = await codeOf(repo(run).pages({ limit: 25, offset: 0 }));
    expect(err.code).toBe("data_quality");
    expect(err.message).toMatch(/page URL dimension/);
    expect(err.message).toMatch(/not an absence of pages or traffic/);
    expect(err.message).not.toMatch(/SELECT|blog_analytics|postgres|raw_payload/i);
  });
  it("a prefix filter on a run with zero URLs still reports the data-quality problem, not zero matches", async () => {
    const { run } = fakeRunner(noUrlRun);
    expect((await codeOf(repo(run).pages({ limit: 5, offset: 0, pagePrefix: "/blog/" }))).code).toBe("data_quality");
  });
  it("a legitimate prefix filter with no matches returns an empty collection", async () => {
    const { run } = fakeRunner(withUrls(true));
    const r = await repo(run).pages({ limit: 5, offset: 0, pagePrefix: "/nothing/" });
    expect(r.rows).toEqual([]);
    expect(r.rowCount).toBe(0);
    expect(r.hasMore).toBe(false);
    expect(r.nextOffset).toBeNull();
  });
  it("paging past the end of a dataset that has URLs is an empty page, not an error", async () => {
    const { run } = fakeRunner(withUrls(true));
    expect((await repo(run).pages({ limit: 5, offset: 50 })).rows).toEqual([]);
  });
  it("a dataset with pages never runs the probe, and the probe is a bounded parameterized EXISTS", async () => {
    const found = fakeRunner((text) => (text.includes("GROUP BY url_normalized") ? [{ url_normalized: "/a/" }] : text.includes("clarity_fetch_runs") ? [runRow()] : [{ url_normalized: "/a/", metric_name: "Traffic", metric_values: {}, group_rows: "1" }]));
    await repo(found.run).pages({ limit: 5, offset: 0 });
    expect(found.calls.some((c) => c.text.includes("EXISTS"))).toBe(false);
    const empty = fakeRunner(noUrlRun);
    await codeOf(repo(empty.run).pages({ limit: 5, offset: 0 }));
    const probe = empty.calls.find((c) => c.text.includes("EXISTS"))!;
    expect(probe.values).toEqual(["41", PROJECT, "page"]);
    expect(probe.text).toContain("fetch_run_id = $1 AND project_key = $2 AND query_key = $3");
  });
  it("a missing or malformed probe result never crashes and is not mistaken for missing URLs", async () => {
    for (const probe of [[], [{}], [{ has_url: null }], [{ has_url: "nope" }]]) {
      const { run } = fakeRunner((text) => (text.includes("clarity_fetch_runs") ? [runRow()] : text.includes("EXISTS") ? probe : []));
      expect((await repo(run).pages({ limit: 5, offset: 0 })).rows).toEqual([]);
    }
  });
  it("source truncation stays independent of data quality", async () => {
    const { run } = fakeRunner((text) => (text.includes("clarity_fetch_runs") ? [runRow({ status: "truncated", truncated_suspected: true })] : text.includes("EXISTS") ? [{ has_url: true }] : []));
    const r = await repo(run).pages({ limit: 5, offset: 0 });
    expect(r.sourceTruncated).toBe(true);
    expect(r.responseTruncated).toBe(false);
    expect(r.responseComplete).toBe(false);
  });
  it("clarity_page: a nonexistent page in a dataset that has URLs is data_unavailable", async () => {
    const { run } = fakeRunner((text) => (text.includes("clarity_fetch_runs") ? [runRow()] : text.includes("EXISTS") ? [{ has_url: true }] : []));
    const err = await codeOf(repo(run).page({ page: "/missing/" }));
    expect(err.code).toBe("data_unavailable");
    expect(err.message).toMatch(/does not mean zero traffic/);
  });
  it("clarity_page: an ingestion without URLs is data_quality, distinct from an unknown page", async () => {
    const { run } = fakeRunner(noUrlRun);
    expect((await codeOf(repo(run).page({ page: "/blog/a/" }))).code).toBe("data_quality");
  });
  it("clarity_page still returns data when only some sections lack URLs", async () => {
    const { run } = fakeRunner((text, values) => {
      if (text.includes("clarity_fetch_runs")) return [runRow()];
      if (text.includes("EXISTS")) return [{ has_url: false }];
      if (values[2] === "page") return [{ device: null, source: null, metric_name: "Traffic", metric_values: { totalSessionCount: "7" }, group_rows: "1" }];
      return [];
    });
    const r = await repo(run).page({ page: "/blog/a/" });
    expect(r.observation?.metrics).toEqual({ Traffic: [{ totalSessionCount: "7" }] });
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
        { dimension_hash: "h1", metric_name: "Traffic", metric_values: { totalSessionCount: "5" }, group_rows: "1" },
        { dimension_hash: "h2", metric_name: "Traffic", metric_values: { totalSessionCount: "9" }, group_rows: "1" },
      ];
    });
    const r = await repo(run).acquisition({ limit: 10, offset: 0 });
    expect(r.queryKey).toBe("acquisition");
    expect(r.rows).toEqual([
      { source: "google", medium: "organic", campaign: null, channel: "Search", metrics: { Traffic: [{ totalSessionCount: "5" }] }, metricsTruncated: false, metricRowTotal: 1 },
      { source: null, medium: null, campaign: null, channel: null, metrics: { Traffic: [{ totalSessionCount: "9" }] }, metricsTruncated: false, metricRowTotal: 1 },
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
    if (values[2] === "page") return [{ device: null, source: null, metric_name: "Traffic", metric_values: { totalSessionCount: "7" }, group_rows: "1" }];
    return [
      { device: "Mobile", source: null, metric_name: "Traffic", metric_values: { totalSessionCount: "4" }, group_rows: "1" },
      { device: "PC", source: null, metric_name: "Traffic", metric_values: { totalSessionCount: "3" }, group_rows: "1" },
    ];
  };
  it("returns the page observation and separate device breakdown with its own coverage; missing breakdown is null", async () => {
    const { run, calls } = fakeRunner(dispatch);
    const r = await repo(run).page({ page: "https://example.com/Blog/Post?utm_medium=x" });
    expect(r.page).toBe("/Blog/Post/");
    expect(r.observation?.metrics).toEqual({ Traffic: [{ totalSessionCount: "7" }] });
    expect(r.observation?.coverage.sourceComplete).toBe(true);
    expect(r.breakdowns.device?.rows).toEqual([
      { device: "Mobile", metrics: { Traffic: [{ totalSessionCount: "4" }] }, metricsTruncated: false, metricRowTotal: 1 },
      { device: "PC", metrics: { Traffic: [{ totalSessionCount: "3" }] }, metricsTruncated: false, metricRowTotal: 1 },
    ]);
    expect(r.breakdowns.device?.sourceTruncated).toBe(true);
    expect(r.breakdowns.device?.responseTruncated).toBe(false);
    expect(r.breakdowns.device?.responseComplete).toBe(false);
    expect(r.breakdowns.device?.coverage.sourceComplete).toBe(false);
    expect(r.sourceTruncated).toBe(true);
    expect(r.responseTruncated).toBe(false);
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

// ---------------------------------------------------------------------------------------------------------------
// Bounded detail reads and source/response truncation (Gate 2)
// ---------------------------------------------------------------------------------------------------------------
describe("bounded detail queries (statement contract)", () => {
  it.each([
    ["PAGE_ROWS", "GROUP BY url_normalized", "pages"],
    ["ACQUISITION_ROWS", "GROUP BY dimension_hash", "acquisition"],
  ] as const)("%s binds a per-group cap and an overall LIMIT", async (_n, groupBy, tool) => {
    const { run, calls } = fakeRunner((t) => {
      if (t.includes("clarity_fetch_runs")) return [runRow()];
      if (t.includes(groupBy)) return [{ url_normalized: "/a/", dimension_hash: "h1" }];
      return [{ url_normalized: "/a/", dimension_hash: "h1", metric_name: "Traffic", metric_values: {}, group_rows: "1" }];
    });
    await repo(run)[tool]({ limit: 5, offset: 0 });
    const detail = calls.at(-1)!;
    expect(detail.text).toMatch(/WHERE rn <= \$5/);
    expect(detail.text).toMatch(/LIMIT \$6/);
    expect(detail.text).toContain("row_number() OVER (PARTITION BY");
    expect(detail.values.slice(-2)).toEqual([MAX_GROUP_ROWS, MAX_DETAIL_ROWS + 1]);
  });
  it("clarity_page detail query is bounded the same way", async () => {
    const { run, calls } = fakeRunner((t) => (t.includes("clarity_fetch_runs") ? [runRow()] : []));
    await codeOf(repo(run).page({ page: "/a/" }));
    const detail = calls.find((c) => c.text.includes("PARTITION BY device, source"))!;
    expect(detail.text).toMatch(/WHERE rn <= \$5/);
    expect(detail.text).toMatch(/LIMIT \$6/);
    expect(detail.values.slice(-2)).toEqual([MAX_GROUP_ROWS, MAX_DETAIL_ROWS + 1]);
  });
});

describe("oversized groups are never presented as complete", () => {
  const rowsFor = (key: string, n: number, total: number, col = "url_normalized") =>
    Array.from({ length: n }, (_, i) => ({ [col]: key, metric_name: `M${String(i).padStart(4, "0")}`, metric_values: { v: i }, group_rows: String(total) }));

  it("pages: a single page with more metric rows than the cap is flagged, not silently clipped", async () => {
    const { run } = fakeRunner((t) => {
      if (t.includes("clarity_fetch_runs")) return [runRow()];
      if (t.includes("GROUP BY url_normalized")) return [{ url_normalized: "/big/" }];
      return rowsFor("/big/", MAX_GROUP_ROWS, 750); // SQL cap applied: 100 of 750
    });
    const r = await repo(run).pages({ limit: 1, offset: 0 });
    expect(r.rows).toHaveLength(1);
    expect(Object.keys(r.rows[0].metrics)).toHaveLength(MAX_GROUP_ROWS);
    expect(r.rows[0]).toMatchObject({ metricsTruncated: true, metricRowTotal: 750 });
    expect(r.responseTruncated).toBe(true);
    expect(r.responseComplete).toBe(false);
    expect(r.sourceTruncated).toBe(false); // ingestion was fine
    expect(r.coverage.status).toBe("success");
    expect(r.hasMore).toBe(false); // independent of truncation
    expect(r.nextOffset).toBeNull();
  });
  it("pages: whole pages that do not fit the row budget are deferred with a stable continuation offset", async () => {
    // 6 pages x 100 rows = 600 > 500: the SQL LIMIT (501) cuts page 6; pages 1-5 fit exactly.
    const keys = ["/p1/", "/p2/", "/p3/", "/p4/", "/p5/", "/p6/"];
    const all = keys.flatMap((k) => rowsFor(k, 100, 100)).slice(0, MAX_DETAIL_ROWS + 1);
    const { run, calls } = fakeRunner((t) => {
      if (t.includes("clarity_fetch_runs")) return [runRow()];
      if (t.includes("GROUP BY url_normalized")) return keys.map((k) => ({ url_normalized: k }));
      return all;
    });
    const first = await repo(run).pages({ limit: 6, offset: 0 });
    expect(first.rows.map((x) => x.page)).toEqual(keys.slice(0, 5));
    expect(first.rowCount).toBe(5);
    expect(first.hasMore).toBe(true);
    expect(first.nextOffset).toBe(5);
    expect(first.responseTruncated).toBe(true);
    expect(first.responseComplete).toBe(false);
    expect(first.rows.every((x) => !x.metricsTruncated)).toBe(true); // returned pages are whole
    expect(calls.at(-1)!.values.at(-1)).toBe(MAX_DETAIL_ROWS + 1);

    // Continuing from nextOffset re-issues the key query at that offset (stable ordering, no skipped page).
    const second = await repo(run).pages({ limit: 6, offset: first.nextOffset! });
    const keyCall = calls.filter((c) => c.text.includes("GROUP BY url_normalized")).at(-1)!;
    expect(keyCall.values.slice(-2)).toEqual([7, 5]);
    expect(second.offset).toBe(5);
  });
  it("pages: returned page count never exceeds the row budget", async () => {
    const keys = Array.from({ length: 40 }, (_, i) => `/p${String(i).padStart(2, "0")}/`);
    const all = keys.flatMap((k) => rowsFor(k, 30, 30)).slice(0, MAX_DETAIL_ROWS + 1);
    const { run } = fakeRunner((t) => (t.includes("clarity_fetch_runs") ? [runRow()] : t.includes("GROUP BY url_normalized") ? keys.map((k) => ({ url_normalized: k })) : all));
    const r = await repo(run).pages({ limit: 40, offset: 0 });
    const metricRows = r.rows.reduce((n, x) => n + Object.values(x.metrics).reduce((m, v) => m + v.length, 0), 0);
    expect(metricRows).toBeLessThanOrEqual(MAX_DETAIL_ROWS);
    expect(r.rowCount).toBe(16); // floor(500/30)
    expect(r.nextOffset).toBe(16);
  });
  it("pages: a missing group_rows count fails safe (flagged incomplete)", async () => {
    const { run } = fakeRunner((t) => {
      if (t.includes("clarity_fetch_runs")) return [runRow()];
      if (t.includes("GROUP BY url_normalized")) return [{ url_normalized: "/a/" }];
      return [{ url_normalized: "/a/", metric_name: "Traffic", metric_values: {} }];
    });
    expect((await repo(run).pages({ limit: 1, offset: 0 })).responseTruncated).toBe(true);
  });
  it("acquisition: an oversized cell is flagged; a clean last page keeps hasMore=false and responseTruncated=false", async () => {
    const mk = (big: boolean) =>
      fakeRunner((t) => {
        if (t.includes("clarity_fetch_runs")) return [runRow()];
        if (t.includes("GROUP BY dimension_hash")) return [{ dimension_hash: "h1", source: "google", medium: null, campaign: null, channel: null }];
        return rowsFor("h1", big ? MAX_GROUP_ROWS : 2, big ? 400 : 2, "dimension_hash");
      }).run;
    const big = await repo(mk(true)).acquisition({ limit: 1, offset: 0 });
    expect(big.rows[0]).toMatchObject({ metricsTruncated: true, metricRowTotal: 400 });
    expect(big.responseTruncated).toBe(true);
    expect(big.hasMore).toBe(false);
    const small = await repo(mk(false)).acquisition({ limit: 1, offset: 0 });
    expect(small.rows[0].metricsTruncated).toBe(false);
    expect(small.responseTruncated).toBe(false);
    expect(small.responseComplete).toBe(true);
  });
  it("acquisition: pagination stays stable under deferral (nextOffset continues exactly after the last whole cell)", async () => {
    const keys = ["h1", "h2", "h3", "h4", "h5", "h6"];
    const all = keys.flatMap((k) => rowsFor(k, 100, 100, "dimension_hash")).slice(0, MAX_DETAIL_ROWS + 1);
    const { run } = fakeRunner((t) => {
      if (t.includes("clarity_fetch_runs")) return [runRow()];
      if (t.includes("GROUP BY dimension_hash")) return keys.map((k) => ({ dimension_hash: k, source: k, medium: null, campaign: null, channel: null }));
      return all;
    });
    const r = await repo(run).acquisition({ limit: 6, offset: 10 });
    expect(r.rows.map((x) => x.source)).toEqual(["h1", "h2", "h3", "h4", "h5"]);
    expect(r.hasMore).toBe(true);
    expect(r.nextOffset).toBe(15);
  });
  it("overview: more than MAX_DETAIL_ROWS rows from a successful ingestion flags responseTruncated, not sourceTruncated", async () => {
    const rows = Array.from({ length: MAX_DETAIL_ROWS + 1 }, (_, i) => ({ metric_name: `M${i}`, metric_values: { v: i } }));
    const { run, calls } = fakeRunner((t) => (t.includes("clarity_fetch_runs") ? [runRow()] : rows));
    const r = await repo(run).overview();
    expect(r.rowCount).toBe(MAX_DETAIL_ROWS);
    expect(r.rows).toHaveLength(MAX_DETAIL_ROWS);
    expect(r.responseTruncated).toBe(true);
    expect(r.responseComplete).toBe(false);
    expect(r.sourceTruncated).toBe(false);
    expect(r.coverage).toMatchObject({ status: "success", sourceComplete: true });
    expect(calls[1].values.at(-1)).toBe(MAX_DETAIL_ROWS + 1);
  });
  it("overview: exactly MAX_DETAIL_ROWS rows is complete", async () => {
    const rows = Array.from({ length: MAX_DETAIL_ROWS }, (_, i) => ({ metric_name: `M${i}`, metric_values: {} }));
    const { run } = fakeRunner((t) => (t.includes("clarity_fetch_runs") ? [runRow()] : rows));
    const r = await repo(run).overview();
    expect(r.responseTruncated).toBe(false);
    expect(r.responseComplete).toBe(true);
  });
  it("overview: both source and response truncation are reported independently", async () => {
    const rows = Array.from({ length: MAX_DETAIL_ROWS + 1 }, (_, i) => ({ metric_name: `M${i}`, metric_values: {} }));
    const { run } = fakeRunner((t) => (t.includes("clarity_fetch_runs") ? [runRow({ status: "truncated", truncated_suspected: true })] : rows));
    const r = await repo(run).overview();
    expect(r).toMatchObject({ sourceTruncated: true, responseTruncated: true, responseComplete: false });
    expect(r.coverage.status).toBe("truncated");
  });
  it("clarity_page: an oversized group and the overall cap both flag the section and the aggregate", async () => {
    const detail = (n: number, total: number) =>
      Array.from({ length: n }, (_, i) => ({ device: "PC", source: null, metric_name: `M${i}`, metric_values: {}, group_rows: String(total) }));
    const { run } = fakeRunner((t, v) => {
      if (t.includes("clarity_fetch_runs")) return [runRow({ id: String(v[1]) })];
      return v[2] === "page" ? [{ device: null, source: null, metric_name: "Traffic", metric_values: {}, group_rows: "1" }] : v[2] === "page_device" ? detail(MAX_GROUP_ROWS, 900) : [];
    });
    const r = await repo(run).page({ page: "/big/" });
    expect(r.breakdowns.device?.rows[0]).toMatchObject({ device: "PC", metricsTruncated: true, metricRowTotal: 900 });
    expect(r.breakdowns.device?.responseTruncated).toBe(true);
    expect(r.observation?.responseTruncated).toBe(false);
    expect(r.responseTruncated).toBe(true);
    expect(r.responseComplete).toBe(false);
    expect(r.sourceTruncated).toBe(false);
  });
  it("clarity_page: hitting the overall cap flags the section even when every returned group looks whole", async () => {
    const rows = Array.from({ length: MAX_DETAIL_ROWS + 1 }, (_, i) => ({
      device: `D${Math.floor(i / 50)}`,
      source: null,
      metric_name: `M${i}`,
      metric_values: {},
      group_rows: "50",
    }));
    const { run } = fakeRunner((t, v) => (t.includes("clarity_fetch_runs") ? [runRow()] : v[2] === "page_device" ? rows : []));
    const r = await repo(run).page({ page: "/wide/" });
    // 500 rows = 10 whole groups; the 11th group (cut by the SQL LIMIT) is absent, so the section must say so.
    expect(r.breakdowns.device?.rows).toHaveLength(10);
    expect(r.breakdowns.device?.rows.every((x) => !x.metricsTruncated)).toBe(true);
    expect(r.breakdowns.device?.responseTruncated).toBe(true);
    expect(r.breakdowns.device?.responseComplete).toBe(false);
  });
});
