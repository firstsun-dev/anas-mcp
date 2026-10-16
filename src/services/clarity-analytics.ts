// Microsoft Clarity analytics read repository.
//
// Clarity is ingested by firstsun-dev/windmill-flows (clarity_sync.py) into blog_analytics.clarity_fetch_runs /
// clarity_metric_rows. This module never calls Clarity. It only reads, over read-only Hyperdrive, the rows of ONE
// canonical fetch run per (project_key, query_key) using the fixed, parameterized statements below.
//
// Data semantics (see openspec/changes/add-clarity-analytics-tools/design.md):
//  - Every fetch run is an immutable aggregate over a rolling window (window_start_at..window_end_at, 1-3 days).
//    Runs overlap, so rows from different runs are NEVER summed or merged.
//  - logical_date is a Taipei-local attribution label, not proof of a complete calendar day.
//  - Rows of different query keys use different dimension breakdowns and are never combined into totals.
//  - metric_values is passed through exactly as ingested: names, units and numeric types come from Clarity and are
//    not interpreted here. Missing metrics stay missing (never 0).
import { computeStale, type Freshness } from "./bing-analytics";
import { createHyperdriveRunner, sqlState, toDay, toIso, type SessionRunner, type SqlSession } from "./sql-session";

export type ClarityAnalyticsErrorCode =
  | "validation"
  | "missing_configuration"
  | "data_unavailable"
  | "database_unavailable";

const SAFE_MESSAGES: Record<ClarityAnalyticsErrorCode, string> = {
  validation: "Invalid request parameters.",
  missing_configuration:
    "Clarity is not configured: the analytics database binding (ANALYTICS_DB, Hyperdrive) or the approved project allowlist (CLARITY_PROJECT_KEYS) is missing.",
  data_unavailable:
    "No usable Clarity ingestion exists for this request yet. This does not mean there was no traffic.",
  database_unavailable: "The analytics database is temporarily unavailable. Retry later.",
};

export class ClarityAnalyticsError extends Error {
  readonly code: ClarityAnalyticsErrorCode;
  constructor(code: ClarityAnalyticsErrorCode, detail?: string) {
    super(detail ?? SAFE_MESSAGES[code]);
    this.name = "ClarityAnalyticsError";
    this.code = code;
  }
}

export const DEFAULT_ROW_LIMIT = 25;
export const MAX_ROW_LIMIT = 100;
export const MAX_OFFSET = 100_000;
/** Hard cap on metric rows returned for one summary/page lookup; truncation is reported, never silent. */
export const MAX_DETAIL_ROWS = 500;

export const QUERY_KEYS = ["site_overall", "page", "page_device", "acquisition", "technology", "geo_device", "page_source"] as const;
export type ClarityQueryKey = (typeof QUERY_KEYS)[number];

const PROJECT_KEY_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;

/**
 * Parses the non-secret CLARITY_PROJECT_KEYS allowlist (comma separated). Any malformed entry invalidates the whole
 * value so a typo can never silently widen or shift project scope.
 */
export function parseProjectKeys(raw: string | undefined): string[] {
  if (!raw || !raw.trim()) return [];
  const keys = raw.split(",").map((k) => k.trim());
  if (keys.some((k) => !PROJECT_KEY_PATTERN.test(k))) return [];
  return [...new Set(keys)];
}

/** Production runner: short-lived Hyperdrive connection in a REPEATABLE READ READ ONLY snapshot. */
export function clarityHyperdriveRunner(binding: Hyperdrive | undefined): SessionRunner {
  return createHyperdriveRunner(binding, () => new ClarityAnalyticsError("missing_configuration"));
}

// ---------------------------------------------------------------------------------------------------------------
// Page identity. Mirrors normalize_url() in windmill-flows f/blog_analytics/clarity_sync.py so a requested page
// matches the stored clarity_metric_rows.url_normalized value.
// ---------------------------------------------------------------------------------------------------------------
const TRACKING_KEYS = new Set(["gclid", "fbclid", "msclkid", "_ga", "_gl"]);
const UNSAFE_INPUT = /[\u0000- \u007f]/;

// Python urllib.parse.quote_plus: everything except [A-Za-z0-9_.-~] is percent-encoded, space becomes "+".
const quotePlus = (value: string) =>
  encodeURIComponent(value)
    .replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)
    .replace(/%20/g, "+");
const unquotePlus = (value: string) => {
  const spaced = value.replace(/\+/g, " ");
  try {
    return decodeURIComponent(spaced);
  } catch {
    return spaced;
  }
};

export function normalizePageUrl(input: string): string {
  const value = input.trim();
  if (value.length < 1 || value.length > 2048 || UNSAFE_INPUT.test(value)) {
    throw new ClarityAnalyticsError("validation", "page must be a path or http(s) URL without whitespace (max 2048 chars).");
  }
  let rest = value;
  const absolute = /^https?:\/\/[^/?#]*/i.exec(rest);
  if (absolute) rest = rest.slice(absolute[0].length);
  else if (!rest.startsWith("/") || rest.startsWith("//")) {
    throw new ClarityAnalyticsError("validation", "page must be a site-relative path (e.g. /blog/post/) or an http(s) URL.");
  }
  const hash = rest.indexOf("#");
  if (hash >= 0) rest = rest.slice(0, hash);
  const q = rest.indexOf("?");
  const rawQuery = q >= 0 ? rest.slice(q + 1) : "";
  let path = (q >= 0 ? rest.slice(0, q) : rest) || "/";
  if (!path.startsWith("/")) path = `/${path}`;
  if (path !== "/" && !path.endsWith("/")) path += "/";

  const pairs: [string, string][] = [];
  for (const segment of rawQuery.split("&")) {
    if (!segment) continue;
    const eq = segment.indexOf("=");
    pairs.push(eq >= 0 ? [unquotePlus(segment.slice(0, eq)), unquotePlus(segment.slice(eq + 1))] : [unquotePlus(segment), ""]);
  }
  if (pairs.some(([k]) => k.toLowerCase() === "share")) return path;
  const semantic = pairs.filter(([k]) => !k.toLowerCase().startsWith("utm_") && !TRACKING_KEYS.has(k.toLowerCase()));
  if (semantic.length === 0) return path;
  semantic.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0));
  try {
    return `${path}?${semantic.map(([k, v]) => `${quotePlus(k)}=${quotePlus(v)}`).join("&")}`;
  } catch {
    throw new ClarityAnalyticsError("validation", "page contains invalid characters.");
  }
}

/** Candidate stored identities: the normalized form plus its percent-decoded twin (Clarity may store raw Unicode). */
export function pageCandidates(normalized: string): string[] {
  let decoded = normalized;
  try {
    decoded = decodeURI(normalized);
  } catch {
    /* keep as is */
  }
  return [...new Set([normalized, decoded])];
}

export function validatePagePrefix(prefix: string): string {
  if (prefix.length < 1 || prefix.length > 512 || !prefix.startsWith("/") || prefix.startsWith("//") || /[\u0000- \u007f?#]/.test(prefix)) {
    throw new ClarityAnalyticsError("validation", "pagePrefix must start with a single / and contain no whitespace, ? or # (max 512 chars).");
  }
  return prefix;
}

function validatePaging(limit: number, offset: number) {
  if (!Number.isInteger(limit) || !Number.isInteger(offset) || limit < 1 || limit > MAX_ROW_LIMIT || offset < 0 || offset > MAX_OFFSET) {
    throw new ClarityAnalyticsError("validation", "limit or offset is out of range.");
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Fixed statements. All input is bound as $n parameters; no identifiers or expressions are ever concatenated.
// COLLATE "C" makes ordering independent of the database locale (deterministic pagination).
// ---------------------------------------------------------------------------------------------------------------
// Canonical run: newest usable run for the project/query. 'success' and 'truncated' are the only statuses the sync
// writes with data; failed/pending/partial runs are excluded so a newer failure never replaces a valid dataset.
// Runs that normalized zero rows are not observations we can present (and are never read as zero traffic).
const RUN_SQL = `
  SELECT r.id, r.status, r.truncated_suspected, r.fetched_at, r.window_start_at, r.window_end_at,
         r.logical_date::text AS logical_date, r.num_days, r.row_count, r.normalizer_version
  FROM blog_analytics.clarity_fetch_runs r
  JOIN blog_analytics.clarity_query_definitions d ON d.query_key = r.query_key AND d.enabled
  WHERE r.project_key = $1 AND r.query_key = $2
    AND r.status IN ('success', 'truncated')
    AND r.fetched_at IS NOT NULL
    AND r.window_start_at IS NOT NULL AND r.window_end_at IS NOT NULL
    AND r.row_count > 0
  ORDER BY r.window_end_at DESC, r.fetched_at DESC, r.id DESC
  LIMIT 1`;

const OVERVIEW_ROWS_SQL = `
  SELECT metric_name, metric_values
  FROM blog_analytics.clarity_metric_rows
  WHERE fetch_run_id = $1 AND project_key = $2 AND query_key = $3
  ORDER BY metric_name COLLATE "C", row_hash COLLATE "C"
  LIMIT $4`;

const PAGE_KEYS_SQL = `
  SELECT url_normalized
  FROM blog_analytics.clarity_metric_rows
  WHERE fetch_run_id = $1 AND project_key = $2 AND query_key = $3
    AND url_normalized IS NOT NULL
    AND ($4::text IS NULL OR starts_with(url_normalized, $4::text))
  GROUP BY url_normalized
  ORDER BY url_normalized COLLATE "C"
  LIMIT $5 OFFSET $6`;

const PAGE_ROWS_SQL = `
  SELECT url_normalized, metric_name, metric_values
  FROM blog_analytics.clarity_metric_rows
  WHERE fetch_run_id = $1 AND project_key = $2 AND query_key = $3 AND url_normalized = ANY($4::text[])
  ORDER BY url_normalized COLLATE "C", metric_name COLLATE "C", row_hash COLLATE "C"`;

const ACQUISITION_KEYS_SQL = `
  SELECT dimension_hash, source, medium, campaign, channel
  FROM blog_analytics.clarity_metric_rows
  WHERE fetch_run_id = $1 AND project_key = $2 AND query_key = $3
  GROUP BY dimension_hash, source, medium, campaign, channel
  ORDER BY source COLLATE "C" NULLS LAST, medium COLLATE "C" NULLS LAST, channel COLLATE "C" NULLS LAST,
           campaign COLLATE "C" NULLS LAST, dimension_hash COLLATE "C"
  LIMIT $4 OFFSET $5`;

const ACQUISITION_ROWS_SQL = `
  SELECT dimension_hash, metric_name, metric_values
  FROM blog_analytics.clarity_metric_rows
  WHERE fetch_run_id = $1 AND project_key = $2 AND query_key = $3 AND dimension_hash = ANY($4::text[])
  ORDER BY dimension_hash COLLATE "C", metric_name COLLATE "C", row_hash COLLATE "C"`;

// One page, any of the page / page_device / page_source runs (the caller passes the query key).
const PAGE_DETAIL_SQL = `
  SELECT device, source, metric_name, metric_values
  FROM blog_analytics.clarity_metric_rows
  WHERE fetch_run_id = $1 AND project_key = $2 AND query_key = $3 AND url_normalized = ANY($4::text[])
  ORDER BY device COLLATE "C" NULLS LAST, source COLLATE "C" NULLS LAST, metric_name COLLATE "C", row_hash COLLATE "C"
  LIMIT $5`;

// ---------------------------------------------------------------------------------------------------------------
// Result shapes
// ---------------------------------------------------------------------------------------------------------------
export interface Coverage {
  logicalDate: string | null;
  windowStart: string | null;
  windowEnd: string | null;
  numDays: number | null;
  /** Ingestion status of the served run ('success' | 'truncated'). */
  status: string;
  /** True only for a non-truncated 'success' run. */
  complete: boolean;
  normalizerVersion: number | null;
}

export interface RunMeta {
  projectKey: string;
  queryKey: ClarityQueryKey;
  freshness: Freshness;
  coverage: Coverage;
  /** The source dataset was cut off at Clarity's 1000-row export ceiling; rows may be missing. */
  truncated: boolean;
}

/** metric name -> every ingested value object for it (usually exactly one; never summed). */
export type MetricMap = Record<string, unknown[]>;

interface RunRow {
  id: unknown;
  meta: Omit<RunMeta, "projectKey" | "queryKey">;
}

const asValues = (value: unknown): unknown => (value !== null && typeof value === "object" && !Array.isArray(value) ? value : null);

function addMetric(map: Map<string, unknown[]>, name: unknown, values: unknown) {
  const key = String(name);
  const list = map.get(key);
  if (list) list.push(asValues(values));
  else map.set(key, [asValues(values)]);
}

const toMetricMap = (map: Map<string, unknown[]>): MetricMap => Object.fromEntries(map);

export interface PageBreakdown extends Omit<RunMeta, "projectKey" | "queryKey"> {
  queryKey: ClarityQueryKey;
  rows: { device?: string | null; source?: string | null; metrics: MetricMap }[];
  rowCount: number;
}

export class ClarityAnalyticsRepository {
  constructor(
    private readonly run: SessionRunner,
    private readonly projectKeys: string[],
    private readonly now: () => Date = () => new Date(),
    private readonly log: (event: Record<string, unknown>) => void = (event) => console.log(JSON.stringify(event)),
  ) {}

  /** Clarity is enabled only when an approved project allowlist exists (the Hyperdrive binding is checked per call). */
  get configured(): boolean {
    return this.projectKeys.length > 0;
  }

  async overview(input: { projectKey?: string } = {}) {
    const projectKey = this.resolveProject(input.projectKey);
    const result = await this.execute("clarity_overview", async (session) => {
      const run = await this.selectRun(session, projectKey, "site_overall");
      if (!run) return undefined;
      const rows = (await session.query(OVERVIEW_ROWS_SQL, [run.id, projectKey, "site_overall", MAX_DETAIL_ROWS + 1])).rows;
      return { run, rows };
    });
    if (!result) throw new ClarityAnalyticsError("data_unavailable");
    const kept = result.rows.slice(0, MAX_DETAIL_ROWS);
    const meta = this.meta(projectKey, "site_overall", result.run);
    return {
      ...meta,
      truncated: meta.truncated || result.rows.length > MAX_DETAIL_ROWS,
      rows: kept.map((row) => ({ metric: String(row.metric_name), values: asValues(row.metric_values) })),
      rowCount: kept.length,
    };
  }

  async pages(input: { projectKey?: string; limit: number; offset: number; pagePrefix?: string }) {
    const projectKey = this.resolveProject(input.projectKey);
    validatePaging(input.limit, input.offset);
    const prefix = input.pagePrefix === undefined ? null : validatePagePrefix(input.pagePrefix);
    const result = await this.execute("clarity_pages", async (session) => {
      const run = await this.selectRun(session, projectKey, "page");
      if (!run) return undefined;
      // One extra key detects another page of results without a COUNT.
      const found = (await session.query(PAGE_KEYS_SQL, [run.id, projectKey, "page", prefix, input.limit + 1, input.offset])).rows.map((r) =>
        String(r.url_normalized),
      );
      const keys = found.slice(0, input.limit);
      const rows = keys.length === 0 ? [] : (await session.query(PAGE_ROWS_SQL, [run.id, projectKey, "page", keys])).rows;
      return { run, keys, hasMore: found.length > input.limit, rows };
    });
    if (!result) throw new ClarityAnalyticsError("data_unavailable");
    const byPage = new Map<string, Map<string, unknown[]>>(result.keys.map((k) => [k, new Map()]));
    for (const row of result.rows) {
      const metrics = byPage.get(String(row.url_normalized));
      if (metrics) addMetric(metrics, row.metric_name, row.metric_values);
    }
    return {
      ...this.meta(projectKey, "page", result.run),
      rows: result.keys.map((page) => ({ page, metrics: toMetricMap(byPage.get(page)!) })),
      rowCount: result.keys.length,
      offset: input.offset,
      hasMore: result.hasMore,
    };
  }

  async acquisition(input: { projectKey?: string; limit: number; offset: number }) {
    const projectKey = this.resolveProject(input.projectKey);
    validatePaging(input.limit, input.offset);
    const result = await this.execute("clarity_acquisition", async (session) => {
      const run = await this.selectRun(session, projectKey, "acquisition");
      if (!run) return undefined;
      const found = (await session.query(ACQUISITION_KEYS_SQL, [run.id, projectKey, "acquisition", input.limit + 1, input.offset])).rows;
      const keys = found.slice(0, input.limit);
      const hashes = keys.map((k) => String(k.dimension_hash));
      const rows = keys.length === 0 ? [] : (await session.query(ACQUISITION_ROWS_SQL, [run.id, projectKey, "acquisition", hashes])).rows;
      return { run, keys, hasMore: found.length > input.limit, rows };
    });
    if (!result) throw new ClarityAnalyticsError("data_unavailable");
    const byHash = new Map<string, Map<string, unknown[]>>(result.keys.map((k) => [String(k.dimension_hash), new Map()]));
    for (const row of result.rows) {
      const metrics = byHash.get(String(row.dimension_hash));
      if (metrics) addMetric(metrics, row.metric_name, row.metric_values);
    }
    const text = (v: unknown) => (typeof v === "string" ? v : null);
    return {
      ...this.meta(projectKey, "acquisition", result.run),
      // null attribution (unknown/direct) is preserved as-is; Clarity labels are never mapped to GA4 channels.
      rows: result.keys.map((k) => ({
        source: text(k.source),
        medium: text(k.medium),
        campaign: text(k.campaign),
        channel: text(k.channel),
        metrics: toMetricMap(byHash.get(String(k.dimension_hash))!),
      })),
      rowCount: result.keys.length,
      offset: input.offset,
      hasMore: result.hasMore,
    };
  }

  /**
   * One page: its `page` observation plus the device (`page_device`) and source (`page_source`) breakdowns, each from
   * its own canonical run with its own coverage. Breakdown metrics are never added to the page-level metrics.
   */
  async page(input: { projectKey?: string; page: string }) {
    const projectKey = this.resolveProject(input.projectKey);
    const page = normalizePageUrl(input.page);
    const candidates = pageCandidates(page);
    const result = await this.execute("clarity_page", async (session) => {
      const read = async (queryKey: ClarityQueryKey) => {
        const run = await this.selectRun(session, projectKey, queryKey);
        if (!run) return undefined;
        const rows = (await session.query(PAGE_DETAIL_SQL, [run.id, projectKey, queryKey, candidates, MAX_DETAIL_ROWS + 1])).rows;
        return { run, rows };
      };
      return { overall: await read("page"), device: await read("page_device"), source: await read("page_source") };
    });

    const build = (queryKey: ClarityQueryKey, part: typeof result.overall, dimension?: "device" | "source") => {
      if (!part || part.rows.length === 0) return null;
      const { projectKey: _p, queryKey: _q, ...meta } = this.meta(projectKey, queryKey, part.run);
      const kept = part.rows.slice(0, MAX_DETAIL_ROWS);
      const groups = new Map<string, { value: string | null; metrics: Map<string, unknown[]> }>();
      for (const row of kept) {
        const value = dimension ? (typeof row[dimension] === "string" ? (row[dimension] as string) : null) : null;
        const id = JSON.stringify(value);
        let group = groups.get(id);
        if (!group) groups.set(id, (group = { value, metrics: new Map() }));
        addMetric(group.metrics, row.metric_name, row.metric_values);
      }
      return {
        queryKey,
        ...meta,
        truncated: meta.truncated || part.rows.length > MAX_DETAIL_ROWS,
        rows: [...groups.values()].map((g) => ({ ...(dimension ? { [dimension]: g.value } : {}), metrics: toMetricMap(g.metrics) })),
        rowCount: groups.size,
      };
    };

    const overall = build("page", result.overall);
    const device = build("page_device", result.device, "device");
    const source = build("page_source", result.source, "source");
    if (!overall && !device && !source) {
      throw new ClarityAnalyticsError(
        "data_unavailable",
        "No Clarity observation for this page in the latest usable ingestion. The page may be absent from the window or cut off by truncation; this does not mean zero traffic.",
      );
    }
    return {
      projectKey,
      page,
      observation: overall ? { ...overall, metrics: overall.rows[0]?.metrics ?? {} } : null,
      breakdowns: { device, source },
    };
  }

  private resolveProject(requested: string | undefined): string {
    if (this.projectKeys.length === 0) throw new ClarityAnalyticsError("missing_configuration");
    if (requested === undefined) {
      if (this.projectKeys.length === 1) return this.projectKeys[0];
      throw new ClarityAnalyticsError("validation", "projectKey is required because several Clarity projects are approved.");
    }
    if (!this.projectKeys.includes(requested)) throw new ClarityAnalyticsError("validation", "projectKey is not an approved Clarity project.");
    return requested;
  }

  private async selectRun(session: SqlSession, projectKey: string, queryKey: ClarityQueryKey): Promise<RunRow | undefined> {
    const row = (await session.query(RUN_SQL, [projectKey, queryKey])).rows[0];
    if (!row) return undefined;
    const fetchedAt = toIso(row.fetched_at);
    const windowEnd = toIso(row.window_end_at);
    const status = String(row.status);
    const truncated = row.truncated_suspected === true || status === "truncated";
    const int = (v: unknown) => (v === null || v === undefined || Number.isNaN(Number(v)) ? null : Number(v));
    return {
      id: row.id,
      meta: {
        freshness: {
          fetchedAt,
          // Provider coverage boundary: the end of the rolling window the run requested, not the Taipei logical date.
          dataThrough: windowEnd,
          stale: computeStale(fetchedAt, this.now()),
        },
        coverage: {
          logicalDate: toDay(row.logical_date),
          windowStart: toIso(row.window_start_at),
          windowEnd,
          numDays: int(row.num_days),
          status,
          complete: status === "success" && !truncated,
          normalizerVersion: int(row.normalizer_version),
        },
        truncated,
      },
    };
  }

  private meta(projectKey: string, queryKey: ClarityQueryKey, run: RunRow): RunMeta {
    return { projectKey, queryKey, ...run.meta };
  }

  private async execute<T>(operation: string, fn: (session: SqlSession) => Promise<T>): Promise<T> {
    const started = Date.now();
    try {
      const result = await this.run(fn);
      this.log({ operation, latencyMs: Date.now() - started, status: "ok" });
      return result;
    } catch (error) {
      if (error instanceof ClarityAnalyticsError) throw error;
      this.log({ operation, latencyMs: Date.now() - started, status: "database_error", sqlState: sqlState(error) });
      throw new ClarityAnalyticsError("database_unavailable");
    }
  }
}
