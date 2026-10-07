import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/index";
import worker from "../src/index";
import { parseBearerToken, secretsEqual } from "../src/auth/mcp-api-key";
import { TEST_API_KEY, mcpCall, rawMcpRequest, testKeyBinding } from "./helpers";

// Spy on the paths that must NOT run for unauthorized requests: the Hyperdrive/pg driver and tool execution.
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

const hyperdrive = { connectionString: "postgres://hyperdrive.invalid/db" } as unknown as Hyperdrive;
const makeEnv = (): Env => ({ ANAS_MCP_API_KEY: testKeyBinding(), ANALYTICS_DB: hyperdrive });

beforeEach(() => {
  pg.constructed = 0;
});

async function expectRejected(res: Response, leaks: string[] = []) {
  expect(res.status).toBe(401);
  expect(res.headers.get("www-authenticate")).toBe("Bearer");
  const body = await res.text();
  expect(JSON.parse(body)).toEqual({ error: "unauthorized" });
  for (const leak of leaks) expect(body).not.toContain(leak);
  expect(JSON.stringify([...res.headers])).not.toContain(TEST_API_KEY);
  expect(pg.constructed).toBe(0);
}

describe("/mcp bearer authentication", () => {
  it("rejects a missing Authorization header", async () => {
    await expectRejected(await rawMcpRequest(makeEnv()), [TEST_API_KEY]);
  });
  it("rejects a wrong scheme", async () => {
    await expectRejected(await rawMcpRequest(makeEnv(), { authorization: `Basic ${btoa("user:" + TEST_API_KEY)}` }), [TEST_API_KEY]);
  });
  it("rejects malformed Authorization values", async () => {
    for (const value of ["Bearer", "Bearer ", "BearerX", `Bearer a b`, TEST_API_KEY, `Token ${TEST_API_KEY}`]) {
      await expectRejected(await rawMcpRequest(makeEnv(), { authorization: value }), [TEST_API_KEY]);
    }
  });
  it("rejects an empty bearer token", async () => {
    await expectRejected(await rawMcpRequest(makeEnv(), { authorization: "Bearer    " }));
  });
  it("rejects an invalid bearer token without echoing it or the configured secret", async () => {
    const supplied = "wrong-supplied-value-9999";
    await expectRejected(await rawMcpRequest(makeEnv(), { authorization: `Bearer ${supplied}` }), [supplied, TEST_API_KEY]);
    // Prefix-matching and longer/shorter variants fail identically.
    for (const v of [TEST_API_KEY.slice(0, -1), TEST_API_KEY + "x", TEST_API_KEY.toUpperCase()]) {
      await expectRejected(await rawMcpRequest(makeEnv(), { authorization: `Bearer ${v}` }), [v, TEST_API_KEY]);
    }
  });
  it("fails closed when the binding is missing, throws, or is empty, with the same generic response", async () => {
    const headers = { authorization: `Bearer ${TEST_API_KEY}` };
    const bindings: (SecretsStoreSecret | undefined)[] = [
      undefined,
      { get: async () => { throw new Error("secret-binding-internal-detail"); } },
      { get: async () => "" },
    ];
    for (const binding of bindings) {
      await expectRejected(await rawMcpRequest({ ANAS_MCP_API_KEY: binding, ANALYTICS_DB: hyperdrive }, headers), ["secret-binding-internal-detail"]);
    }
  });
  it("does not initialize MCP or execute a tool for an unauthorized tools/call", async () => {
    const res = await worker.fetch(
      new Request("http://localhost/mcp", {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream", host: "localhost" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "bing_list_sites", arguments: {} } }),
      }),
      makeEnv(),
      { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext,
    );
    await expectRejected(res);
  });
  it("authorizes the valid key and reaches the existing MCP handler", async () => {
    const r = await mcpCall(makeEnv(), "tools/list");
    expect(r.status).toBe(200);
    expect(r.json.result.tools.map((t: any) => t.name)).toContain("health");
  });
  it("does not log credentials or headers", async () => {
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => {}));
    await rawMcpRequest(makeEnv(), { authorization: "Bearer wrong-supplied-value-9999" });
    await mcpCall(makeEnv(), "tools/list");
    const logged = JSON.stringify(spies.flatMap((s) => s.mock.calls));
    expect(logged).not.toContain(TEST_API_KEY);
    expect(logged).not.toContain("wrong-supplied-value-9999");
    expect(logged.toLowerCase()).not.toContain("authorization");
    spies.forEach((s) => s.mockRestore());
  });
});

describe("/health", () => {
  it("is available without authentication and stays minimal, even with no key bound", async () => {
    for (const env of [makeEnv(), {} as Env]) {
      const res = await worker.fetch(new Request("http://localhost/health"), env, {} as ExecutionContext);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ service: "anas-mcp", status: "ok" });
    }
  });
});

describe("auth helpers", () => {
  it("parses bearer tokens strictly", () => {
    expect(parseBearerToken("Bearer abc")).toBe("abc");
    expect(parseBearerToken("bearer abc")).toBe("abc");
    expect(parseBearerToken(null)).toBeUndefined();
    expect(parseBearerToken("Bearer")).toBeUndefined();
    expect(parseBearerToken("Basic abc")).toBeUndefined();
    expect(parseBearerToken("Bearer a b")).toBeUndefined();
  });
  it("compares secrets by value regardless of length", async () => {
    expect(await secretsEqual("abc", "abc")).toBe(true);
    expect(await secretsEqual("abc", "abd")).toBe(false);
    expect(await secretsEqual("abc", "abcd")).toBe(false);
    expect(await secretsEqual("", "abc")).toBe(false);
  });
});
