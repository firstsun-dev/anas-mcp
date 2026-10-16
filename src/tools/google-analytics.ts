import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { GoogleAuthError } from "../auth/google-oauth";
import {
  DEFAULT_ROW_LIMIT,
  DIMENSION_NAMES,
  Ga4Error,
  GoogleAnalyticsClient,
  MAX_DIMENSIONS,
  MAX_RUN_REPORT_METRICS,
  MAX_OFFSET,
  MAX_ROW_LIMIT,
  METRIC_NAMES,
  mapAuthError,
  resolveDateRange,
  resolveProperty,
  shapeReport,
  type DimensionName,
  type MetricName,
  type ReportSpec,
} from "../services/google-analytics";

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

export interface Ga4Context {
  /** Parsed `GA4_PROPERTY_IDS`; empty means unconfigured (fail closed). */
  propertyIds: string[];
  client: GoogleAnalyticsClient;
}

const propertyIdSchema = z
  .string()
  .regex(/^\d{1,20}$/)
  .optional()
  .describe("Numeric GA4 property ID. Optional when exactly one property is approved; rejected unless on the server allowlist.");
const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const startSchema = dateSchema.optional().describe("YYYY-MM-DD. Defaults (with endDate) to the previous 28 completed days in the property timezone.");
const endSchema = dateSchema.optional().describe("YYYY-MM-DD, inclusive. Provide together with startDate.");
const limitSchema = z.number().int().min(1).max(MAX_ROW_LIMIT).default(DEFAULT_ROW_LIMIT);
const offsetSchema = z.number().int().min(0).max(MAX_OFFSET).default(0);

const SEMANTICS_NOTE =
  "Read-only Google Analytics 4 Data API report. Dates are interpreted in the GA4 property timezone (propertyTimeZone). Values are Google's: missing values are null, never 0, and GA4 metrics are not interchangeable with Clarity or Bing metrics. metadata.subjectToThresholding / samplingMetadatas / dataLossFromOtherRow report Google's data-quality flags. responseTruncated=true means this response omitted rows locally; hasMore with nextOffset drives pagination. No data-freshness guarantee is implied.";

function ok(payload: Record<string, unknown>) {
  return { content: [{ type: "text" as const, text: JSON.stringify(payload) }], structuredContent: payload };
}

function fail(error: unknown) {
  let known: Ga4Error | undefined;
  if (error instanceof Ga4Error) known = error;
  else if (error instanceof GoogleAuthError) known = mapAuthError(error);
  const payload = known
    ? { code: known.code, message: known.message, ...(known.retryAfterSeconds !== undefined ? { retryAfterSeconds: known.retryAfterSeconds } : {}) }
    : { code: "provider_unavailable", message: "Google Analytics is temporarily unavailable. Retry later." };
  return { content: [{ type: "text" as const, text: JSON.stringify({ error: payload }) }], isError: true as const };
}

async function run(ctx: Ga4Context, propertyId: string | undefined, spec: ReportSpec) {
  // Allowlist check happens first, so nothing reaches Google for an unapproved property.
  const id = resolveProperty(ctx.propertyIds, propertyId);
  return shapeReport(id, spec, await ctx.client.runReport(id, spec));
}

const OVERVIEW_METRICS: MetricName[] = ["activeUsers", "totalUsers", "sessions", "engagedSessions", "engagementRate", "screenPageViews", "averageSessionDuration"];
const PAGE_METRICS: MetricName[] = ["screenPageViews", "activeUsers", "sessions", "engagementRate", "userEngagementDuration"];
const ACQUISITION_METRICS: MetricName[] = ["sessions", "engagedSessions", "engagementRate", "averageSessionDuration", "bounceRate"];
const ACQUISITION_DIMENSIONS: DimensionName[] = ["sessionDefaultChannelGroup", "sessionSource", "sessionMedium"];

export function registerGoogleAnalyticsTools(server: McpServer, ctx: Ga4Context) {
  server.registerTool(
    "ga4_overview",
    {
      title: "GA4: site overview",
      description: `Whole-property GA4 totals (active users, total users, sessions, engaged sessions, engagement rate, screen/page views, average session duration). ${SEMANTICS_NOTE}`,
      inputSchema: z.object({ propertyId: propertyIdSchema, startDate: startSchema, endDate: endSchema }),
      annotations: READ_ONLY,
    },
    async ({ propertyId, startDate, endDate }) => {
      try {
        const spec: ReportSpec = { dimensions: [], metrics: OVERVIEW_METRICS, dateRange: resolveDateRange(startDate, endDate), limit: 1, offset: 0 };
        return ok(await run(ctx, propertyId, spec));
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.registerTool(
    "ga4_pages",
    {
      title: "GA4: pages",
      description: `Traffic and engagement per page. groupBy="path" (default) groups by hostName + pagePath, so URLs differing only by query string (share, utm_*, fbclid, gclid, ...) are one row; Google aggregates the metrics (users and rates are never summed locally). Path grouping does NOT preserve distinctions carried only in query parameters (e.g. /search?q=a vs ?q=b); use groupBy="fullUrl" for per-hostName + pagePathPlusQueryString rows (hostname + path + query string; hosts are never merged in either mode). Ordered by screenPageViews descending then the grouping dimensions; page with offset. pagePath filters to paths beginning with that prefix in both modes. ${SEMANTICS_NOTE}`,
      inputSchema: z.object({
        propertyId: propertyIdSchema,
        startDate: startSchema,
        endDate: endSchema,
        limit: limitSchema,
        offset: offsetSchema,
        pagePath: z.string().min(1).max(512).startsWith("/").optional().describe("Only pages whose path (without query string) begins with this prefix, e.g. /blog/."),
        groupBy: z.enum(["path", "fullUrl"]).default("path").describe('"path" (default): one row per hostName + pagePath. "fullUrl": one row per hostName + pagePathPlusQueryString (hostname + path + query string; query strings kept distinct).'),
      }),
      annotations: READ_ONLY,
    },
    async ({ propertyId, startDate, endDate, limit, offset, pagePath, groupBy }) => {
      try {
        const spec: ReportSpec = {
          dimensions: groupBy === "fullUrl" ? ["hostName", "pagePathPlusQueryString"] : ["hostName", "pagePath"],
          metrics: PAGE_METRICS,
          dateRange: resolveDateRange(startDate, endDate),
          limit,
          offset,
          pagePathPrefix: pagePath,
        };
        return ok({ ...(await run(ctx, propertyId, spec)), groupBy });
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.registerTool(
    "ga4_acquisition",
    {
      title: "GA4: acquisition",
      description: `Session-scoped acquisition by default channel group, source and medium (not first-user acquisition). Rows are separate cells; do not sum users across them. Ordered by sessions descending. ${SEMANTICS_NOTE}`,
      inputSchema: z.object({ propertyId: propertyIdSchema, startDate: startSchema, endDate: endSchema, limit: limitSchema, offset: offsetSchema }),
      annotations: READ_ONLY,
    },
    async ({ propertyId, startDate, endDate, limit, offset }) => {
      try {
        const spec: ReportSpec = { dimensions: ACQUISITION_DIMENSIONS, metrics: ACQUISITION_METRICS, dateRange: resolveDateRange(startDate, endDate), limit, offset };
        return ok(await run(ctx, propertyId, spec));
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.registerTool(
    "ga4_run_report",
    {
      title: "GA4: controlled report",
      description: `Flexible read-only GA4 report over a fixed catalog of dimensions and metrics (max ${MAX_DIMENSIONS} dimensions, ${MAX_RUN_REPORT_METRICS} metrics, 366-day range, ${MAX_ROW_LIMIT} rows). No filters, expressions or raw request JSON are accepted. Session-scoped and first-user-scoped dimensions cannot be mixed; Google may reject other incompatible combinations (invalid_request). Ordered by the first metric descending (or by date ascending when date is requested), then dimensions. ${SEMANTICS_NOTE}`,
      inputSchema: z.object({
        propertyId: z.string().regex(/^\d{1,20}$/).describe("Numeric GA4 property ID (required; must be on the server allowlist)."),
        startDate: dateSchema,
        endDate: dateSchema,
        dimensions: z.array(z.enum(DIMENSION_NAMES)).max(MAX_DIMENSIONS).default([]),
        metrics: z.array(z.enum(METRIC_NAMES)).min(1).max(MAX_RUN_REPORT_METRICS),
        limit: limitSchema,
        offset: offsetSchema,
      }),
      annotations: READ_ONLY,
    },
    async ({ propertyId, startDate, endDate, dimensions, metrics, limit, offset }) => {
      try {
        const spec: ReportSpec = { dimensions, metrics, dateRange: resolveDateRange(startDate, endDate), limit, offset };
        return ok(await run(ctx, propertyId, spec));
      } catch (error) {
        return fail(error);
      }
    },
  );
}
