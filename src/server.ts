import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

export function createServer() {
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

  return server;
}
