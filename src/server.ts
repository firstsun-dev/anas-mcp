import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { BingAnalyticsRepository, hyperdriveRunner } from "./services/bing-analytics";
import { registerBingWebmasterTools } from "./tools/bing-webmaster";
import type { Env } from "./index";

export function createServer(env: Env = {}) {
  const server = new McpServer({
    name: "Firstsun Analytics",
    version: "0.1.0",
  });

  server.registerTool(
    "health",
    {
      title: "Analytics MCP health",
      description: "Return the current service health and enabled data-source roadmap.",
      inputSchema: z.object({}),
    },
    async () => ({
      content: [
        {
          type: "text",
          text: JSON.stringify({
            service: "anas-mcp",
            status: "ok",
            plannedSources: ["ga4", "search-console", "clarity-postgres"],
          }),
        },
      ],
    }),
  );

  registerBingWebmasterTools(server, new BingAnalyticsRepository(hyperdriveRunner(env.ANALYTICS_DB)));

  return server;
}
