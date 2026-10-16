import { z } from "zod";
import { GOOGLE_SCOPES, GoogleAuthError, type GoogleTokenProvider } from "../auth/google-oauth";

/** Fixed official host; the property ID is digit-validated and allowlisted before it is ever interpolated. */
const DATA_API_ORIGIN = "https://analyticsdata.googleapis.com";

export const DEFAULT_ROW_LIMIT = 50;
export const MAX_ROW_LIMIT = 200;
export const MAX_OFFSET = 10_000;
export const MAX_DATE_RANGE_DAYS = 366;
export const MAX_DIMENSIONS = 4;
/** Internal ceiling for any report; ga4_run_report exposes a tighter per-request cap (MAX_RUN_REPORT_METRICS). */
export const MAX_METRICS = 10;
export const MAX_RUN_REPORT_METRICS = 6;
const REQUEST_TIMEOUT_MS = 10_000;
const MAX_RETRIES = 2;
const MAX_RETRY_AFTER_SECONDS = 5;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

/** Approved dimensions with their GA4 scope; scopes drive the attribution-mixing rule. */
export const DIMENSIONS = {
  date: "time",
  country: "geo",
  deviceCategory: "tech",
  browser: "tech",
  operatingSystem: "tech",
  hostName: "page",
  pagePath: "page",
  pagePathPlusQueryString: "page",
  pageTitle: "page",
  landingPagePlusQueryString: "session",
  sessionDefaultChannelGroup: "session",
  sessionSource: "session",
  sessionMedium: "session",
  sessionSourceMedium: "session",
  sessionCampaignName: "session",
  firstUserDefaultChannelGroup: "firstUser",
  firstUserSource: "firstUser",
  firstUserMedium: "firstUser",
  firstUserSourceMedium: "firstUser",
  firstUserCampaignName: "firstUser",
} as const;
export type DimensionName = keyof typeof DIMENSIONS;
export const DIMENSION_NAMES = Object.keys(DIMENSIONS) as [DimensionName, ...DimensionName[]];

export const METRIC_NAMES = [
  "activeUsers",
  "totalUsers",
  "newUsers",
  "sessions",
  "engagedSessions",
  "engagementRate",
  "bounceRate",
  "screenPageViews",
  "screenPageViewsPerSession",
  "averageSessionDuration",
  "userEngagementDuration",
  "eventCount",
] as const;
export type MetricName = (typeof METRIC_NAMES)[number];

export type Ga4ErrorCode =
  | "configuration_missing"
  | "property_required"
  | "property_not_allowed"
  | "invalid_request"
  | "permission_denied"
  | "quota_exceeded"
  | "provider_unavailable"
  | "response_too_large"
  | "google_auth_not_configured"
  | "google_auth_invalid"
  | "google_auth_revoked"
  | "google_auth_unavailable";

/** Messages are fixed and pre-vetted; Google error text is never forwarded. */
export class Ga4Error extends Error {
  constructor(
    readonly code: Ga4ErrorCode,
    message: string,
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = "Ga4Error";
  }
}

export function mapAuthError(error: GoogleAuthError): Ga4Error {
  switch (error.code) {
    case "credentials_not_configured":
      return new Ga4Error("google_auth_not_configured", error.message);
    case "authorization_revoked":
      return new Ga4Error("google_auth_revoked", error.message);
    case "unavailable":
      return new Ga4Error("google_auth_unavailable", error.message);
    default:
      return new Ga4Error("google_auth_invalid", error.message);
  }
}

/** Parses the non-secret allowlist. Any malformed entry makes the whole list unusable (fail closed). */
export function parsePropertyIds(value: string | undefined): string[] {
  if (!value || value.trim() === "") return [];
  const ids = value.split(",").map((s) => s.trim());
  if (ids.some((id) => !/^\d{1,20}$/.test(id))) return [];
  return [...new Set(ids)];
}

/** Resolves and authorizes the property before any Google call. */
export function resolveProperty(allowed: string[], requested: string | undefined): string {
  if (allowed.length === 0) {
    throw new Ga4Error("configuration_missing", "GA4 is not configured: GA4_PROPERTY_IDS is missing or malformed.");
  }
  if (requested === undefined) {
    if (allowed.length === 1) return allowed[0]!;
    throw new Ga4Error("property_required", "Several GA4 properties are approved; propertyId is required.");
  }
  if (!allowed.includes(requested)) {
    throw new Ga4Error("property_not_allowed", "The requested GA4 property is not on the approved allowlist.");
  }
  return requested;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const dayNumber = (s: string) => {
  const t = Date.parse(`${s}T00:00:00Z`);
  return Number.isNaN(t) || new Date(t).toISOString().slice(0, 10) !== s ? undefined : t / 86_400_000;
};

export interface DateRange {
  startDate: string;
  endDate: string;
}

/**
 * Explicit dates are validated; a missing range defaults to GA4's relative `28daysAgo`..`yesterday`, which Google
 * resolves in the property's own timezone (previous 28 completed days).
 */
export function resolveDateRange(startDate?: string, endDate?: string): DateRange {
  if (startDate === undefined && endDate === undefined) return { startDate: "28daysAgo", endDate: "yesterday" };
  if (startDate === undefined || endDate === undefined) {
    throw new Ga4Error("invalid_request", "startDate and endDate must be provided together.");
  }
  const s = DATE_RE.test(startDate) ? dayNumber(startDate) : undefined;
  const e = DATE_RE.test(endDate) ? dayNumber(endDate) : undefined;
  if (s === undefined || e === undefined) throw new Ga4Error("invalid_request", "Dates must be real calendar dates in YYYY-MM-DD form.");
  if (s > e) throw new Ga4Error("invalid_request", "startDate must not be after endDate.");
  if (e - s + 1 > MAX_DATE_RANGE_DAYS) {
    throw new Ga4Error("invalid_request", `The date range must not exceed ${MAX_DATE_RANGE_DAYS} days.`);
  }
  return { startDate, endDate };
}

export interface ReportSpec {
  dimensions: readonly DimensionName[];
  metrics: readonly MetricName[];
  dateRange: DateRange;
  limit: number;
  offset: number;
  /** Constrained, tool-built filter: page path prefix only. */
  pagePathPrefix?: string;
}

/** Local compatibility rules; anything else is left to Google, whose rejection is reported as invalid_request. */
export function validateSpec(spec: ReportSpec): void {
  if (spec.metrics.length === 0 || spec.metrics.length > MAX_METRICS) {
    throw new Ga4Error("invalid_request", `Provide 1-${MAX_METRICS} metrics.`);
  }
  if (spec.dimensions.length > MAX_DIMENSIONS) throw new Ga4Error("invalid_request", `Provide at most ${MAX_DIMENSIONS} dimensions.`);
  if (new Set(spec.dimensions).size !== spec.dimensions.length || new Set(spec.metrics).size !== spec.metrics.length) {
    throw new Ga4Error("invalid_request", "Dimensions and metrics must not repeat.");
  }
  for (const d of spec.dimensions) if (!(d in DIMENSIONS)) throw new Ga4Error("invalid_request", "A requested dimension is not in the approved catalog.");
  for (const m of spec.metrics) if (!(METRIC_NAMES as readonly string[]).includes(m)) throw new Ga4Error("invalid_request", "A requested metric is not in the approved catalog.");
  const scopes = new Set(spec.dimensions.map((d) => DIMENSIONS[d]));
  if (scopes.has("session") && scopes.has("firstUser")) {
    throw new Ga4Error("invalid_request", "Session-scoped and first-user-scoped acquisition dimensions cannot be combined in one report.");
  }
  if (!Number.isInteger(spec.limit) || spec.limit < 1 || spec.limit > MAX_ROW_LIMIT) {
    throw new Ga4Error("invalid_request", `limit must be an integer from 1 to ${MAX_ROW_LIMIT}.`);
  }
  if (!Number.isInteger(spec.offset) || spec.offset < 0 || spec.offset > MAX_OFFSET) {
    throw new Ga4Error("invalid_request", `offset must be an integer from 0 to ${MAX_OFFSET}.`);
  }
}

/** Builds the only request body shape ever sent to Google. Ordering is fixed so offset paging is deterministic. */
export function buildRequestBody(spec: ReportSpec): Record<string, unknown> {
  const orderBys: Record<string, unknown>[] = [];
  if (spec.dimensions.includes("date")) orderBys.push({ dimension: { dimensionName: "date" } });
  else orderBys.push({ metric: { metricName: spec.metrics[0] }, desc: true });
  for (const d of spec.dimensions) if (d !== "date") orderBys.push({ dimension: { dimensionName: d } });
  const body: Record<string, unknown> = {
    dateRanges: [spec.dateRange],
    dimensions: spec.dimensions.map((name) => ({ name })),
    metrics: spec.metrics.map((name) => ({ name })),
    orderBys,
    limit: String(spec.limit),
    offset: String(spec.offset),
    returnPropertyQuota: true,
  };
  if (spec.pagePathPrefix !== undefined) {
    body.dimensionFilter = {
      filter: { fieldName: "pagePath", stringFilter: { matchType: "BEGINS_WITH", value: spec.pagePathPrefix, caseSensitive: true } },
    };
  }
  return body;
}

const reportSchema = z.object({
  dimensionHeaders: z.array(z.object({ name: z.string() })).default([]),
  metricHeaders: z.array(z.object({ name: z.string(), type: z.string().optional() })).default([]),
  rows: z
    .array(z.object({ dimensionValues: z.array(z.object({ value: z.string().default("") })).default([]), metricValues: z.array(z.object({ value: z.string().default("") })).default([]) }))
    .default([]),
  rowCount: z.number().int().nonnegative().optional(),
  metadata: z
    .object({
      currencyCode: z.string().optional(),
      timeZone: z.string().optional(),
      dataLossFromOtherRow: z.boolean().optional(),
      emptyReason: z.string().optional(),
      subjectToThresholding: z.boolean().optional(),
      samplingMetadatas: z.array(z.object({ samplesReadCount: z.string().optional(), samplingSpaceSize: z.string().optional() })).optional(),
      schemaRestrictionResponse: z.unknown().optional(),
    })
    .default({}),
  propertyQuota: z.record(z.string(), z.object({ consumed: z.number().optional(), remaining: z.number().optional() })).optional(),
  kind: z.string().optional(),
});
export type GaReport = z.infer<typeof reportSchema>;

export interface GoogleAnalyticsClientOptions {
  tokens: GoogleTokenProvider;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  timeoutMs?: number;
}

async function readBounded(response: Response): Promise<string | undefined> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) return undefined;
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_RESPONSE_BYTES) {
      await reader.cancel().catch(() => undefined);
      return undefined;
    }
    chunks.push(value);
  }
  const all = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    all.set(c, at);
    at += c.byteLength;
  }
  return new TextDecoder().decode(all);
}

function retryAfter(response: Response): number | undefined {
  const raw = response.headers.get("retry-after");
  if (raw === null) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.ceil(n) : undefined;
}

function googleStatus(text: string): string | undefined {
  try {
    const status = (JSON.parse(text) as { error?: { status?: unknown } }).error?.status;
    return typeof status === "string" ? status : undefined;
  } catch {
    return undefined;
  }
}

export class GoogleAnalyticsClient {
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly timeoutMs: number;

  constructor(private readonly options: GoogleAnalyticsClientOptions) {
    this.fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init));
    this.sleep = options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;
  }

  /** `propertyId` must already have passed `resolveProperty`; it is re-checked to be digits-only defensively. */
  async runReport(propertyId: string, spec: ReportSpec): Promise<GaReport> {
    if (!/^\d{1,20}$/.test(propertyId)) throw new Ga4Error("invalid_request", "Invalid property identifier.");
    validateSpec(spec);
    const url = `${DATA_API_ORIGIN}/v1beta/properties/${propertyId}:runReport`;
    const body = JSON.stringify(buildRequestBody(spec));

    let refreshedAfter401 = false;
    for (let attempt = 0; ; attempt++) {
      let token: string;
      try {
        token = await this.options.tokens.getAccessToken(GOOGLE_SCOPES.analyticsReadonly, refreshedAfter401);
      } catch (error) {
        if (error instanceof GoogleAuthError) throw mapAuthError(error);
        throw new Ga4Error("google_auth_unavailable", "Google authentication is temporarily unavailable. Retry later.");
      }
      const started = Date.now();
      let response: Response | undefined;
      try {
        response = await this.fetchImpl(url, {
          method: "POST",
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json" },
          body,
          signal: AbortSignal.timeout(this.timeoutMs),
        });
      } catch {
        response = undefined;
      }

      const log = (outcome: string) =>
        console.warn(JSON.stringify({ event: "ga4_request", propertyId, attempt, status: response?.status ?? "network_error", outcome, durationMs: Date.now() - started }));

      if (response === undefined) {
        if (attempt < MAX_RETRIES) {
          log("retry");
          await this.sleep(200 * 2 ** attempt);
          continue;
        }
        log("failed");
        throw new Ga4Error("provider_unavailable", "Google Analytics did not respond in time. Retry later.");
      }

      if (response.ok) {
        const text = await readBounded(response);
        if (text === undefined) {
          log("too_large");
          throw new Ga4Error("response_too_large", "The Google Analytics response exceeded the size limit. Request fewer rows, dimensions or metrics.");
        }
        let json: unknown;
        try {
          json = JSON.parse(text);
        } catch {
          log("malformed");
          throw new Ga4Error("provider_unavailable", "Google Analytics returned an unreadable response. Retry later.");
        }
        const parsed = reportSchema.safeParse(json);
        if (!parsed.success) {
          log("malformed");
          throw new Ga4Error("provider_unavailable", "Google Analytics returned an unexpected response shape.");
        }
        return parsed.data;
      }

      const text = (await readBounded(response)) ?? "";
      const status = googleStatus(text);
      const wait = retryAfter(response);

      if (response.status === 401 && !refreshedAfter401) {
        log("refresh_token");
        refreshedAfter401 = true;
        continue;
      }
      if (response.status === 401) {
        log("failed");
        throw new Ga4Error("google_auth_invalid", "Google rejected the access token. The operator must check the credential.");
      }
      if (response.status === 400) {
        log("failed");
        throw new Ga4Error("invalid_request", "Google rejected the report request (invalid or incompatible dimensions/metrics/dates).");
      }
      if (response.status === 404) {
        log("failed");
        throw new Ga4Error("permission_denied", "The GA4 property was not found or the Google identity cannot access it.");
      }
      const isQuota = response.status === 429 || status === "RESOURCE_EXHAUSTED" || /rateLimitExceeded|quotaExceeded/.test(text);
      if (response.status === 403 && !isQuota) {
        log("failed");
        throw new Ga4Error("permission_denied", "The Google identity lacks permission for this GA4 property (or the Data API is disabled).");
      }
      if (isQuota) {
        // Short Retry-After is honored; longer waits and exhausted retries are surfaced to the caller.
        if (wait !== undefined && wait <= MAX_RETRY_AFTER_SECONDS && attempt < MAX_RETRIES) {
          log("retry");
          await this.sleep(wait * 1000);
          continue;
        }
        log("quota");
        throw new Ga4Error("quota_exceeded", "The Google Analytics API quota is exhausted. Retry later.", wait);
      }
      if ([500, 502, 503, 504].includes(response.status) && attempt < MAX_RETRIES) {
        log("retry");
        await this.sleep(wait !== undefined ? Math.min(wait, MAX_RETRY_AFTER_SECONDS) * 1000 : 200 * 2 ** attempt);
        continue;
      }
      log("failed");
      throw new Ga4Error("provider_unavailable", "Google Analytics is temporarily unavailable. Retry later.", wait);
    }
  }
}

function num(value: string): number | string | null {
  if (value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : value;
}

/** Maps Google's report into the tool response, preserving provider names, types, timezone and metadata. */
export function shapeReport(
  propertyId: string,
  spec: ReportSpec,
  report: GaReport,
) {
  const dimensionNames = report.dimensionHeaders.map((h) => h.name);
  const metricHeaders = report.metricHeaders;
  const all = report.rows;
  const rows = all.slice(0, spec.limit).map((r) => ({
    dimensions: Object.fromEntries(dimensionNames.map((n, i) => [n, r.dimensionValues[i]?.value ?? null])),
    metrics: Object.fromEntries(metricHeaders.map((h, i) => [h.name, r.metricValues[i] ? num(r.metricValues[i]!.value) : null])),
  }));
  const providerRowCount = report.rowCount ?? null;
  const consumed = spec.offset + rows.length;
  const hasMore = providerRowCount !== null ? consumed < providerRowCount : all.length >= spec.limit;
  const responseTruncated = all.length > spec.limit;
  const m = report.metadata;
  const quota = report.propertyQuota
    ? Object.fromEntries(Object.entries(report.propertyQuota).map(([k, v]) => [k, { consumed: v.consumed ?? null, remaining: v.remaining ?? null }]))
    : undefined;
  return {
    propertyId,
    dateRange: spec.dateRange,
    dateRangeNote:
      spec.dateRange.startDate === "28daysAgo"
        ? "Relative dates are resolved by Google in the property timezone (previous 28 completed days)."
        : undefined,
    propertyTimeZone: m.timeZone ?? null,
    currencyCode: m.currencyCode ?? null,
    dimensionHeaders: dimensionNames,
    metricHeaders,
    rows,
    rowCount: providerRowCount,
    returnedRowCount: rows.length,
    empty: rows.length === 0,
    emptyReason: m.emptyReason ?? null,
    pagination: { limit: spec.limit, offset: spec.offset, hasMore, nextOffset: hasMore ? consumed : null },
    responseTruncated,
    responseComplete: !responseTruncated && !hasMore,
    metadata: {
      subjectToThresholding: m.subjectToThresholding ?? false,
      samplingMetadatas: m.samplingMetadatas ?? [],
      dataLossFromOtherRow: m.dataLossFromOtherRow ?? false,
      schemaRestrictionResponse: m.schemaRestrictionResponse ?? null,
    },
    propertyQuota: quota,
    source: "google-analytics-data-api",
    note: "GA4 metrics are defined by Google Analytics and are not interchangeable with Microsoft Clarity or Bing metrics. Missing values are null, never 0. No data-freshness guarantee is implied; GA4 data may still be processing.",
  };
}
