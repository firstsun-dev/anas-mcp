import { createMcpHandler } from "agents/mcp/server";
import { isAuthorized, unauthorizedResponse } from "./auth/mcp-api-key";
import { createServer } from "./server";

export interface Env {
  /** Read-only Hyperdrive binding to the windmill_pipeline PostgreSQL database (schema blog_analytics). */
  ANALYTICS_DB?: Hyperdrive;
  /** Cloudflare Secrets Store binding for the dedicated anas-mcp bearer API key. Async: use `.get()`. */
  ANAS_MCP_API_KEY?: SecretsStoreSecret;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/health") {
      return Response.json({ service: "anas-mcp", status: "ok" });
    }

    // Authenticate before MCP initialization, createServer(), or any tool/database access.
    if (!(await isAuthorized(request, env.ANAS_MCP_API_KEY))) {
      return unauthorizedResponse();
    }

    return createMcpHandler(() => createServer(env), { route: "/mcp" })(
      request,
      env,
      ctx,
    );
  },
} satisfies ExportedHandler<Env>;
