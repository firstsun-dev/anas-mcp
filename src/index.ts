import { createMcpHandler } from "agents/mcp/server";
import { localhostAllowedHostnames } from "@modelcontextprotocol/server";
import type { JWTVerifyGetKey } from "jose";
import { authUnavailableResponse, unauthorizedResponse, verifyAccessAssertion } from "./auth/cloudflare-access";
import { createServer } from "./server";

/**
 * The only public hostname `/mcp` serves. The SDK validates `Host` only for localhost and `workers.dev` endpoints and
 * "relies on Cloudflare routing" for custom domains, so an authenticated request for any other Host that happened to
 * reach the Worker would otherwise be served. Localhost names are kept for `wrangler dev` and tests.
 */
export const MCP_PUBLIC_HOSTNAME = "mcp.firstsun.org";
const MCP_ALLOWED_HOSTNAMES = [MCP_PUBLIC_HOSTNAME, ...localhostAllowedHostnames()];

export interface Env {
  /** Read-only Hyperdrive binding to the windmill_pipeline PostgreSQL database (schema blog_analytics). */
  ANALYTICS_DB?: Hyperdrive;
  /** Comma-separated approved Clarity `project_key` values (non-secret). Clarity tools fail closed until set. */
  CLARITY_PROJECT_KEYS?: string;
  /**
   * Secrets Store binding holding the shared Google OAuth `authorized_user` credential JSON (secret
   * `ANAS_PROD_GOOGLE_OAUTH_CREDENTIALS`). Read asynchronously; never logged. GA4 stays disabled until it is bound.
   */
  GOOGLE_OAUTH_CREDENTIALS?: SecretsStoreSecret;
  /** Comma-separated approved numeric GA4 property IDs (non-secret). GA4 tools fail closed until set. */
  GA4_PROPERTY_IDS?: string;
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
        return access.kind === "unauthorized" ? unauthorizedResponse() : authUnavailableResponse();
      }

      // Origin: browser clients are not supported (ChatGPT and Service Token callers are server-to-server and send no
      // Origin, which the SDK still accepts). An empty allowlist rejects every present Origin, including the SDK's
      // default localhost-class origins. No wildcard Host/Origin is ever configured.
      return createMcpHandler(() => createServer(env), {
        route: "/mcp",
        allowedHostnames: MCP_ALLOWED_HOSTNAMES,
        allowedOriginHostnames: [],
      })(request, env, ctx);
    },
  };
}

export default createHandler() satisfies ExportedHandler<Env>;
