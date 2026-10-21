import { SignJWT } from "jose";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MCP_ROUTE, type Env } from "../src/index";
import { TEST_AUD, TEST_ISSUER, accessEnv, handler, mcpCall, signAssertion, signingKey } from "./helpers";

// Exact-path contract of https://mcp.firstsun.org/anas (openspec/changes/migrate-mcp-endpoint-to-anas). The hostname is
// shared with future MCP services, so only the exact path `/anas` may reach the MCP handler; `/mcp` is retired.
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
const BASE = "https://mcp.firstsun.org";
const RPC = { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} };

beforeEach(() => {
  pg.constructed = 0;
});

function post(path: string, headers: Record<string, string> = {}, method = "POST") {
  return handler.fetch!(
    new Request(`${BASE}${path}`, {
      method,
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", host: "mcp.firstsun.org", ...headers },
      body: method === "POST" ? JSON.stringify(RPC) : undefined,
    }) as never,
    env(),
    ctx,
  );
}

describe("canonical endpoint", () => {
  it("is exactly /anas", () => {
    expect(MCP_ROUTE).toBe("/anas");
  });

  it("serves MCP initialization and tool discovery at /anas with a valid assertion", async () => {
    const init = await mcpCall(env(), "initialize", {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "path-test", version: "0.0.0" },
    });
    expect(init.status).toBe(200);
    expect(init.json.result.serverInfo).toBeDefined();
    const list = await mcpCall(env(), "tools/list");
    expect(list.status).toBe(200);
    expect(list.json.result.tools.map((t: { name: string }) => t.name)).toContain("health");
  });

  it("accepts a Service Token style assertion (common_name, no user identity) the same as an OAuth one", async () => {
    const now = Math.floor(Date.now() / 1000);
    const serviceAssertion = await new SignJWT({ type: "app", common_name: "svc-client-id.access" })
      .setProtectedHeader({ alg: "RS256", kid: "test-key-1" })
      .setIssuedAt(now)
      .setIssuer(TEST_ISSUER)
      .setAudience(TEST_AUD)
      .setExpirationTime(now + 300)
      .sign(signingKey.privateKey);
    const res = await post("/anas", { "cf-access-jwt-assertion": serviceAssertion });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("tools");
  });
});

describe("retired and non-canonical paths never reach MCP", () => {
  const paths = ["/mcp", "/mcp/", "/anas2", "/anas-other", "/anas/", "/anas/mcp", "/anas/x", "/ANAS", "/infra", "/knowledge", "/", "//anas", "/anas%2F"];

  it.each(paths)("%s returns 404 for an authenticated request, with no MCP or database work", async (path) => {
    const res = await post(path, { "cf-access-jwt-assertion": await signAssertion() });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not_found" });
    expect(res.headers.get("location")).toBeNull();
    expect(pg.constructed).toBe(0);
  });

  it.each(paths)("%s returns 404 (not tools) for an unauthenticated request", async (path) => {
    const res = await post(path);
    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain("tools");
    expect(pg.constructed).toBe(0);
  });

  it.each(["GET", "DELETE", "OPTIONS"])("%s on a non-canonical path is also 404", async (method) => {
    const res = await post("/mcp", { "cf-access-jwt-assertion": await signAssertion() }, method);
    expect(res.status).toBe(404);
  });

  it("does not resolve a retired /mcp request that carries a query string to /anas", async () => {
    const res = await post("/mcp?path=/anas", { "cf-access-jwt-assertion": await signAssertion() });
    expect(res.status).toBe(404);
  });
});

describe("/anas still fails closed before MCP", () => {
  it.each([
    ["missing assertion", async () => ({}) as Record<string, string>],
    ["wrong audience", async () => ({ "cf-access-jwt-assertion": await signAssertion({ aud: "another-service-aud" }) })],
    ["wrong issuer", async () => ({ "cf-access-jwt-assertion": await signAssertion({ iss: "https://evil.cloudflareaccess.com" }) })],
  ])("%s -> 401 with no database access", async (_name, headers) => {
    const res = await post("/anas", await headers());
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
    expect(pg.constructed).toBe(0);
  });
});

describe("OAuth discovery is owned by Cloudflare Access, not the Worker", () => {
  // Access serves the protected-resource metadata at the edge, and the Worker never advertises its own. If a
  // request for these documents ever reaches the Worker, it must not answer with a fabricated document.
  it.each(["/.well-known/cloudflare-access-protected-resource/anas", "/.well-known/oauth-authorization-server", "/.well-known/oauth-protected-resource"])(
    "%s is not served by the Worker",
    async (path) => {
      const res = await post(path, {}, "GET");
      expect(res.status).toBe(404);
    },
  );
});

describe("/health", () => {
  it("stays the minimal public GET, and only GET", async () => {
    const ok = await post("/health", {}, "GET");
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ service: "anas-mcp", status: "ok" });
    expect((await post("/health")).status).toBe(404);
    expect((await post("/health/", {}, "GET")).status).toBe(404);
    expect(pg.constructed).toBe(0);
  });
});
