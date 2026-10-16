import { z } from "zod";
import { GOOGLE_SCOPES, GoogleAuthError, type GoogleTokenProvider } from "../auth/google-oauth";
import { readBounded, retryAfter } from "./google-analytics";

/** Fixed official API base. Never taken from tool input or configuration. */
const API_BASE = "https://www.googleapis.com/webmasters/v3";

export const GSC_TIME_ZONE = "America/Los_Angeles";
export const DEFAULT_ROW_LIMIT = 50;
export const MAX_ROW_LIMIT = 200;
export const MAX_OFFSET = 10_000;
export const MAX_DATE_RANGE_DAYS = 366;
export const DEFAULT_RANGE_DAYS = 28;
export const MAX_DIMENSIONS = 3;
export const MAX_FILTER_LENGTH = 512;
export const MAX_ALLOWED_SITES = 50;
const MAX_SITE_URL_LENGTH = 512;
const REQUEST_TIMEOUT_MS = 10_000;
const MAX_RETRIES = 2;
const MAX_RETRY_AFTER_SECONDS = 5;

export const DIMENSION_NAMES = ["query", "page", "date", "country", "device"] as const;
export type GscDimension = (typeof DIMENSION_NAMES)[number];
export const SEARCH_TYPES = ["web", "image", "video", "news", "discover", "googleNews"] as const;
export type GscSearchType = (typeof SEARCH_TYPES)[number];
export const DATA_STATES = ["final", "all"] as const;
export type GscDataState = (typeof DATA_STATES)[number];
export const FILTER_OPERATORS = ["contains", "equals"] as const;
export type GscFilterOperator = (typeof FILTER_OPERATORS)[number];

export type GscErrorCode =
  | "configuration_missing"
  | "invalid_property"
  | "property_not_allowed"
  | "invalid_request"
  | "permission_denied"
  | "api_disabled"
  | "quota_exceeded"
  | "rate_limited"
  | "timeout"
  | "malformed_response"
  | "response_too_large"
  | "provider_unavailable"
  | "google_auth_not_configured"
  | "google_auth_invalid"
  | "google_auth_revoked"
  | "google_auth_scope_missing"
  | "google_auth_unavailable";

/** Messages are fixed and pre-vetted; Google error text is never forwarded. */
export class GscError extends Error {
  constructor(
    readonly code: GscErrorCode,
    message: string,
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = "GscError";
  }
}

export function mapAuthError(error: GoogleAuthError): GscError {
  switch (error.code) {
    case "credentials_not_configured":
      return new GscError("google_auth_not_configured", error.message);
    case "authorization_revoked":
      return new GscError("google_auth_revoked", error.message);
    case "scope_missing":
      return new GscError(
        "google_auth_scope_missing",
        "The existing Google authorization does not include the Search Console read-only scope (webmasters.readonly). The operator must re-authorize the refresh token with that scope and rotate the secret (see docs/gsc.md).",
      );
    case "unavailable":
      return new GscError("google_auth_unavailable", error.message);
    default:
      return new GscError("google_auth_invalid", error.message);
  }
}

/** A URL-prefix property (`http(s)://host/…`) or a domain property (`sc-domain:example.com`). */
const URL_PREFIX_RE = /^https?:\/\/[^\s/?#]+(\/[^\s?#]*)?$/;
const DOMAIN_RE = /^sc-domain:[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i;

export function isValidSiteUrl(value: string): boolean {
  if (value.length === 0 || value.length > MAX_SITE_URL_LENGTH) return false;
  return DOMAIN_RE.test(value) || (URL_PREFIX_RE.test(value) && value.endsWith("/"));
}

/**
 * Parses the non-secret `GSC_ALLOWED_SITES` JSON string array. Exact identifiers are preserved (no trimming or
 * normalization). Any malformed input or entry makes the whole list unusable (fail closed).
 */
export function parseAllowedSites(value: string | undefined): string[] {
  if (!value || value.trim() === "") return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed) || parsed.length === 0 || parsed.length > MAX_ALLOWED_SITES) return [];
  if (!parsed.every((s): s is string => typeof s === "string" && isValidSiteUrl(s))) return [];
  return [...new Set(parsed)];
}

/** Validates and authorizes the property before any Google call (exact, case-sensitive membership). */
export function resolveSite(allowed: string[], requested: string): string {
  if (allowed.length === 0) {
    throw new GscError("configuration_missing", "Search Console is not configured: GSC_ALLOWED_SITES is missing or malformed.");
  }
  if (typeof requested !== "string" || !isValidSiteUrl(requested)) {
    throw new GscError("invalid_property", "siteUrl must be a URL-prefix property (ending in /) or an sc-domain: property.");
  }
  if (!allowed.includes(requested)) {
    throw new GscError("property_not_allowed", "The requested Search Console property is not on the approved allowlist.");
  }
  return requested;
}

// ---------------------------------------------------------------------------------------------------------------
// Dates (Search Console reports in America/Los_Angeles)

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const dayNumber = (s: string): number | undefined => {
  if (!DATE_RE.test(s)) return undefined;
  const t = Date.parse(`${s}T00:00:00Z`);
  return Number.isNaN(t) || new Date(t).toISOString().slice(0, 10) !== s ? undefined : t / 86_400_000;
};
const fromDayNumber = (n: number) => new Date(n * 86_400_000).toISOString().slice(0, 10);

const pacificFormat = new Intl.DateTimeFormat("en-US", { timeZone: GSC_TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit" });

/** The current calendar date in the Search Console reporting timezone (DST handled by the runtime tz database). */
export function pacificToday(now: Date = new Date()): string {
  const parts = Object.fromEntries(pacificFormat.formatToParts(now).map((p) => [p.type, p.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

export interface DateRange {
  startDate: string;
  endDate: string;
}

/**
 * Explicit dates are validated as real calendar dates (both or neither). The default is the previous 28 completed
 * calendar days in America/Los_Angeles: endDate = Pacific yesterday, startDate = endDate - 27 days.
 */
export function resolveDateRange(startDate?: string, endDate?: string, now: Date = new Date()): DateRange {
  if (startDate === undefined && endDate === undefined) {
    const end = dayNumber(pacificToday(now))! - 1;
    return { startDate: fromDayNumber(end - (DEFAULT_RANGE_DAYS - 1)), endDate: fromDayNumber(end) };
  }
  if (startDate === undefined || endDate === undefined) {
    throw new GscError("invalid_request", "startDate and endDate must be provided together.");
  }
  const s = dayNumber(startDate);
  const e = dayNumber(endDate);
  if (s === undefined || e === undefined) throw new GscError("invalid_request", "Dates must be real calendar dates in YYYY-MM-DD form.");
  if (s > e) throw new GscError("invalid_request", "startDate must not be after endDate.");
  if (e - s + 1 > MAX_DATE_RANGE_DAYS) throw new GscError("invalid_request", `The date range must not exceed ${MAX_DATE_RANGE_DAYS} days.`);
  return { startDate, endDate };
}

// ---------------------------------------------------------------------------------------------------------------
// Request building

export interface FilterSpec {
  operator: GscFilterOperator;
  expression: string;
}

export interface SearchAnalyticsSpec {
  dimensions: readonly GscDimension[];
  type: GscSearchType;
  dataState: GscDataState;
  dateRange: DateRange;
  limit: number;
  offset: number;
  pageFilter?: FilterSpec;
  queryFilter?: FilterSpec;
}

const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

/** Local rules; anything else is left to Google, whose rejection is reported as invalid_request. */
export function validateSpec(spec: SearchAnalyticsSpec): void {
  if (spec.dimensions.length < 1 || spec.dimensions.length > MAX_DIMENSIONS) {
    throw new GscError("invalid_request", `Provide 1-${MAX_DIMENSIONS} dimensions.`);
  }
  if (new Set(spec.dimensions).size !== spec.dimensions.length) throw new GscError("invalid_request", "Dimensions must not repeat.");
  for (const d of spec.dimensions) if (!(DIMENSION_NAMES as readonly string[]).includes(d)) throw new GscError("invalid_request", "A requested dimension is not supported.");
  if (!(SEARCH_TYPES as readonly string[]).includes(spec.type)) throw new GscError("invalid_request", "Unsupported search type.");
  if (!(DATA_STATES as readonly string[]).includes(spec.dataState)) throw new GscError("invalid_request", "Unsupported dataState.");
  if (!Number.isInteger(spec.limit) || spec.limit < 1 || spec.limit > MAX_ROW_LIMIT) {
    throw new GscError("invalid_request", `limit must be an integer from 1 to ${MAX_ROW_LIMIT}.`);
  }
  if (!Number.isInteger(spec.offset) || spec.offset < 0 || spec.offset > MAX_OFFSET) {
    throw new GscError("invalid_request", `offset must be an integer from 0 to ${MAX_OFFSET}.`);
  }
  for (const f of [spec.pageFilter, spec.queryFilter]) {
    if (!f) continue;
    if (!(FILTER_OPERATORS as readonly string[]).includes(f.operator)) throw new GscError("invalid_request", "Unsupported filter operator.");
    if (f.expression.length < 1 || f.expression.length > MAX_FILTER_LENGTH || CONTROL_CHARS.test(f.expression)) {
      throw new GscError("invalid_request", `Filter expressions must be 1-${MAX_FILTER_LENGTH} printable characters.`);
    }
  }
  if ((spec.type === "discover" || spec.type === "googleNews") && (spec.dimensions.includes("query") || spec.queryFilter)) {
    throw new GscError("invalid_request", `The "${spec.type}" search type has no query data: do not group or filter by query.`);
  }
}

/** Builds the only request body shape ever sent to Google. */
export function buildRequestBody(spec: SearchAnalyticsSpec): Record<string, unknown> {
  const filters = [
    ...(spec.pageFilter ? [{ dimension: "page", operator: spec.pageFilter.operator, expression: spec.pageFilter.expression }] : []),
    ...(spec.queryFilter ? [{ dimension: "query", operator: spec.queryFilter.operator, expression: spec.queryFilter.expression }] : []),
  ];
  return {
    startDate: spec.dateRange.startDate,
    endDate: spec.dateRange.endDate,
    dimensions: [...spec.dimensions],
    type: spec.type,
    dataState: spec.dataState,
    aggregationType: "auto",
    rowLimit: spec.limit,
    startRow: spec.offset,
    ...(filters.length > 0 ? { dimensionFilterGroups: [{ groupType: "and", filters }] } : {}),
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Response schemas

const metric = z.number().finite().nullish();
const queryResponseSchema = z.object({
  rows: z
    .array(z.object({ keys: z.array(z.string()), clicks: metric, impressions: metric, ctr: metric, position: metric }))
    .default([]),
  responseAggregationType: z.string().nullish(),
  metadata: z.record(z.string(), z.unknown()).nullish(),
});
export type SearchAnalyticsResponse = z.infer<typeof queryResponseSchema>;

const sitesResponseSchema = z.object({
  siteEntry: z.array(z.object({ siteUrl: z.string(), permissionLevel: z.string() })).default([]),
});

export interface SiteEntry {
  siteUrl: string;
  permissionLevel: string;
}

// ---------------------------------------------------------------------------------------------------------------
// Client

export interface GoogleSearchConsoleClientOptions {
  tokens: GoogleTokenProvider;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  timeoutMs?: number;
}

interface GoogleErrorInfo {
  status?: string;
  reasons: string[];
}

/** Extracts only machine-readable codes from a Google error body; message text is never kept. */
function googleErrorInfo(text: string): GoogleErrorInfo {
  const info: GoogleErrorInfo = { reasons: [] };
  try {
    const error = (JSON.parse(text) as { error?: { status?: unknown; errors?: { reason?: unknown }[]; details?: { reason?: unknown }[] } }).error;
    if (typeof error?.status === "string") info.status = error.status;
    for (const e of [...(error?.errors ?? []), ...(error?.details ?? [])]) if (typeof e?.reason === "string") info.reasons.push(e.reason);
  } catch {
    /* unreadable body: no reasons */
  }
  return info;
}

export class GoogleSearchConsoleClient {
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly timeoutMs: number;

  constructor(private readonly options: GoogleSearchConsoleClientOptions) {
    this.fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init));
    this.sleep = options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;
  }

  /** Lists every property visible to the Google identity. Callers must intersect with the allowlist. */
  async listSites(): Promise<SiteEntry[]> {
    const json = await this.request("sites_list", "GET", `${API_BASE}/sites`);
    const parsed = sitesResponseSchema.safeParse(json);
    if (!parsed.success) throw new GscError("malformed_response", "Search Console returned an unexpected response shape.");
    return parsed.data.siteEntry;
  }

  /** `siteUrl` must already have passed `resolveSite`; it is re-checked defensively. */
  async querySearchAnalytics(siteUrl: string, spec: SearchAnalyticsSpec): Promise<SearchAnalyticsResponse> {
    if (!isValidSiteUrl(siteUrl)) throw new GscError("invalid_property", "Invalid property identifier.");
    validateSpec(spec);
    const url = `${API_BASE}/sites/${encodeURIComponent(siteUrl)}/searchAnalytics/query`;
    const json = await this.request("search_analytics", "POST", url, JSON.stringify(buildRequestBody(spec)));
    const parsed = queryResponseSchema.safeParse(json);
    if (!parsed.success) throw new GscError("malformed_response", "Search Console returned an unexpected response shape.");
    // Every row must identify itself by exactly the requested dimensions; a dimension identity is never fabricated.
    if (parsed.data.rows.some((r) => r.keys.length !== spec.dimensions.length)) {
      throw new GscError("malformed_response", "Search Console returned rows that do not match the requested dimensions.");
    }
    return parsed.data;
  }

  private async request(operation: string, method: "GET" | "POST", url: string, body?: string): Promise<unknown> {
    let refreshedAfter401 = false;
    for (let attempt = 0; ; attempt++) {
      let token: string;
      try {
        token = await this.options.tokens.getAccessToken(GOOGLE_SCOPES.searchConsoleReadonly, refreshedAfter401);
      } catch (error) {
        if (error instanceof GoogleAuthError) throw mapAuthError(error);
        throw new GscError("google_auth_unavailable", "Google authentication is temporarily unavailable. Retry later.");
      }
      const started = Date.now();
      let response: Response | undefined;
      let timedOut = false;
      try {
        response = await this.fetchImpl(url, {
          method,
          headers: {
            authorization: `Bearer ${token}`,
            accept: "application/json",
            ...(body !== undefined ? { "content-type": "application/json" } : {}),
          },
          ...(body !== undefined ? { body } : {}),
          signal: AbortSignal.timeout(this.timeoutMs),
        });
      } catch (error) {
        timedOut = (error as { name?: string } | undefined)?.name === "TimeoutError";
        response = undefined;
      }

      // Fixed diagnostic fields only: never the site, queries, tokens or bodies.
      const log = (outcome: string) =>
        console.warn(JSON.stringify({ event: "gsc_request", operation, attempt, status: response?.status ?? (timedOut ? "timeout" : "network_error"), outcome, durationMs: Date.now() - started }));

      if (response === undefined) {
        if (attempt < MAX_RETRIES) {
          log("retry");
          await this.sleep(200 * 2 ** attempt);
          continue;
        }
        log("failed");
        throw timedOut
          ? new GscError("timeout", "Search Console did not respond in time. Retry later.")
          : new GscError("provider_unavailable", "Search Console is temporarily unreachable. Retry later.");
      }

      if (response.ok) {
        const text = await readBounded(response);
        if (text === undefined) {
          log("too_large");
          throw new GscError("response_too_large", "The Search Console response exceeded the size limit. Request fewer rows or dimensions.");
        }
        try {
          return JSON.parse(text);
        } catch {
          log("malformed");
          throw new GscError("malformed_response", "Search Console returned an unreadable response.");
        }
      }

      const info = googleErrorInfo((await readBounded(response)) ?? "");
      const wait = retryAfter(response);
      const has = (...r: string[]) => r.some((x) => info.reasons.includes(x));

      if (response.status === 401 && !refreshedAfter401) {
        log("refresh_token");
        refreshedAfter401 = true;
        continue;
      }
      if (response.status === 401) {
        log("failed");
        throw new GscError("google_auth_invalid", "Google rejected the access token. The operator must check the credential.");
      }
      if (response.status === 400) {
        log("failed");
        throw new GscError("invalid_request", "Google rejected the request (unsupported or incompatible dimensions, filters, type or dates).");
      }
      if (response.status === 403 || response.status === 429) {
        const apiDisabled = has("accessNotConfigured", "SERVICE_DISABLED", "API_DISABLED");
        const scope = has("ACCESS_TOKEN_SCOPE_INSUFFICIENT");
        const rateReason = has("rateLimitExceeded", "userRateLimitExceeded", "RATE_LIMIT_EXCEEDED");
        const quotaReason = !rateReason && (has("quotaExceeded", "dailyLimitExceeded") || info.status === "RESOURCE_EXHAUSTED");
        if (apiDisabled) {
          log("failed");
          throw new GscError("api_disabled", "The Google Search Console API is not enabled for the Google Cloud project (operator action; see docs/gsc.md).");
        }
        if (scope) {
          log("failed");
          throw mapAuthError(new GoogleAuthError("scope_missing"));
        }
        if (quotaReason || rateReason || response.status === 429) {
          const code: GscErrorCode = quotaReason ? "quota_exceeded" : "rate_limited";
          // Short Retry-After is honored for rate limiting; quota exhaustion and longer waits are surfaced.
          if (code === "rate_limited" && wait !== undefined && wait <= MAX_RETRY_AFTER_SECONDS && attempt < MAX_RETRIES) {
            log("retry");
            await this.sleep(wait * 1000);
            continue;
          }
          log(code);
          throw new GscError(code, code === "quota_exceeded" ? "The Search Console API quota is exhausted. Retry later." : "Search Console is rate limiting requests. Retry later.", wait);
        }
        log("failed");
        throw new GscError("permission_denied", "The Google identity lacks permission for this Search Console property.");
      }
      if (response.status === 404) {
        log("failed");
        throw new GscError("permission_denied", "The Search Console property was not found or the Google identity cannot access it.");
      }
      // Transient 5xx: exponential backoff without Retry-After; a Retry-After within the short-wait budget is honored
      // exactly (never shortened). A longer one is not slept: stop and surface it as retryAfterSeconds.
      if ([500, 502, 503, 504].includes(response.status) && attempt < MAX_RETRIES && (wait === undefined || wait <= MAX_RETRY_AFTER_SECONDS)) {
        log("retry");
        await this.sleep(wait !== undefined ? wait * 1000 : 200 * 2 ** attempt);
        continue;
      }
      log("failed");
      throw new GscError("provider_unavailable", "Search Console is temporarily unavailable. Retry later.", wait);
    }
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Shaping

const PERMISSION_UNVERIFIED = "siteUnverifiedUser";

/** Intersects Google's visible properties with the allowlist; ordering is a deterministic code-unit sort. */
export function shapeSites(allowed: string[], visible: SiteEntry[]) {
  const allowedSet = new Set(allowed);
  const byUrl = new Map<string, SiteEntry>();
  for (const s of visible) if (allowedSet.has(s.siteUrl) && !byUrl.has(s.siteUrl)) byUrl.set(s.siteUrl, s);
  const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
  const sites = [...byUrl.values()]
    .sort((a, b) => compare(a.siteUrl, b.siteUrl))
    .map((s) => ({ siteUrl: s.siteUrl, permissionLevel: s.permissionLevel, queryable: s.permissionLevel !== PERMISSION_UNVERIFIED }));
  return {
    sites,
    count: sites.length,
    // Allowlisted by the operator but absent from Google's list: not accessible to the authorized identity.
    approvedButNotAccessible: allowed.filter((a) => !byUrl.has(a)).sort(compare),
    source: "google-search-console" as const,
    note: "Only properties on the server allowlist are shown. queryable=false means Google reports the identity as an unverified user of that property.",
  };
}

export function shapeSearchAnalytics(siteUrl: string, spec: SearchAnalyticsSpec, response: SearchAnalyticsResponse) {
  const rows = response.rows.slice(0, spec.limit).map((r) => ({
    dimensions: Object.fromEntries(spec.dimensions.map((d, i) => [d, r.keys[i]])),
    clicks: r.clicks ?? null,
    impressions: r.impressions ?? null,
    ctr: r.ctr ?? null,
    position: r.position ?? null,
  }));
  // Google gives no total row count: a full page only means more rows MAY exist.
  const hasMorePossible = rows.length === spec.limit;
  return {
    siteUrl,
    dateRange: { ...spec.dateRange, timeZone: GSC_TIME_ZONE },
    dimensions: [...spec.dimensions],
    type: spec.type,
    dataState: spec.dataState,
    rows,
    returnedRowCount: rows.length,
    pagination: { limit: spec.limit, offset: spec.offset, nextOffset: hasMorePossible ? spec.offset + rows.length : null, hasMorePossible },
    responseAggregationType: response.responseAggregationType ?? null,
    metadata: response.metadata ?? {},
    source: "google-search-console" as const,
    note: "Search Console data is incomplete by design: anonymized queries are omitted and only top rows are returned, so an empty result does not prove zero traffic and totals will not reconcile with the Search Console UI or GA4. Impressions are not page views. ctr is a ratio (0.05 = 5%) and position is Google's average position; neither may be summed or averaged across rows. Absent metrics are null, never 0, and missing dates are not backfilled. There is no total row count; hasMorePossible/nextOffset are advisory only, and offset paging can skip or repeat rows because Google orders equal-click rows arbitrarily. Dates are America/Los_Angeles calendar days; recent days may be incomplete (see metadata.first_incomplete_date, which Google provides only when dataState=all and the report is grouped by date).",
  };
}
