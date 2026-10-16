// Runs the real SQL against PostgreSQL with windmill-flows' Clarity migration applied (tests/fixtures/clarity-schema.sql).
//   CLARITY_TEST_DATABASE_URL=postgres://postgres:pw@localhost:55432/postgres pnpm test
// Skipped when the variable is unset. It DROPS and recreates schema blog_analytics, so point it only at a throwaway
// database. A SELECT-only role proves the Hyperdrive user needs no write privileges.
import { readFileSync } from "node:fs";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ClarityAnalyticsRepository, clarityHyperdriveRunner } from "../src/services/clarity-analytics";

const ADMIN_URL = process.env.CLARITY_TEST_DATABASE_URL;
const RO_ROLE = "clarity_test_reader";
const RO_PASSWORD = "clarity-test-reader-pw";

describe.skipIf(!ADMIN_URL)("Clarity PostgreSQL read model (real database)", () => {
  let admin: Client;
  let readerUrl: string;
  const now = new Date("2026-10-16T06:00:00Z");
  const repo = (keys = ["proj-a"]) =>
    new ClarityAnalyticsRepository(clarityHyperdriveRunner({ connectionString: readerUrl } as unknown as Hyperdrive), keys, () => now, () => undefined);

  let attempt = 0;
  async function run(project: string, query: string, status: string, windowEnd: string | null, opts: { rows?: number; truncated?: boolean; days?: number } = {}) {
    const days = opts.days ?? 1;
    const { rows } = await admin.query(
      `INSERT INTO blog_analytics.clarity_fetch_runs
         (project_key, query_key, scheduled_at, fetched_at, num_days, window_start_at, window_end_at, logical_date,
          attempt_no, status, row_count, truncated_suspected)
       VALUES ($1, $2, $3::timestamptz, CASE WHEN $4::text = 'pending' THEN NULL ELSE $3::timestamptz END, $5::int,
               $3::timestamptz - make_interval(days => $5::int), $3::timestamptz, ($3::timestamptz AT TIME ZONE 'Asia/Taipei')::date,
               $6::int, $4::text, $7::int, $8::boolean)
       RETURNING id`,
      [project, query, windowEnd, status, days, ++attempt, opts.rows ?? null, opts.truncated ?? false],
    );
    return rows[0].id as string;
  }
  async function metric(
    runId: string,
    project: string,
    query: string,
    name: string,
    values: unknown,
    dims: { url?: string; device?: string; source?: string; medium?: string; channel?: string; hash?: string } = {},
  ) {
    await admin.query(
      `INSERT INTO blog_analytics.clarity_metric_rows
         (fetch_run_id, project_key, query_key, logical_date, metric_name, device, source, medium, channel, url_normalized,
          dimension_hash, row_hash, metric_values, normalizer_version)
       VALUES ($1, $2, $3, '2026-10-15', $4, $5, $6, $7, $8, $9, $10, md5($11::text), $11::jsonb, 1)`,
      [runId, project, query, name, dims.device ?? null, dims.source ?? null, dims.medium ?? null, dims.channel ?? null, dims.url ?? null, dims.hash ?? "none", JSON.stringify(values)],
    );
  }

  beforeAll(async () => {
    admin = new Client({ connectionString: ADMIN_URL });
    await admin.connect();
    await admin.query("DROP SCHEMA IF EXISTS blog_analytics CASCADE");
    await admin.query(readFileSync(new URL("./fixtures/clarity-schema.sql", import.meta.url), "utf8"));
    await admin.query(`DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${RO_ROLE}') THEN CREATE ROLE ${RO_ROLE} LOGIN PASSWORD '${RO_PASSWORD}'; END IF; END $$`);
    await admin.query(`GRANT USAGE ON SCHEMA blog_analytics TO ${RO_ROLE}`);
    await admin.query(
      `GRANT SELECT ON blog_analytics.clarity_fetch_runs, blog_analytics.clarity_metric_rows, blog_analytics.clarity_query_definitions TO ${RO_ROLE}`,
    );
    const u = new URL(ADMIN_URL!);
    u.username = RO_ROLE;
    u.password = RO_PASSWORD;
    readerUrl = u.toString();

    // --- site_overall: an older success, a newer success, a newer failure, and a pending run; plus another project.
    const old = await run("proj-a", "site_overall", "success", "2026-10-14T00:30:00Z", { rows: 1 });
    await metric(old, "proj-a", "site_overall", "Traffic", { totalSessionCount: "100" });
    const good = await run("proj-a", "site_overall", "success", "2026-10-15T00:30:00Z", { rows: 2 });
    await metric(good, "proj-a", "site_overall", "Traffic", { totalSessionCount: "250", pagesPerSessionPercentage: null });
    await metric(good, "proj-a", "site_overall", "Scroll Depth", { averageScrollDepth: 41.5 });
    await run("proj-a", "site_overall", "fetch_failed", "2026-10-16T00:30:00Z");
    await run("proj-a", "site_overall", "pending", "2026-10-16T00:40:00Z");
    const other = await run("proj-b", "site_overall", "success", "2026-10-16T00:30:00Z", { rows: 1 });
    await metric(other, "proj-b", "site_overall", "Traffic", { totalSessionCount: "999999" });

    // --- page: newest run is truncated; two raw variants of /blog/a/ collapse to one identity.
    const page = await run("proj-a", "page", "truncated", "2026-10-15T00:30:00Z", { rows: 4, truncated: true });
    await metric(page, "proj-a", "page", "Traffic", { totalSessionCount: "3" }, { url: "/blog/a/", hash: "u1" });
    await metric(page, "proj-a", "page", "Traffic", { totalSessionCount: "4" }, { url: "/blog/a/", hash: "u2" });
    await metric(page, "proj-a", "page", "Scroll Depth", { averageScrollDepth: 50 }, { url: "/blog/a/", hash: "u1" });
    await metric(page, "proj-a", "page", "Traffic", { totalSessionCount: "8" }, { url: "/blog/b/", hash: "u3" });
    await metric(page, "proj-a", "page", "Traffic", { totalSessionCount: "9" }, { url: "/about/", hash: "u4" });
    const pageOld = await run("proj-a", "page", "success", "2026-10-13T00:30:00Z", { rows: 1 });
    await metric(pageOld, "proj-a", "page", "Traffic", { totalSessionCount: "1" }, { url: "/stale-only/", hash: "u9" });

    const pdev = await run("proj-a", "page_device", "success", "2026-10-15T00:30:00Z", { rows: 2 });
    await metric(pdev, "proj-a", "page_device", "Traffic", { totalSessionCount: "2" }, { url: "/blog/a/", device: "Mobile", hash: "d1" });
    await metric(pdev, "proj-a", "page_device", "Traffic", { totalSessionCount: "5" }, { url: "/blog/a/", device: "PC", hash: "d2" });

    // --- acquisition: newest run has zero rows (unusable) -> falls back; null attribution sorts last.
    await run("proj-a", "acquisition", "success", "2026-10-16T00:30:00Z", { rows: 0 });
    const acq = await run("proj-a", "acquisition", "success", "2026-10-15T00:30:00Z", { rows: 3 });
    await metric(acq, "proj-a", "acquisition", "Traffic", { totalSessionCount: "1" }, { source: null as never, hash: "a0" });
    await metric(acq, "proj-a", "acquisition", "Traffic", { totalSessionCount: "2" }, { source: "google", medium: "organic", channel: "Search", hash: "a1" });
    await metric(acq, "proj-a", "acquisition", "Traffic", { totalSessionCount: "3" }, { source: "bing", medium: "organic", channel: "Search", hash: "a2" });

    // --- proj-nourl: a successful, non-empty page ingestion whose rows all lack a normalized URL (the Url/URL mismatch).
    const noUrl = await run("proj-nourl", "page", "success", "2026-10-15T00:30:00Z", { rows: 286 });
    for (let i = 0; i < 5; i++) await metric(noUrl, "proj-nourl", "page", "Traffic", { totalSessionCount: String(i) }, { hash: `n${i}` });
    const noUrlDev = await run("proj-nourl", "page_device", "success", "2026-10-15T00:30:00Z", { rows: 5 });
    await metric(noUrlDev, "proj-nourl", "page_device", "Traffic", { totalSessionCount: "1" }, { device: "PC", hash: "nd" });
    const noUrlOverall = await run("proj-nourl", "site_overall", "success", "2026-10-15T00:30:00Z", { rows: 1 });
    await metric(noUrlOverall, "proj-nourl", "site_overall", "Traffic", { totalSessionCount: "9" });

    // --- oversized datasets from otherwise successful ingestions (project proj-big).
    const bulk = async (runId: string, query: string, n: number, dims: Parameters<typeof metric>[5]) => {
      for (let i = 0; i < n; i++) await metric(runId, "proj-big", query, `M${String(i).padStart(4, "0")}`, { v: i }, { ...dims, hash: dims.hash });
    };
    const bigOverall = await run("proj-big", "site_overall", "success", "2026-10-15T00:30:00Z", { rows: 520 });
    await bulk(bigOverall, "site_overall", 520, { hash: "o" });
    // 1 page with 250 rows, plus 5 pages with 100 rows each (750 total > budget), plus small pages.
    const bigPage = await run("proj-big", "page", "success", "2026-10-15T00:30:00Z", { rows: 760 });
    await bulk(bigPage, "page", 250, { url: "/big/", hash: "pb" });
    for (const k of ["/w1/", "/w2/", "/w3/", "/w4/", "/w5/"]) await bulk(bigPage, "page", 100, { url: k, hash: `p${k}` });
    await metric(bigPage, "proj-big", "page", "Traffic", { totalSessionCount: "1" }, { url: "/z-small/", hash: "pz" });
    const bigAcq = await run("proj-big", "acquisition", "success", "2026-10-15T00:30:00Z", { rows: 350 });
    await bulk(bigAcq, "acquisition", 300, { source: "google", medium: "organic", channel: "Search", hash: "ag" });
    await metric(bigAcq, "proj-big", "acquisition", "Traffic", { totalSessionCount: "1" }, { source: "zzz", hash: "az" });
    const bigDev = await run("proj-big", "page_device", "success", "2026-10-15T00:30:00Z", { rows: 400 });
    await bulk(bigDev, "page_device", 200, { url: "/big/", device: "Mobile", hash: "dm" });
    await bulk(bigDev, "page_device", 200, { url: "/big/", device: "PC", hash: "dp" });
    await bulk(bigDev, "page_device", 150, { url: "/big/", device: "Tablet", hash: "dt" });
  });

  afterAll(async () => {
    await admin?.end();
  });

  it("serves the newest successful site_overall run; newer failed/pending runs and other projects never leak in", async () => {
    const r = await repo().overview();
    expect(r.coverage.windowEnd).toBe("2026-10-15T00:30:00.000Z");
    expect(r.coverage.sourceComplete).toBe(true);
    expect(r.responseComplete).toBe(true);
    expect(r.rows).toEqual([
      { metric: "Scroll Depth", values: { averageScrollDepth: 41.5 } },
      { metric: "Traffic", values: { totalSessionCount: "250", pagesPerSessionPercentage: null } },
    ]);
    // 250 only: older run (100) is not added; project B (999999) never appears.
    expect(JSON.stringify(r)).not.toMatch(/"100"|999999/);
    expect(r.freshness.dataThrough).toBe("2026-10-15T00:30:00.000Z");
    expect(r.freshness.stale).toBe(false);
  });
  it("isolates projects by allowlist", async () => {
    const b = await repo(["proj-b"]).overview();
    expect(b.rows).toEqual([{ metric: "Traffic", values: { totalSessionCount: "999999" } }]);
    await expect(repo(["proj-b"]).overview({ projectKey: "proj-a" })).rejects.toMatchObject({ code: "validation" });
    await expect(repo(["proj-c"]).overview()).rejects.toMatchObject({ code: "data_unavailable" });
  });
  it("pages: serves the newest (truncated) run flagged incomplete, ordered deterministically, never mixing the older run", async () => {
    const r = await repo().pages({ limit: 2, offset: 0 });
    expect(r.sourceTruncated).toBe(true);
    expect(r.responseTruncated).toBe(false);
    expect(r.coverage.sourceComplete).toBe(false);
    expect(r.rows.map((x) => x.page)).toEqual(["/about/", "/blog/a/"]);
    expect(r.hasMore).toBe(true);
    // Duplicate observations stay separate instead of being summed.
    expect(r.rows[1].metrics.Traffic).toEqual([{ totalSessionCount: "3" }, { totalSessionCount: "4" }]);
    const next = await repo().pages({ limit: 2, offset: 2 });
    expect(next.rows.map((x) => x.page)).toEqual(["/blog/b/"]);
    expect(next.hasMore).toBe(false);
    expect(JSON.stringify([r, next])).not.toContain("stale-only");
  });
  it("pages: a non-empty run with zero normalized URLs is data_quality, never an empty success", async () => {
    const err = await repo(["proj-nourl"]).pages({ limit: 10, offset: 0 }).then(() => undefined, (e) => e);
    expect(err?.code).toBe("data_quality");
    const filtered = await repo(["proj-nourl"]).pages({ limit: 10, offset: 0, pagePrefix: "/blog/" }).then(() => undefined, (e) => e);
    expect(filtered?.code).toBe("data_quality");
  });
  it("page: no-URL ingestion is data_quality while a healthy dataset's unknown page stays data_unavailable", async () => {
    const bad = await repo(["proj-nourl"]).page({ page: "/blog/a/" }).then(() => undefined, (e) => e);
    expect(bad?.code).toBe("data_quality");
    const unknown = await repo().page({ page: "/never-seen/" }).then(() => undefined, (e) => e);
    expect(unknown?.code).toBe("data_unavailable");
  });
  it("pages: a legitimate no-match prefix on a healthy dataset is an empty result", async () => {
    const r = await repo().pages({ limit: 10, offset: 0, pagePrefix: "/zzz/" });
    expect(r.rows).toEqual([]);
    expect(r.hasMore).toBe(false);
  });
  it("overview is unaffected by a page dataset without URLs", async () => {
    expect((await repo(["proj-nourl"]).overview()).rowCount).toBe(1);
  });
  it("pages: prefix filter is literal (LIKE wildcards are not interpreted)", async () => {
    expect((await repo().pages({ limit: 10, offset: 0, pagePrefix: "/blog/" })).rows.map((x) => x.page)).toEqual(["/blog/a/", "/blog/b/"]);
    expect((await repo().pages({ limit: 10, offset: 0, pagePrefix: "/%" })).rows).toEqual([]);
    expect((await repo().pages({ limit: 10, offset: 0, pagePrefix: "/b_og/" })).rows).toEqual([]);
  });
  it("acquisition: skips an empty newest run, preserves null attribution, orders nulls last", async () => {
    const r = await repo().acquisition({ limit: 10, offset: 0 });
    expect(r.coverage.windowEnd).toBe("2026-10-15T00:30:00.000Z");
    expect(r.rows.map((x) => x.source)).toEqual(["bing", "google", null]);
    expect(r.rows[2]).toMatchObject({ medium: null, channel: null, campaign: null });
  });
  it("page: normalizes the request and returns the device breakdown separately with its own coverage", async () => {
    const r = await repo().page({ page: "https://example.com/blog/a?utm_source=x" });
    expect(r.page).toBe("/blog/a/");
    expect(r.observation?.sourceTruncated).toBe(true);
    expect(r.observation?.metrics.Traffic).toEqual([{ totalSessionCount: "3" }, { totalSessionCount: "4" }]);
    expect(r.breakdowns.device?.rows).toEqual([
      { device: "Mobile", metrics: { Traffic: [{ totalSessionCount: "2" }] }, metricsTruncated: false, metricRowTotal: 1 },
      { device: "PC", metrics: { Traffic: [{ totalSessionCount: "5" }] }, metricsTruncated: false, metricRowTotal: 1 },
    ]);
    expect(r.breakdowns.device?.coverage.sourceComplete).toBe(true);
    expect(r.breakdowns.source).toBeNull();
    await expect(repo().page({ page: "/stale-only/" })).rejects.toMatchObject({ code: "data_unavailable" });
  });
  const BIG = ["proj-big"];
  const count = (rows: { metrics: Record<string, unknown[]> }[]) => rows.reduce((n, r) => n + Object.values(r.metrics).reduce((m, v) => m + v.length, 0), 0);

  it("overview: >500 rows from a successful ingestion is flagged responseTruncated, never sourceTruncated", async () => {
    const r = await repo(BIG).overview();
    expect(r.coverage.status).toBe("success");
    expect(r.sourceTruncated).toBe(false);
    expect(r.responseTruncated).toBe(true);
    expect(r.responseComplete).toBe(false);
    expect(r.rowCount).toBe(500);
  });
  it("pages: a single oversized page is bounded to the group cap and flagged with its true size", async () => {
    const r = await repo(BIG).pages({ limit: 1, offset: 0, pagePrefix: "/big/" });
    expect(r.rows).toHaveLength(1);
    expect(count(r.rows)).toBe(100);
    expect(r.rows[0]).toMatchObject({ page: "/big/", metricsTruncated: true, metricRowTotal: 250 });
    // The retained prefix is deterministic (collation-independent order).
    expect(Object.keys(r.rows[0].metrics)[0]).toBe("M0000");
    expect(Object.keys(r.rows[0].metrics).at(-1)).toBe("M0099");
    expect(r.responseTruncated).toBe(true);
    expect(r.hasMore).toBe(false);
    expect(r.sourceTruncated).toBe(false);
  });
  it("pages: pagination over a budget-exceeding group set is stable, gap-free and bounded per response", async () => {
    const seen: string[] = [];
    let offset = 0;
    for (let i = 0; i < 20; i++) {
      const r = await repo(BIG).pages({ limit: 100, offset });
      expect(count(r.rows)).toBeLessThanOrEqual(500);
      seen.push(...r.rows.map((x) => x.page));
      if (!r.hasMore) {
        expect(r.nextOffset).toBeNull();
        break;
      }
      expect(r.responseTruncated).toBe(true); // shortened by budget -> never claims complete
      expect(r.nextOffset).toBe(offset + r.rows.length);
      offset = r.nextOffset!;
    }
    expect(seen).toEqual(["/big/", "/w1/", "/w2/", "/w3/", "/w4/", "/w5/", "/z-small/"]);
    // The same walk twice yields the same order.
    const again = await repo(BIG).pages({ limit: 100, offset: 0 });
    expect(again.rows.map((x) => x.page)).toEqual(seen.slice(0, again.rows.length));
  });
  it("acquisition: an oversized cell is bounded and flagged; the next cell is still reachable", async () => {
    const r = await repo(BIG).acquisition({ limit: 1, offset: 0 });
    expect(r.rows[0]).toMatchObject({ source: "google", metricsTruncated: true, metricRowTotal: 300 });
    expect(count(r.rows)).toBe(100);
    expect(r.hasMore).toBe(true);
    expect(r.nextOffset).toBe(1);
    const next = await repo(BIG).acquisition({ limit: 1, offset: r.nextOffset! });
    expect(next.rows[0]).toMatchObject({ source: "zzz", metricsTruncated: false, metricRowTotal: 1 });
    expect(next.hasMore).toBe(false);
  });
  it("page: per-group caps and the overall cap flag the breakdown", async () => {
    const r = await repo(BIG).page({ page: "/big/" });
    const device = r.breakdowns.device!;
    expect(device.rows.map((x) => x.device)).toEqual(["Mobile", "PC", "Tablet"]);
    expect(device.rows.every((x) => x.metricsTruncated)).toBe(true);
    expect(device.rows.map((x) => x.metricRowTotal)).toEqual([200, 200, 150]);
    expect(device.responseTruncated).toBe(true);
    expect(device.sourceTruncated).toBe(false);
    expect(r.observation?.metricsTruncated ?? r.observation?.rows[0].metricsTruncated).toBe(true);
    expect(r.responseComplete).toBe(false);
  });
  it("runs read-only: even a writable role cannot modify data through the runner's transaction", async () => {
    const runner = clarityHyperdriveRunner({ connectionString: ADMIN_URL } as unknown as Hyperdrive);
    await expect(runner((s) => s.query("DELETE FROM blog_analytics.clarity_metric_rows"))).rejects.toMatchObject({ code: "25006" });
    const { rows } = await admin.query("SELECT count(*)::int AS n FROM blog_analytics.clarity_metric_rows");
    expect(rows[0].n).toBeGreaterThan(0);
  });
  it("the SELECT-only role is sufficient (no base-table writes needed)", async () => {
    const reader = new Client({ connectionString: readerUrl });
    await reader.connect();
    await expect(reader.query("DELETE FROM blog_analytics.clarity_metric_rows")).rejects.toMatchObject({ code: "42501" });
    await reader.end();
  });
});
