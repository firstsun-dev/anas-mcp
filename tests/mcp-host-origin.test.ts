import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/index";
import { accessEnv, handler, signAssertion } from "./helpers";

// Host/Origin behavior of the real Cloudflare Agents SDK handler (agents@0.22) as configured in src/index.ts, driven
// against the production URL https://mcp.firstsun.org/mcp. Nothing here mocks the SDK's validation.
const pg = vi.hoisted(() => ({ constructed: 0 }));
vi.mock("pg", () => ({
  Client: class {
    constructor() {
      pg.constructed++;
    }
    async connect() {}
    async query() {
      return { rows: [] };
    }
    async end() {}
  },
}));

const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
const hyperdrive = { connectionString: "postgres://hyperdrive.invalid/db" } as unknown as Hyperdrive;
const env = (): Env => accessEnv({ ANALYTICS_DB: hyperdrive });
const PROD = "https://mcp.firstsun.org/mcp";

beforeEach(() => {
  pg.constructed = 0;
});

async function call(url: string, headers: Record<string, string> = {}, opts: { assertion?: boolean; method?: string } = {}) {
  const h: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    ...headers,
  };
  if (opts.assertion !== false) h["cf-access-jwt-assertion"] = await signAssertion();
  const method = opts.method ?? "POST";
  return handler.fetch!(
    new Request(url, {
      method,
      headers: h,
      body: method === "POST" ? JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }) : undefined,
    }) as never,
    env(),
    ctx,
  );
}

describe("MCP Host validation on the production endpoint", () => {
  it("accepts the legitimate production Host with no Origin (server-to-server clients: ChatGPT, Service Token)", async () => {
    const res = await call(PROD, { host: "mcp.firstsun.org" });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("tools");
  });

  it.each(["evil.example", "mcp.firstsun.org.evil.example", "firstsun.org", "anas-mcp.example.workers.dev", "203.0.113.7"])(
    "rejects an authenticated request for unexpected Host %s with 403 and no MCP/database work",
    async (host) => {
      const res = await call(`https://${host}/mcp`, { host });
      expect(res.status).toBe(403);
      expect(await res.text()).toMatch(/Invalid Host/);
      expect(pg.constructed).toBe(0);
    },
  );

  it("rejects a Host header that disagrees with the production URL", async () => {
    const res = await call(PROD, { host: "evil.example" });
    expect(res.status).toBe(403);
  });
});

describe("MCP Origin validation (no browser clients are supported)", () => {
  it.each([
    "https://evil.example",
    "https://mcp.firstsun.org.evil.example",
    "https://chatgpt.com",
    "https://mcp.firstsun.org",
    "http://localhost:3000",
    "null",
    "not a url",
  ])("rejects a present Origin %s even with a valid assertion", async (origin) => {
    const res = await call(PROD, { host: "mcp.firstsun.org", origin });
    expect(res.status).toBe(403);
    expect(await res.text()).toMatch(/Invalid Origin/);
    expect(pg.constructed).toBe(0);
  });

  it("does not echo a wildcard CORS grant to a rejected cross-origin caller beyond the SDK default", async () => {
    const res = await call(PROD, { host: "mcp.firstsun.org", origin: "https://evil.example" });
    expect(res.status).toBe(403);
    expect(res.headers.get("access-control-allow-credentials")).toBeNull();
  });

  it("rejects an OPTIONS preflight from an unapproved origin", async () => {
    const res = await call(PROD, { host: "mcp.firstsun.org", origin: "https://evil.example" }, { method: "OPTIONS", assertion: false });
    expect([401, 403]).toContain(res.status);
  });
});

describe("authentication is evaluated before Host/Origin/MCP/database work", () => {
  it("returns the generic 401 with no assertion, regardless of Host or Origin", async () => {
    for (const headers of [{ host: "mcp.firstsun.org" }, { host: "evil.example" }, { host: "mcp.firstsun.org", origin: "https://evil.example" }]) {
      const res = await call(`https://${headers.host}/mcp`, headers, { assertion: false });
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: "unauthorized" });
      expect(pg.constructed).toBe(0);
    }
  });
});

describe("public GET /health", () => {
  it("is reachable without an assertion on the production host and stays minimal", async () => {
    const res = await call("https://mcp.firstsun.org/health", {}, { assertion: false, method: "GET" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ service: "anas-mcp", status: "ok" });
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
    expect(pg.constructed).toBe(0);
  });
  it("does not expose MCP on /health for non-GET methods", async () => {
    const res = await call("https://mcp.firstsun.org/health", {}, { assertion: false, method: "POST" });
    expect(res.status).toBe(401);
  });
});
