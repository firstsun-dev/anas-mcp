import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import {
  BingWebmasterClient,
  BingWebmasterError,
  isValidCalendarDate,
  parseSiteUrl,
  type BingQueryStatsRow,
} from "../services/bing-webmaster";

export const MAX_SITES = 200;
export const DEFAULT_ROW_LIMIT = 25;
export const MAX_ROW_LIMIT = 200;
export const MAX_OFFSET = 100_000;

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };

const siteUrlSchema = z.string().min(1).max(2048).describe("Bing Webmaster site URL, e.g. https://example.com/");
const dateSchema = z.string().refine(isValidCalendarDate, "Use a real calendar date as YYYY-MM-DD");

function ok(payload: Record<string, unknown>) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload) }],
    structuredContent: payload,
  };
}

function fail(error: unknown) {
  // Only fixed, pre-vetted messages are returned; raw provider/upstream text never leaves the service.
  const known = error instanceof BingWebmasterError;
  const code = known ? error.code : "upstream";
  const message = known ? error.message : "Unexpected error while querying Bing Webmaster.";
  const payload = { error: { code, message } };
  return { content: [{ type: "text" as const, text: JSON.stringify(payload) }], isError: true as const };
}

export function filterAndPage(
  rows: BingQueryStatsRow[],
  opts: { startDate?: string; endDate?: string; limit: number; offset: number },
) {
  const filtered = rows.filter((row) => {
    if (!opts.startDate && !opts.endDate) return true;
    if (!row.date) return false;
    const day = row.date.slice(0, 10);
    return (!opts.startDate || day >= opts.startDate) && (!opts.endDate || day <= opts.endDate);
  });
  const page = filtered.slice(opts.offset, opts.offset + opts.limit);
  return { page, total: filtered.length, truncated: opts.offset + page.length < filtered.length };
}

export function registerBingWebmasterTools(server: McpServer, client: BingWebmasterClient) {
  server.registerTool(
    "bing_list_sites",
    {
      title: "Bing Webmaster: list sites",
      description:
        "List Bing Webmaster Tools sites accessible to the configured credential. Read-only; verification codes are never returned.",
      inputSchema: z.object({}),
      annotations: READ_ONLY,
    },
    async () => {
      try {
        const all = await client.listSites();
        const sites = all.slice(0, MAX_SITES);
        return ok({ sites, total: all.length, truncated: all.length > sites.length });
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.registerTool(
    "bing_search_performance",
    {
      title: "Bing Webmaster: search performance",
      description:
        "Read Bing search traffic statistics for a site, grouped by top queries or top pages. Bing reports impressions, clicks, and separate average click/impression positions; these are not identical to Google Search Console metrics. Bing data is provider-refreshed roughly weekly. Date filtering is applied after retrieval on the provider row date. Missing values are null.",
      inputSchema: z.object({
        siteUrl: siteUrlSchema,
        dimension: z
          .enum(["query", "page"])
          .default("query")
          .describe("Group rows by top queries or top pages."),
        startDate: dateSchema.optional(),
        endDate: dateSchema.optional(),
        limit: z.number().int().min(1).max(MAX_ROW_LIMIT).default(DEFAULT_ROW_LIMIT),
        offset: z.number().int().min(0).max(MAX_OFFSET).default(0),
      }),
      annotations: READ_ONLY,
    },
    async ({ siteUrl, dimension, startDate, endDate, limit, offset }) => {
      try {
        parseSiteUrl(siteUrl);
        if (startDate && endDate && startDate > endDate) {
          throw new BingWebmasterError("validation", "startDate must not be after endDate.");
        }
        const rows = await client.searchStats(siteUrl, dimension);
        const { page, total, truncated } = filterAndPage(rows, { startDate, endDate, limit, offset });
        return ok({
          siteUrl,
          dimension,
          rows: page.map(({ key, ...metrics }) => ({ [dimension]: key, ...metrics })),
          rowCount: page.length,
          totalRows: total,
          offset,
          truncated,
        });
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.registerTool(
    "bing_url_info",
    {
      title: "Bing Webmaster: URL info",
      description:
        "Read Bing index/crawl information for a URL under a Bing Webmaster site. The URL must belong to siteUrl. Read-only; never submits or modifies URLs.",
      inputSchema: z.object({
        siteUrl: siteUrlSchema,
        url: z.string().min(1).max(2048).describe("Absolute http(s) URL located under siteUrl."),
      }),
      annotations: READ_ONLY,
    },
    async ({ siteUrl, url }) => {
      try {
        return ok({ siteUrl, info: await client.urlInfo(siteUrl, url) });
      } catch (error) {
        return fail(error);
      }
    },
  );
}
