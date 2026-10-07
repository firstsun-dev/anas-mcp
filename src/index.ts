import { createMcpHandler } from "agents/mcp/server";
import type { JWTVerifyGetKey } from "jose";
import { authUnavailableResponse, unauthorizedResponse, verifyAccessAssertion } from "./auth/cloudflare-access";
import { createServer } from "./server";

export interface Env {
  /** Read-only Hyperdrive binding to the windmill_pipeline PostgreSQL database (schema blog_analytics). */
  ANALYTICS_DB?: Hyperdrive;
  /** Cloudflare Access team domain (`<team>.cloudflareaccess.com`). Non-secret; owned by infra-config. */
  ACCESS_TEAM_DOMAIN?: string;
  /** AUD tag of the Access application protecting `/mcp`. Non-secret; owned by infra-config. */
  ACCESS_AUD?: string;
}

/** `getKey` is injectable for tests; production resolves keys from the team's Access JWKS. */
export function createHandler(getKey?: JWTVerifyGetKey): ExportedHandler<Env> {
  return {
    async fetch(request, env, ctx) {
      const url = new URL(request.url);

      if (request.method === "GET" && url.pathname === "/health") {
        return Response.json({ service: "anas-mcp", status: "ok" });
      }

      // Validate the Cloudflare Access assertion (Managed OAuth and Service Token both arrive as one) before MCP
      // initialization, createServer(), or any tool/database access.
      const access = await verifyAccessAssertion(
        request,
        { teamDomain: env.ACCESS_TEAM_DOMAIN, audience: env.ACCESS_AUD },
        getKey,
      );
      if (!access.ok) {
        // `reason` is a fixed non-sensitive code; never log headers, tokens, or claims.
        console.warn(JSON.stringify({ event: "access_rejected", reason: access.reason }));
        return access.kind === "misconfigured" ? authUnavailableResponse() : unauthorizedResponse();
      }

      return createMcpHandler(() => createServer(env), { route: "/mcp" })(request, env, ctx);
    },
  };
}

export default createHandler() satisfies ExportedHandler<Env>;
