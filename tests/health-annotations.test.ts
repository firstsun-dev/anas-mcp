import { describe, expect, it } from "vitest";
import type { Env } from "../src/index";
import { handler, mcpCall } from "./helpers";

const env: Env = {};

const EXPECTED_TOOLS = ["bing_list_sites", "bing_search_performance", "clarity_acquisition", "clarity_overview", "clarity_page", "clarity_pages", "ga4_acquisition", "ga4_overview", "ga4_pages", "ga4_run_report", "gsc_list_sites", "gsc_search_analytics", "health"];
const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

describe("health MCP tool annotations", () => {
  it("advertises health as read-only, non-destructive, idempotent and closed-world", async () => {
    const tools = (await mcpCall(env, "tools/list")).json.result.tools;
    const health = tools.find((t: any) => t.name === "health");
    expect(health.annotations.readOnlyHint).toBe(true);
    expect(health.annotations.destructiveHint).toBe(false);
    expect(health.annotations.idempotentHint).toBe(true);
    expect(health.annotations.openWorldHint).toBe(false);
  });

  it("keeps all 13 tools available and every one read-only", async () => {
    const tools = (await mcpCall(env, "tools/list")).json.result.tools;
    expect(tools.map((t: any) => t.name).sort()).toEqual(EXPECTED_TOOLS);
    for (const t of tools) expect(t.annotations, t.name).toMatchObject(READ_ONLY);
  });

  it("preserves the health tool response schema and values", async () => {
    const r = await mcpCall(env, "tools/call", { name: "health", arguments: {} });
    expect(r.json.result.content).toHaveLength(1);
    expect(r.json.result.content[0].type).toBe("text");
    expect(JSON.parse(r.json.result.content[0].text)).toEqual({
      service: "anas-mcp",
      status: "ok",
      enabledSources: [],
      plannedSources: ["ga4", "search-console"],
    });
  });

  it("leaves the HTTP /health route unchanged", async () => {
    const res = await handler.fetch!(new Request("http://localhost/health") as never, env, {} as ExecutionContext);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ service: "anas-mcp", status: "ok" });
  });
});
