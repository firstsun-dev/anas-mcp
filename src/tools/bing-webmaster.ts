import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import {
  BingAnalyticsError,
  BingAnalyticsRepository,
  DEFAULT_ROW_LIMIT,
  MAX_OFFSET,
  MAX_ROW_LIMIT,
  isValidCalendarDate,
} from "../services/bing-analytics";

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

const siteUrlSchema = z.string().min(1).max(2048).describe("Bing Webmaster site URL exactly as listed by bing_list_sites, e.g. https://example.com/");
const dateSchema = z.string().refine(isValidCalendarDate, "Use a real calendar date as YYYY-MM-DD");

function ok(payload: Record<string, unknown>) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload) }],
    structuredContent: payload,
  };
}

function fail(error: unknown) {
  // Only fixed, pre-vetted messages are returned; raw database errors, SQL, and DSNs never leave the service.
  const known = error instanceof BingAnalyticsError;
  const code = known ? error.code : "database_unavailable";
  const message = known ? error.message : "The analytics database is temporarily unavailable. Retry later.";
  return { content: [{ type: "text" as const, text: JSON.stringify({ error: { code, message } }) }], isError: true as const };
}

const FRESHNESS_NOTE =
  "Data is ingested by Windmill and served from the latest successful fetch. Check freshness.fetchedAt, freshness.dataThrough and freshness.stale; a failed or throttled newer fetch never replaces it.";

export function registerBingWebmasterTools(server: McpServer, repository: BingAnalyticsRepository) {
  server.registerTool(
    "bing_list_sites",
    {
      title: "Bing Webmaster: list sites",
      description: `List Bing Webmaster Tools sites from the latest successful ingestion. Read-only; verification codes are never stored or returned. ${FRESHNESS_NOTE}`,
      inputSchema: z.object({}),
      annotations: READ_ONLY,
    },
    async () => {
      try {
        return ok(await repository.listSites());
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.registerTool(
    "bing_search_performance",
    {
      title: "Bing Webmaster: search performance",
      description: `Read Bing search traffic statistics for a site, grouped by queries or pages, from the latest successful ingestion. Bing reports impressions, clicks, and separate average click/impression positions; these are not identical to Google Search Console metrics. Bing refreshes roughly weekly, so dataThrough can lag fetchedAt. Missing values are null, and no rows never means zero traffic. ${FRESHNESS_NOTE}`,
      inputSchema: z.object({
        siteUrl: siteUrlSchema,
        dimension: z.enum(["query", "page"]).default("query").describe("Group rows by queries or pages."),
        startDate: dateSchema.optional().describe("Inclusive provider stat date lower bound."),
        endDate: dateSchema.optional().describe("Inclusive provider stat date upper bound."),
        limit: z.number().int().min(1).max(MAX_ROW_LIMIT).default(DEFAULT_ROW_LIMIT),
        offset: z.number().int().min(0).max(MAX_OFFSET).default(0),
      }),
      annotations: READ_ONLY,
    },
    async ({ siteUrl, dimension, startDate, endDate, limit, offset }) => {
      try {
        const result = await repository.searchPerformance({ siteUrl, dimension, startDate, endDate, limit, offset });
        return ok({
          ...result,
          rows: result.rows.map(({ value, ...metrics }) => ({ [dimension]: value, ...metrics })),
          rowCount: result.rows.length,
        });
      } catch (error) {
        return fail(error);
      }
    },
  );
}
