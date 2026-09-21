// Bing Webmaster analytics read repository.
//
// Bing is ingested by firstsun-dev/windmill-flows into PostgreSQL (schema blog_analytics). This module only
// reads the *latest successful* datasets through the bing_latest_* views over read-only Hyperdrive. It never
// calls Bing and only runs the fixed, parameterized statements below.
import { Client } from "pg";

export type BingAnalyticsErrorCode =
  | "validation"
  | "missing_configuration"
  | "data_unavailable"
  | "database_unavailable";

const SAFE_MESSAGES: Record<BingAnalyticsErrorCode, string> = {
  validation: "Invalid request parameters.",
  missing_configuration: "The analytics database binding (ANALYTICS_DB, Hyperdrive) is not configured.",
  data_unavailable:
    "No successful Bing Webmaster ingestion exists for this request yet. This does not mean there was no traffic.",
  database_unavailable: "The analytics database is temporarily unavailable. Retry later.",
};

export class BingAnalyticsError extends Error {
  readonly code: BingAnalyticsErrorCode;
  constructor(code: BingAnalyticsErrorCode, detail?: string) {
    super(detail ?? SAFE_MESSAGES[code]);
    this.name = "BingAnalyticsError";
    this.code = code;
  }
}

/**
 * Ingestion runs daily (Windmill schedule 02:30 Asia/Taipei) and Bing itself refreshes roughly weekly, so a
 * healthy dataset is normally < 24h old. 72h tolerates two consecutive failed/throttled daily runs plus clock
 * skew before the data is reported stale.
 */
export const STALE_AFTER_HOURS = 72;

export const MAX_SITES = 200;
export const DEFAULT_ROW_LIMIT = 25;
export const MAX_ROW_LIMIT = 200;
export const MAX_OFFSET = 100_000;

export interface Freshness {
  /** When the served dataset was fetched from Bing (the last *successful* run, never a newer failed one). */
  fetchedAt: string | null;
  /** Newest provider stat date in the served dataset. */
  dataThrough: string | null;
  stale: boolean | "unknown";
}

export interface BingSite {
  url: string;
  isVerified: boolean | null;
}

export interface SearchPerformanceRow {
  value: string;
  date: string;
  impressions: number | null;
  clicks: number | null;
  avgClickPosition: number | null;
  avgImpressionPosition: number | null;
}

export interface SearchPerformanceQuery {
  siteUrl: string;
  dimension: "query" | "page";
  startDate?: string;
  endDate?: string;
  limit: number;
  offset: number;
}

export interface SqlSession {
  query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}
/** Runs `fn` inside one consistent read-only snapshot. */
export type SessionRunner = <T>(fn: (session: SqlSession) => Promise<T>) => Promise<T>;

/** Production runner: one short-lived pg connection per call through Hyperdrive, in a read-only snapshot. */
export function hyperdriveRunner(binding: Hyperdrive | undefined): SessionRunner {
  return async (fn) => {
    if (!binding) throw new BingAnalyticsError("missing_configuration");
    const client = new Client({ connectionString: binding.connectionString, connectionTimeoutMillis: 5000 });
    try {
      await client.connect();
      // REPEATABLE READ makes the run-metadata query and the row query see the same latest-success run.
      await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      try {
        const result = await fn(client);
        await client.query("COMMIT");
        return result;
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
      }
    } finally {
      await client.end().catch(() => undefined);
    }
  };
}

export function isValidCalendarDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const d = new Date(0);
  d.setUTCFullYear(year, month - 1, day);
  return d.getUTCFullYear() === year && d.getUTCMonth() === month - 1 && d.getUTCDate() === day;
}

export function parseSiteUrl(value: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(value.trim());
  } catch {
    throw new BingAnalyticsError("validation", "siteUrl must be a valid absolute http(s) URL.");
  }
  if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || parsed.username || parsed.password) {
    throw new BingAnalyticsError("validation", "siteUrl must be an http(s) URL without credentials.");
  }
  return parsed;
}

export function computeStale(fetchedAt: string | null, now: Date): boolean | "unknown" {
  if (!fetchedAt) return "unknown";
  const fetched = Date.parse(fetchedAt);
  if (Number.isNaN(fetched)) return "unknown";
  return now.getTime() - fetched > STALE_AFTER_HOURS * 3_600_000;
}

const toIso = (value: unknown): string | null => {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  if (typeof value === "string") {
    const t = Date.parse(value);
    return Number.isNaN(t) ? null : new Date(t).toISOString();
  }
  return null;
};
const toDay = (value: unknown): string | null => {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}/.test(value) ? value.slice(0, 10) : null;
};
// pg returns BIGINT as a string and DOUBLE PRECISION as a number; NULL must stay null (never 0).
const toNum = (value: unknown): number | null => {
  if (value === null || value === undefined) return null;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : null;
};

// Fixed statements. All user input is bound as $n parameters; nothing is concatenated into SQL.
// Dates are selected as text so the pg driver cannot shift them through the runtime's timezone.
const SITES_SQL = `
  SELECT site_url, is_verified, fetched_at
  FROM blog_analytics.bing_latest_sites
  ORDER BY site_url
  LIMIT $1`;
const RUN_SQL = `
  SELECT fetch_run_id, fetched_at, data_through::text AS data_through
  FROM blog_analytics.bing_latest_search_runs
  WHERE site_url = $1 AND dimension = $2`;
const ROWS_SQL = `
  SELECT dimension_value, stat_date::text AS stat_date, impressions, clicks,
         avg_click_position, avg_impression_position
  FROM blog_analytics.bing_latest_search_stats
  WHERE site_url = $1 AND dimension = $2
    AND ($3::date IS NULL OR stat_date >= $3::date)
    AND ($4::date IS NULL OR stat_date <= $4::date)
  ORDER BY stat_date DESC, impressions DESC NULLS LAST, dimension_value
  LIMIT $5 OFFSET $6`;

export class BingAnalyticsRepository {
  constructor(
    private readonly run: SessionRunner,
    private readonly now: () => Date = () => new Date(),
    private readonly log: (event: Record<string, unknown>) => void = (event) => console.log(JSON.stringify(event)),
  ) {}

  async listSites(): Promise<{ sites: BingSite[]; freshness: Freshness; truncated: boolean }> {
    const rows = await this.execute("bing_list_sites", async (session) => (await session.query(SITES_SQL, [MAX_SITES + 1])).rows);
    if (rows.length === 0) throw new BingAnalyticsError("data_unavailable");
    const sites = rows.slice(0, MAX_SITES).map((row) => ({
      url: String(row.site_url),
      isVerified: typeof row.is_verified === "boolean" ? row.is_verified : null,
    }));
    const fetchedAt = toIso(rows[0].fetched_at);
    return {
      sites,
      freshness: { fetchedAt, dataThrough: null, stale: computeStale(fetchedAt, this.now()) },
      truncated: rows.length > MAX_SITES,
    };
  }

  async searchPerformance(q: SearchPerformanceQuery) {
    parseSiteUrl(q.siteUrl);
    if (q.startDate && !isValidCalendarDate(q.startDate)) throw new BingAnalyticsError("validation", "startDate must be YYYY-MM-DD.");
    if (q.endDate && !isValidCalendarDate(q.endDate)) throw new BingAnalyticsError("validation", "endDate must be YYYY-MM-DD.");
    if (q.startDate && q.endDate && q.startDate > q.endDate) {
      throw new BingAnalyticsError("validation", "startDate must not be after endDate.");
    }
    if (q.limit < 1 || q.limit > MAX_ROW_LIMIT || q.offset < 0 || q.offset > MAX_OFFSET) {
      throw new BingAnalyticsError("validation", "limit or offset is out of range.");
    }
    const siteUrl = q.siteUrl.trim();
    const { run, rows } = await this.execute("bing_search_performance", async (session) => {
      const runRow = (await session.query(RUN_SQL, [siteUrl, q.dimension])).rows[0];
      if (!runRow) return { run: undefined, rows: [] as Record<string, unknown>[] };
      const result = await session.query(ROWS_SQL, [
        siteUrl,
        q.dimension,
        q.startDate ?? null,
        q.endDate ?? null,
        q.limit + 1, // one extra row detects truncation without a COUNT
        q.offset,
      ]);
      return { run: runRow, rows: result.rows };
    });
    // No successful ingestion for this site/dimension: never present that as "zero traffic".
    if (!run) throw new BingAnalyticsError("data_unavailable");
    const fetchedAt = toIso(run.fetched_at);
    return {
      siteUrl,
      dimension: q.dimension,
      freshness: {
        fetchedAt,
        dataThrough: toDay(run.data_through),
        stale: computeStale(fetchedAt, this.now()),
      } satisfies Freshness,
      rows: rows.slice(0, q.limit).map(
        (row): SearchPerformanceRow => ({
          value: String(row.dimension_value),
          date: toDay(row.stat_date) ?? "",
          impressions: toNum(row.impressions),
          clicks: toNum(row.clicks),
          avgClickPosition: toNum(row.avg_click_position),
          avgImpressionPosition: toNum(row.avg_impression_position),
        }),
      ),
      offset: q.offset,
      truncated: rows.length > q.limit,
    };
  }

  private async execute<T>(operation: string, fn: (session: SqlSession) => Promise<T>): Promise<T> {
    const started = Date.now();
    try {
      const result = await this.run(fn);
      this.log({ operation, latencyMs: Date.now() - started, status: "ok" });
      return result;
    } catch (error) {
      if (error instanceof BingAnalyticsError) throw error;
      // Driver errors can embed hostnames/SQL; log only the SQLSTATE and return a fixed message.
      const sqlState = typeof (error as { code?: unknown })?.code === "string" ? (error as { code: string }).code : "unknown";
      this.log({ operation, latencyMs: Date.now() - started, status: "database_error", sqlState });
      throw new BingAnalyticsError("database_unavailable");
    }
  }
}
