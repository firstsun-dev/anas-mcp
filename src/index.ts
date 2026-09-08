import { createMcpHandler } from "agents/mcp/server";
import { createServer } from "./server";

export interface Env {}

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/health") {
      return Response.json({ service: "anas-mcp", status: "ok" });
    }

    return createMcpHandler(() => createServer(), { route: "/mcp" })(
      request,
      env,
      ctx,
    );
  },
} satisfies ExportedHandler<Env>;
