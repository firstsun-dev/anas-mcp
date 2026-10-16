import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { BingAnalyticsRepository, hyperdriveRunner } from "./services/bing-analytics";
import { ClarityAnalyticsRepository, clarityHyperdriveRunner, parseProjectKeys } from "./services/clarity-analytics";
import { registerBingWebmasterTools } from "./tools/bing-webmaster";
import { registerClarityTools } from "./tools/clarity";
import type { Env } from "./index";

export function createServer(env: Env = {}) {
  // Clarity is enabled only when the Hyperdrive binding AND an approved CLARITY_PROJECT_KEYS allowlist exist.
  const clarity = new ClarityAnalyticsRepository(clarityHyperdriveRunner(env.ANALYTICS_DB), parseProjectKeys(env.CLARITY_PROJECT_KEYS));
  const enabledSources = [...(env.ANALYTICS_DB ? ["bing"] : []), ...(env.ANALYTICS_DB && clarity.configured ? ["clarity"] : [])];
  const server = new McpServer({
    name: "Firstsun Analytics",
    version: "0.1.0",
  });

  server.registerTool(
    "health",
    {
      title: "Analytics MCP health",
      description: "Return the current service health, the data sources that are enabled now, and those still planned.",
      inputSchema: z.object({}),
    },
    async () => ({
      content: [
        {
          type: "text",
          text: JSON.stringify({
            service: "anas-mcp",
            status: "ok",
            enabledSources,
            plannedSources: ["ga4", "search-console"],
          }),
        },
      ],
    }),
  );

  registerBingWebmasterTools(server, new BingAnalyticsRepository(hyperdriveRunner(env.ANALYTICS_DB)));
  registerClarityTools(server, clarity);

  return server;
}
