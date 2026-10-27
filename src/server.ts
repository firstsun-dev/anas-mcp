import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { BingAnalyticsRepository, hyperdriveRunner } from "./services/bing-analytics";
import { ClarityAnalyticsRepository, clarityHyperdriveRunner, parseProjectKeys } from "./services/clarity-analytics";
import { GoogleTokenProvider } from "./auth/google-oauth";
import { GoogleAnalyticsClient, parsePropertyIds } from "./services/google-analytics";
import { GoogleSearchConsoleClient, parseAllowedSites } from "./services/google-search-console";
import { registerGoogleAnalyticsTools } from "./tools/google-analytics";
import { registerGoogleSearchConsoleTools } from "./tools/google-search-console";
import { registerBingWebmasterTools } from "./tools/bing-webmaster";
import { registerClarityTools } from "./tools/clarity";
import type { Env } from "./index";

export function createServer(env: Env = {}) {
  // Clarity is enabled only when the Hyperdrive binding AND an approved CLARITY_PROJECT_KEYS allowlist exist.
  const clarity = new ClarityAnalyticsRepository(clarityHyperdriveRunner(env.ANALYTICS_DB), parseProjectKeys(env.CLARITY_PROJECT_KEYS));
  // GA4 is advertised only when the credential binding AND a valid property allowlist exist. This is configuration
  // readiness only: /health and this tool never call Google, so it does not prove production API access.
  const tokens = new GoogleTokenProvider({ secret: env.GOOGLE_OAUTH_CREDENTIALS });
  const ga4PropertyIds = parsePropertyIds(env.GA4_PROPERTY_IDS);
  const ga4Enabled = tokens.configured && ga4PropertyIds.length > 0;
  const gscAllowedSites = parseAllowedSites(env.GSC_ALLOWED_SITES);
  const gscEnabled = tokens.configured && gscAllowedSites.length > 0;
  const enabledSources = [
    ...(env.ANALYTICS_DB ? ["bing"] : []),
    ...(env.ANALYTICS_DB && clarity.configured ? ["clarity"] : []),
    ...(ga4Enabled ? ["ga4"] : []),
    ...(gscEnabled ? ["search-console"] : []),
  ];
  const plannedSources = ["ga4", "search-console"].filter((s) => !enabledSources.includes(s));
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
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async () => ({
      content: [
        {
          type: "text",
          text: JSON.stringify({
            service: "anas-mcp",
            status: "ok",
            enabledSources,
            plannedSources,
          }),
        },
      ],
    }),
  );

  registerBingWebmasterTools(server, new BingAnalyticsRepository(hyperdriveRunner(env.ANALYTICS_DB)));
  registerClarityTools(server, clarity);
  registerGoogleAnalyticsTools(server, { propertyIds: ga4PropertyIds, client: new GoogleAnalyticsClient({ tokens }) });
  // Same GoogleTokenProvider instance as GA4: one credential, one access-token cache.
  registerGoogleSearchConsoleTools(server, { allowedSites: gscAllowedSites, client: new GoogleSearchConsoleClient({ tokens }) });

  return server;
}
