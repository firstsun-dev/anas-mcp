import { describe, expect, it } from "vitest";
import {
  BingAnalyticsError,
  BingAnalyticsRepository,
  STALE_AFTER_HOURS,
  computeStale,
  type SessionRunner,
  type SqlSession,
} from "../src/services/bing-analytics";

const NOW = new Date("2026-09-21T12:00:00Z");
const SITE = "https://example.com/";

interface Call {
  text: string;
  values: unknown[];
}

/** Fake runner: answers each statement from a handler and records every statement for assertions. */
function fakeRunner(handler: (text: string, values: unknown[]) => Record<string, unknown>[]) {
  const calls: Call[] = [];
  const runner: SessionRunner = (fn) =>
    fn({
      async query(text: string, values: unknown[] = []) {
        calls.push({ text, values });
        return { rows: handler(text, values) };
      },
    } satisfies SqlSession);
  return { runner, calls };
}

const repo = (runner: SessionRunner) => new BingAnalyticsRepository(runner, () => NOW, () => undefined);

const runRow = { fetch_run_id: "7", fetched_at: new Date("2026-09-20T18:30:00Z"), data_through: "2026-09-17" };
const statRow = (over: Record<string, unknown> = {}) => ({
  dimension_value: "firstsun",
  stat_date: "2026-09-17",
  impressions: "120", // pg returns BIGINT as string
  clicks: "9",
  avg_click_position: 2.5,
  avg_impression_position: 4.25,
  ...over,
});

describe("computeStale", () => {
  it("is fresh within the threshold, stale beyond it, unknown without a fetch time", () => {
    const at = (hoursAgo: number) => new Date(NOW.getTime() - hoursAgo * 3_600_000).toISOString();
    expect(STALE_AFTER_HOURS).toBe(72);
    expect(computeStale(at(1), NOW)).toBe(false);
    expect(computeStale(at(72), NOW)).toBe(false);
    expect(computeStale(at(73), NOW)).toBe(true);
    expect(computeStale(null, NOW)).toBe("unknown");
    expect(computeStale("garbage", NOW)).toBe("unknown");
  });
});

describe("listSites", () => {
  it("returns safe fields with freshness and a bounded query", async () => {
    const { runner, calls } = fakeRunner(() => [
      { site_url: SITE, is_verified: true, fetched_at: new Date("2026-09-20T18:30:00Z") },
      { site_url: "https://b.example/", is_verified: null, fetched_at: new Date("2026-09-20T18:30:00Z") },
    ]);
    const result = await repo(runner).listSites();
    expect(result.sites).toEqual([{ url: SITE, isVerified: true }, { url: "https://b.example/", isVerified: null }]);
    expect(result.freshness).toEqual({ fetchedAt: "2026-09-20T18:30:00.000Z", dataThrough: null, stale: false });
    expect(result.truncated).toBe(false);
    expect(calls[0].text).toContain("blog_analytics.bing_latest_sites");
    expect(calls[0].values).toEqual([201]); // MAX_SITES + 1 to detect truncation
  });

  it("truncates beyond the hard maximum", async () => {
    const many = Array.from({ length: 201 }, (_, i) => ({ site_url: `https://s${i}.example/`, is_verified: true, fetched_at: NOW }));
    const result = await repo(fakeRunner(() => many).runner).listSites();
    expect(result.sites).toHaveLength(200);
    expect(result.truncated).toBe(true);
  });

  it("reports data_unavailable, not an empty list, when nothing was ever ingested", async () => {
    await expect(repo(fakeRunner(() => []).runner).listSites()).rejects.toMatchObject({ code: "data_unavailable" });
  });

  it("marks old data stale but still returns it", async () => {
    const old = new Date("2026-09-10T00:00:00Z");
    const result = await repo(fakeRunner(() => [{ site_url: SITE, is_verified: true, fetched_at: old }]).runner).listSites();
    expect(result.freshness.stale).toBe(true);
    expect(result.sites).toHaveLength(1);
  });
});

describe("searchPerformance", () => {
  const query = { siteUrl: SITE, dimension: "query" as const, limit: 2, offset: 0 };
  const twoStatsAndOneExtra = (text: string) => (text.includes("bing_latest_search_runs") ? [runRow] : [statRow(), statRow({ dimension_value: "b" }), statRow({ dimension_value: "c" })]);

  it("returns rows with freshness from the served run and numeric conversion", async () => {
    const result = await repo(fakeRunner(twoStatsAndOneExtra).runner).searchPerformance(query);
    expect(result.freshness).toEqual({ fetchedAt: "2026-09-20T18:30:00.000Z", dataThrough: "2026-09-17", stale: false });
    expect(result.rows).toHaveLength(2);
    expect(result.rows[0]).toEqual({ value: "firstsun", date: "2026-09-17", impressions: 120, clicks: 9, avgClickPosition: 2.5, avgImpressionPosition: 4.25 });
    expect(result.truncated).toBe(true);
  });

  it("keeps missing metrics null rather than 0", async () => {
    const nulls = statRow({ impressions: null, clicks: null, avg_click_position: null, avg_impression_position: null });
    const result = await repo(fakeRunner((t) => (t.includes("runs") ? [runRow] : [nulls])).runner).searchPerformance(query);
    expect(result.rows[0]).toMatchObject({ impressions: null, clicks: null, avgClickPosition: null, avgImpressionPosition: null });
    expect(result.truncated).toBe(false);
  });

  it("returns an empty successful dataset with freshness (no rows is not an error)", async () => {
    const result = await repo(fakeRunner((t) => (t.includes("runs") ? [runRow] : [])).runner).searchPerformance(query);
    expect(result.rows).toEqual([]);
    expect(result.freshness.fetchedAt).not.toBeNull();
  });

  it("binds every input as a parameter and never concatenates it into SQL", async () => {
    const evil = "https://example.com/'; DROP TABLE x;--";
    const { runner, calls } = fakeRunner((t) => (t.includes("runs") ? [runRow] : []));
    await repo(runner).searchPerformance({ ...query, siteUrl: evil, startDate: "2026-09-01", endDate: "2026-09-20", limit: 5, offset: 10 });
    for (const call of calls) {
      expect(call.text).not.toContain("DROP TABLE");
      expect(call.text).not.toContain("2026-09");
    }
    expect(calls[1].values).toEqual([evil, "query", "2026-09-01", "2026-09-20", 6, 10]);
    expect(calls[1].text).toContain("blog_analytics.bing_latest_search_stats");
  });

  it("reports data_unavailable when the site/dimension has no successful ingestion", async () => {
    await expect(repo(fakeRunner(() => []).runner).searchPerformance(query)).rejects.toMatchObject({ code: "data_unavailable" });
  });

  it("marks a two-week-old dataset stale while still returning rows", async () => {
    const oldRun = { ...runRow, fetched_at: new Date("2026-09-05T00:00:00Z") };
    const result = await repo(fakeRunner((t) => (t.includes("runs") ? [oldRun] : [statRow()])).runner).searchPerformance(query);
    expect(result.freshness.stale).toBe(true);
    expect(result.rows).toHaveLength(1);
  });

  it("validates inputs before touching the database", async () => {
    const { runner, calls } = fakeRunner(() => []);
    const r = repo(runner);
    const bad = [
      { ...query, siteUrl: "not a url" },
      { ...query, siteUrl: "ftp://example.com/" },
      { ...query, siteUrl: "https://user:pw@example.com/" },
      { ...query, startDate: "2026-02-30" },
      { ...query, startDate: "2026-09-20", endDate: "2026-09-01" },
      { ...query, limit: 201 },
      { ...query, limit: 0 },
      { ...query, offset: -1 },
      { ...query, offset: 100_001 },
    ];
    for (const input of bad) await expect(r.searchPerformance(input)).rejects.toMatchObject({ code: "validation" });
    expect(calls).toHaveLength(0);
  });
});

describe("database failures", () => {
  it("normalizes driver errors and never leaks DSN, host, or SQL", async () => {
    const boom: SessionRunner = async () => {
      throw Object.assign(new Error('connect ECONNREFUSED 10.0.0.5:5432 password authentication failed for user "reader" SELECT secret'), { code: "ECONNREFUSED" });
    };
    const logged: Record<string, unknown>[] = [];
    const r = new BingAnalyticsRepository(boom, () => NOW, (e) => logged.push(e));
    const error = await r.listSites().catch((e) => e);
    expect(error).toBeInstanceOf(BingAnalyticsError);
    expect(error.code).toBe("database_unavailable");
    expect(error.message).not.toMatch(/10\.0\.0\.5|reader|SELECT|password/);
    expect(JSON.stringify(logged)).not.toMatch(/10\.0\.0\.5|reader|SELECT|password/);
    expect(logged[0]).toMatchObject({ status: "database_error", sqlState: "ECONNREFUSED" });
  });
});
