import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { GoogleAuthError } from "../auth/google-oauth";
import {
  DATA_STATES,
  DEFAULT_ROW_LIMIT,
  DIMENSION_NAMES,
  FILTER_OPERATORS,
  GoogleSearchConsoleClient,
  GscError,
  MAX_DIMENSIONS,
  MAX_FILTER_LENGTH,
  MAX_OFFSET,
  MAX_ROW_LIMIT,
  SEARCH_TYPES,
  mapAuthError,
  resolveDateRange,
  resolveSite,
  shapeSearchAnalytics,
  shapeSites,
  type FilterSpec,
  type SearchAnalyticsSpec,
} from "../services/google-search-console";

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

export interface GscContext {
  /** Parsed `GSC_ALLOWED_SITES`; empty means unconfigured (fail closed). */
  allowedSites: string[];
  client: GoogleSearchConsoleClient;
  /** Injectable clock for the Pacific-time default range. */
  now?: () => Date;
}

const DATA_NOTE =
  "Read-only Google Search Console data. Dates are America/Los_Angeles calendar days. Data is NOT exhaustive: Google omits anonymized queries and returns only top rows, so an empty result does not prove zero traffic and totals will not reconcile with the Search Console UI or GA4. Impressions are not GA4 page views. ctr is a ratio (not a percentage) and position is Google's average; do not sum or average either across rows. Missing metrics are null, never 0. There is no total row count: hasMorePossible is advisory and offset paging can skip or repeat rows because Google orders equal-click rows arbitrarily.";

const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

function ok(payload: Record<string, unknown>) {
  return { content: [{ type: "text" as const, text: JSON.stringify(payload) }], structuredContent: payload };
}

function fail(error: unknown) {
  let known: GscError | undefined;
  if (error instanceof GscError) known = error;
  else if (error instanceof GoogleAuthError) known = mapAuthError(error);
  const payload = known
    ? { code: known.code, message: known.message, ...(known.retryAfterSeconds !== undefined ? { retryAfterSeconds: known.retryAfterSeconds } : {}) }
    : { code: "provider_unavailable", message: "Search Console is temporarily unavailable. Retry later." };
  return { content: [{ type: "text" as const, text: JSON.stringify({ error: payload }) }], isError: true as const };
}

const filter = (expression: string | undefined, operator: FilterSpec["operator"]): FilterSpec | undefined =>
  expression === undefined ? undefined : { operator, expression };

export function registerGoogleSearchConsoleTools(server: McpServer, ctx: GscContext) {
  server.registerTool(
    "gsc_list_sites",
    {
      title: "Search Console: list sites",
      description: `Lists the Search Console properties that are both accessible to the authorized Google identity and on the server-side allowlist, with Google's exact siteUrl and permissionLevel (siteOwner, siteFullUser, siteRestrictedUser, siteUnverifiedUser). Allowlisted properties Google does not return are listed in approvedButNotAccessible; queryable=false marks unverified access. Properties outside the allowlist are never shown. Configuration readiness in health does not prove live Google authorization; this tool does.`,
      inputSchema: z.object({}),
      annotations: READ_ONLY,
    },
    async () => {
      try {
        if (ctx.allowedSites.length === 0) {
          throw new GscError("configuration_missing", "Search Console is not configured: GSC_ALLOWED_SITES is missing or malformed.");
        }
        return ok(shapeSites(ctx.allowedSites, await ctx.client.listSites()));
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.registerTool(
    "gsc_search_analytics",
    {
      title: "Search Console: search analytics",
      description: `Search performance (clicks, impressions, ctr, position) for one allowlisted property, grouped by 1-${MAX_DIMENSIONS} of query, page, date, country, device. Defaults: dimensions=["query"], type="web", dataState="final", limit=${DEFAULT_ROW_LIMIT} (max ${MAX_ROW_LIMIT}), offset=0 (max ${MAX_OFFSET}), range = previous 28 completed days in America/Los_Angeles; explicit startDate+endDate must be given together (max 366 days). pageFilter/queryFilter are single text matches (operator contains or equals, up to ${MAX_FILTER_LENGTH} characters); no regex or raw request is accepted. discover and googleNews have no query data. dataState="all" includes fresh, possibly incomplete data (see metadata.first_incomplete_date); "final" omits it, so the latest days can be empty. ${DATA_NOTE}`,
      inputSchema: z.object({
        siteUrl: z.string().min(1).max(512).describe("Exact Search Console property identifier, e.g. a URL-prefix property ending in / or sc-domain:example.com. Must be on the server allowlist."),
        startDate: dateSchema.optional().describe("YYYY-MM-DD (America/Los_Angeles). Provide together with endDate; omit both for the previous 28 completed days."),
        endDate: dateSchema.optional().describe("YYYY-MM-DD, inclusive. Provide together with startDate."),
        dimensions: z.array(z.enum(DIMENSION_NAMES)).min(1).max(MAX_DIMENSIONS).default(["query"]),
        type: z.enum(SEARCH_TYPES).default("web"),
        dataState: z.enum(DATA_STATES).default("final"),
        limit: z.number().int().min(1).max(MAX_ROW_LIMIT).default(DEFAULT_ROW_LIMIT),
        offset: z.number().int().min(0).max(MAX_OFFSET).default(0).describe("Advisory paging only; Google gives no total count and equal-click ordering is arbitrary."),
        pageFilter: z.string().min(1).max(MAX_FILTER_LENGTH).optional().describe("Match against the page URL."),
        pageFilterOperator: z.enum(FILTER_OPERATORS).default("contains"),
        queryFilter: z.string().min(1).max(MAX_FILTER_LENGTH).optional().describe("Match against the search query (not for discover/googleNews)."),
        queryFilterOperator: z.enum(FILTER_OPERATORS).default("contains"),
      }),
      annotations: READ_ONLY,
    },
    async (input) => {
      try {
        // Order: configuration + property validation + exact allowlist membership, then local validation of the rest;
        // only then is a token requested (inside the client) and Google called.
        const siteUrl = resolveSite(ctx.allowedSites, input.siteUrl);
        const spec: SearchAnalyticsSpec = {
          dimensions: input.dimensions,
          type: input.type,
          dataState: input.dataState,
          dateRange: resolveDateRange(input.startDate, input.endDate, ctx.now?.()),
          limit: input.limit,
          offset: input.offset,
          pageFilter: filter(input.pageFilter, input.pageFilterOperator),
          queryFilter: filter(input.queryFilter, input.queryFilterOperator),
        };
        return ok(shapeSearchAnalytics(siteUrl, spec, await ctx.client.querySearchAnalytics(siteUrl, spec)));
      } catch (error) {
        return fail(error);
      }
    },
  );
}
