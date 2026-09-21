import { createMcpHandler } from "agents/mcp/server";
import { createServer } from "./server";

export interface Env {
  /** Read-only Hyperdrive binding to the windmill_pipeline PostgreSQL database (schema blog_analytics). */
  ANALYTICS_DB?: Hyperdrive;
}

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/health") {
      return Response.json({ service: "anas-mcp", status: "ok" });
    }

    return createMcpHandler(() => createServer(env), { route: "/mcp" })(
      request,
      env,
      ctx,
    );
  },
} satisfies ExportedHandler<Env>;
