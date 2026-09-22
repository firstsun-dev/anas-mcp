// Runs the real SQL against PostgreSQL with windmill-flows' Bing migration applied.
//   BING_TEST_DATABASE_URL=postgres://admin@host/windmill_pipeline npm test
// Skipped when the variable is unset. The test creates a SELECT-only role on the bing_latest_* views to prove
// the Hyperdrive role needs no access to base tables.
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BingAnalyticsRepository, hyperdriveRunner } from "../src/services/bing-analytics";

const ADMIN_URL = process.env.BING_TEST_DATABASE_URL;
const SITE = "https://example.com/";
const RO_ROLE = "bing_test_reader";
const RO_PASSWORD = "bing-test-reader-pw";

describe.skipIf(!ADMIN_URL)("Bing PostgreSQL read model (real database)", () => {
  let admin: Client;
  let readerUrl: string;
  const now = new Date("2026-09-21T12:00:00Z");
  const repo = () =>
    new BingAnalyticsRepository(hyperdriveRunner({ connectionString: readerUrl } as unknown as Hyperdrive), () => now, () => undefined);

  async function run(operation: string, site: string | null, status: string, fetchedAt: string, attempt: number, dataThrough: string | null = null) {
    const { rows } = await admin.query(
      `INSERT INTO blog_analytics.bing_fetch_runs
         (operation, site_url, scheduled_at, logical_date, attempt_no, status, fetched_at, data_through, row_count, payload_hash, raw_payload)
       VALUES ($1, $2, $3, ($3::timestamptz AT TIME ZONE 'Asia/Taipei')::date, $4, $5, $3,
               $6, CASE WHEN $5 = 'success' THEN 0 END, CASE WHEN $5 = 'success' THEN 'h' END,
               CASE WHEN $5 = 'success' THEN '{"d":[]}'::jsonb END)
       RETURNING id`,
      [operation, site, fetchedAt, attempt, status, dataThrough],
    );
    return rows[0].id as string;
  }
  const stat = (runId: string, dimension: string, value: string, date: string, impressions: number | null) =>
    admin.query(
      `INSERT INTO blog_analytics.bing_search_stats
         (fetch_run_id, site_url, dimension, dimension_value, stat_date, impressions, clicks, avg_click_position, avg_impression_position, fetched_at)
       VALUES ($1, $2, $3, $4, $5, $6, NULL, NULL, 3.5, now())`,
      [runId, SITE, dimension, value, date, impressions],
    );

  beforeAll(async () => {
    admin = new Client({ connectionString: ADMIN_URL });
    await admin.connect();
    await admin.query("TRUNCATE blog_analytics.bing_fetch_runs RESTART IDENTITY CASCADE");
    await admin.query(`DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${RO_ROLE}') THEN CREATE ROLE ${RO_ROLE} LOGIN PASSWORD '${RO_PASSWORD}'; END IF; END $$`);
    await admin.query(`GRANT USAGE ON SCHEMA blog_analytics TO ${RO_ROLE}`);
    await admin.query(
      `GRANT SELECT ON blog_analytics.bing_latest_sites, blog_analytics.bing_latest_search_runs, blog_analytics.bing_latest_search_stats TO ${RO_ROLE}`,
    );
    const url = new URL(ADMIN_URL!);
    url.username = RO_ROLE;
    url.password = RO_PASSWORD;
    readerUrl = url.toString();

    // Sites: a 09-20 success, then a newer throttled attempt that must not hide it.
    const sitesRun = await run("user_sites", null, "success", "2026-09-20T18:30:00Z", 1);
    await admin.query("INSERT INTO blog_analytics.bing_sites (fetch_run_id, site_url, is_verified, fetched_at) VALUES ($1, $2, true, '2026-09-20T18:30:00Z')", [sitesRun, SITE]);
    await run("user_sites", null, "throttled", "2026-09-21T18:30:00Z", 1);

    // Query stats: an older success, a newer success (served), then a newest throttled attempt.
    const oldQuery = await run("query_stats", SITE, "success", "2026-09-19T18:30:00Z", 1, "2026-09-10");
    await stat(oldQuery, "query", "stale-run-row", "2026-09-10", 1);
    const newQuery = await run("query_stats", SITE, "success", "2026-09-20T18:30:00Z", 1, "2026-09-17");
    await stat(newQuery, "query", "alpha", "2026-09-17", 100);
    await stat(newQuery, "query", "beta", "2026-09-17", 50);
    await stat(newQuery, "query", "gamma", "2026-09-10", null);
    await run("query_stats", SITE, "throttled", "2026-09-21T18:30:00Z", 2);

    // Page stats: only a throttled attempt exists -> no successful dataset.
    await run("page_stats", SITE, "throttled", "2026-09-20T18:30:00Z", 1);
  });

  afterAll(async () => {
    await admin.query("TRUNCATE blog_analytics.bing_fetch_runs RESTART IDENTITY CASCADE");
    await admin.end();
  });

  it("lists sites from the last successful run even though a newer run was throttled", async () => {
    const { sites, freshness } = await repo().listSites();
    expect(sites).toEqual([{ url: SITE, isVerified: true }]);
    expect(freshness.fetchedAt).toBe("2026-09-20T18:30:00.000Z");
  });

  it("serves the newest successful query dataset, with fetchedAt/dataThrough of that run", async () => {
    const result = await repo().searchPerformance({ siteUrl: SITE, dimension: "query", limit: 10, offset: 0 });
    expect(result.freshness).toEqual({ fetchedAt: "2026-09-20T18:30:00.000Z", dataThrough: "2026-09-17", stale: false });
    expect(result.rows.map((r) => r.value)).toEqual(["alpha", "beta", "gamma"]); // newest date first, then impressions
    expect(result.rows[0]).toMatchObject({ date: "2026-09-17", impressions: 100, clicks: null, avgClickPosition: null, avgImpressionPosition: 3.5 });
    expect(result.rows[2].impressions).toBeNull();
    expect(result.rows.map((r) => r.value)).not.toContain("stale-run-row");
  });

  it("filters by date range and paginates with truncation", async () => {
    const ranged = await repo().searchPerformance({ siteUrl: SITE, dimension: "query", startDate: "2026-09-17", endDate: "2026-09-17", limit: 10, offset: 0 });
    expect(ranged.rows.map((r) => r.value)).toEqual(["alpha", "beta"]);
    const page1 = await repo().searchPerformance({ siteUrl: SITE, dimension: "query", limit: 2, offset: 0 });
    expect([page1.rows.length, page1.truncated]).toEqual([2, true]);
    const page2 = await repo().searchPerformance({ siteUrl: SITE, dimension: "query", limit: 2, offset: 2 });
    expect([page2.rows.map((r) => r.value), page2.truncated]).toEqual([["gamma"], false]);
  });

  it("reports data_unavailable for a dimension whose only run failed, and for unknown sites", async () => {
    await expect(repo().searchPerformance({ siteUrl: SITE, dimension: "page", limit: 5, offset: 0 })).rejects.toMatchObject({ code: "data_unavailable" });
    await expect(repo().searchPerformance({ siteUrl: "https://nope.example/", dimension: "query", limit: 5, offset: 0 })).rejects.toMatchObject({ code: "data_unavailable" });
  });

  it("works with a role that can only SELECT the latest-success views, and cannot write", async () => {
    const reader = new Client({ connectionString: readerUrl });
    await reader.connect();
    await expect(reader.query("SELECT count(*) FROM blog_analytics.bing_fetch_runs")).rejects.toThrow(/permission denied/);
    await expect(reader.query("DELETE FROM blog_analytics.bing_latest_sites")).rejects.toThrow();
    await reader.end();
  });
});
