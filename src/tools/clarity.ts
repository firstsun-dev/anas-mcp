import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import {
  ClarityAnalyticsError,
  ClarityAnalyticsRepository,
  DEFAULT_ROW_LIMIT,
  MAX_OFFSET,
  MAX_ROW_LIMIT,
} from "../services/clarity-analytics";

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

const projectKeySchema = z
  .string()
  .min(1)
  .max(64)
  .optional()
  .describe("Approved Clarity project key. Optional when exactly one project is approved; rejected unless it is on the server allowlist.");
const limitSchema = z.number().int().min(1).max(MAX_ROW_LIMIT).default(DEFAULT_ROW_LIMIT);
const offsetSchema = z.number().int().min(0).max(MAX_OFFSET).default(0);

function ok(payload: Record<string, unknown>) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload) }],
    structuredContent: payload,
  };
}

function fail(error: unknown) {
  // Only fixed, pre-vetted messages are returned; raw database errors, SQL, and DSNs never leave the service.
  const known = error instanceof ClarityAnalyticsError;
  const code = known ? error.code : "database_unavailable";
  const message = known ? error.message : "The analytics database is temporarily unavailable. Retry later.";
  return { content: [{ type: "text" as const, text: JSON.stringify({ error: { code, message } }) }], isError: true as const };
}

const SEMANTICS_NOTE =
  "Clarity data is an aggregate over a rolling window (coverage.windowStart..windowEnd), not a calendar-day or session warehouse. Windows from different runs overlap and are never summed; coverage.logicalDate is only a Taipei-local label. Metric values are passed through exactly as Clarity reported them (names, units and number formats are Clarity's); missing metrics are absent or null, never 0, and no data never means zero traffic. truncated=true means the source export hit its row ceiling and rows may be missing.";

export function registerClarityTools(server: McpServer, repository: ClarityAnalyticsRepository) {
  server.registerTool(
    "clarity_overview",
    {
      title: "Clarity: site overview",
      description: `Latest usable whole-site Microsoft Clarity observation (query site_overall): traffic, engagement time, scroll depth and behavioral signals that were actually ingested. Read-only; served from Windmill-ingested PostgreSQL, never from the Clarity API. ${SEMANTICS_NOTE}`,
      inputSchema: z.object({ projectKey: projectKeySchema }),
      annotations: READ_ONLY,
    },
    async ({ projectKey }) => {
      try {
        return ok(await repository.overview({ projectKey }));
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.registerTool(
    "clarity_pages",
    {
      title: "Clarity: page metrics",
      description: `Page-level Clarity metrics (query page) from the latest usable run, keyed by normalized page path (tracking parameters removed, trailing slash added). Ordered by page path for deterministic pagination; use hasMore/offset to page. Page-level values are not additive with site, device or source breakdowns. ${SEMANTICS_NOTE}`,
      inputSchema: z.object({
        projectKey: projectKeySchema,
        limit: limitSchema,
        offset: offsetSchema,
        pagePrefix: z.string().min(1).max(512).optional().describe("Only pages whose normalized path starts with this prefix, e.g. /blog/."),
      }),
      annotations: READ_ONLY,
    },
    async (input) => {
      try {
        return ok(await repository.pages(input));
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.registerTool(
    "clarity_acquisition",
    {
      title: "Clarity: acquisition",
      description: `Clarity acquisition breakdown (query acquisition) by source, medium and channel from the latest usable run. Unknown/empty attribution is returned as null, not dropped or relabeled; Clarity channel labels are not GA4 channel groups. Rows are separate breakdown cells and must not be summed into a total. ${SEMANTICS_NOTE}`,
      inputSchema: z.object({ projectKey: projectKeySchema, limit: limitSchema, offset: offsetSchema }),
      annotations: READ_ONLY,
    },
    async (input) => {
      try {
        return ok(await repository.acquisition(input));
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.registerTool(
    "clarity_page",
    {
      title: "Clarity: one page",
      description: `Clarity analytics for one page: its page-level observation plus device (page_device) and source (page_source) breakdowns, each from its own latest usable run with its own coverage. Breakdowns are separate cuts and are never added to page-level values. ${SEMANTICS_NOTE}`,
      inputSchema: z.object({
        projectKey: projectKeySchema,
        page: z.string().min(1).max(2048).describe("Site-relative path (e.g. /blog/post/) or full http(s) URL; normalized the same way as ingestion."),
      }),
      annotations: READ_ONLY,
    },
    async (input) => {
      try {
        return ok(await repository.page(input));
      } catch (error) {
        return fail(error);
      }
    },
  );
}
