import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/index";
import { verifyAccessAssertion } from "../src/auth/cloudflare-access";
import {
  TEST_AUD,
  TEST_ISSUER,
  TEST_TEAM_DOMAIN,
  accessEnv,
  handler,
  mcpCall,
  rawMcpRequest,
  rogueKey,
  signAssertion,
  signingKey,
} from "./helpers";

// Spy on the paths that must NOT run for unauthenticated requests: the Hyperdrive/pg driver and tool execution.
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
const makeEnv = (): Env => accessEnv({ ANALYTICS_DB: hyperdrive });
const A = "cf-access-jwt-assertion";

beforeEach(() => {
  pg.constructed = 0;
});

async function expectRejected(res: Response, leaks: string[] = []) {
  expect(res.status).toBe(401);
  const body = await res.text();
  expect(JSON.parse(body)).toEqual({ error: "unauthorized" });
  for (const leak of [...leaks, TEST_AUD, TEST_TEAM_DOMAIN]) expect(body).not.toContain(leak);
  expect(JSON.stringify([...res.headers])).not.toContain(TEST_AUD);
  expect(pg.constructed).toBe(0);
}

describe("/mcp Cloudflare Access assertion validation", () => {
  it("rejects a missing Cf-Access-Jwt-Assertion before MCP initialization", async () => {
    await expectRejected(await rawMcpRequest(makeEnv()));
  });
  it("ignores Service Token and OAuth credential headers without an assertion (Access, not the Worker, validates them)", async () => {
    await expectRejected(
      await rawMcpRequest(makeEnv(), {
        authorization: "Bearer oauth-opaque-token-1234",
        "cf-access-client-id": "svc-client-id.access",
        "cf-access-client-secret": "svc-client-secret-5678",
        "x-anas-mcp-service-token": "single-header-token-9999",
      }),
    );
  });
  it("rejects a malformed assertion", async () => {
    for (const v of ["not-a-jwt", "a.b.c", "....", " ", "Bearer abc"]) {
      await expectRejected(await rawMcpRequest(makeEnv(), { [A]: v }), v.trim() ? [v.trim()] : []);
    }
  });
  it("rejects an assertion with an invalid signature", async () => {
    await expectRejected(await rawMcpRequest(makeEnv(), { [A]: await signAssertion({ key: rogueKey.privateKey }) }));
  });
  it("rejects a tampered payload", async () => {
    const [h, , s] = (await signAssertion()).split(".");
    const forged = Buffer.from(JSON.stringify({ iss: TEST_ISSUER, aud: TEST_AUD, exp: 4102444800 })).toString("base64url");
    await expectRejected(await rawMcpRequest(makeEnv(), { [A]: `${h}.${forged}.${s}` }));
  });
  it("rejects an unsigned (alg=none) token and a non-RS256 algorithm", async () => {
    const enc = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
    const now = Math.floor(Date.now() / 1000);
    const none = `${enc({ alg: "none" })}.${enc({ iss: TEST_ISSUER, aud: TEST_AUD, exp: now + 300 })}.`;
    await expectRejected(await rawMcpRequest(makeEnv(), { [A]: none }));
    const hs = `${enc({ alg: "HS256", kid: "test-key-1" })}.${enc({ iss: TEST_ISSUER, aud: TEST_AUD, exp: now + 300 })}.c2ln`;
    await expectRejected(await rawMcpRequest(makeEnv(), { [A]: hs }));
  });
  it("rejects the wrong issuer / team domain", async () => {
    await expectRejected(await rawMcpRequest(makeEnv(), { [A]: await signAssertion({ iss: "https://other-team.cloudflareaccess.com" }) }));
  });
  it("rejects the wrong application AUD", async () => {
    await expectRejected(await rawMcpRequest(makeEnv(), { [A]: await signAssertion({ aud: "another-app-aud" }) }), ["another-app-aud"]);
  });
  it("rejects an expired assertion", async () => {
    await expectRejected(await rawMcpRequest(makeEnv(), { [A]: await signAssertion({ exp: -3600 }) }));
  });
  it("rejects a not-yet-valid assertion (nbf in the future)", async () => {
    await expectRejected(await rawMcpRequest(makeEnv(), { [A]: await signAssertion({ nbf: 3600 }) }));
  });
  it("does not initialize MCP or execute a tool for an unauthenticated tools/call", async () => {
    const res = await rawMcpRequest(makeEnv(), {}, { method: "tools/call", params: { name: "bing_list_sites", arguments: {} } });
    await expectRejected(res);
  });
  it("accepts a valid assertion and reaches the existing MCP handler (AUD may be an array)", async () => {
    const r = await mcpCall(makeEnv(), "tools/list");
    expect(r.status).toBe(200);
    expect(r.json.result.tools.map((t: any) => t.name)).toContain("health");
    const arr = await rawMcpRequest(makeEnv(), { [A]: await signAssertion({ aud: [TEST_AUD, "second-aud"] }) });
    expect(arr.status).toBe(200);
  });
  it("fails closed with a generic 503 when team domain or AUD is not configured, before MCP", async () => {
    const assertion = await signAssertion();
    for (const env of [{}, { ACCESS_TEAM_DOMAIN: "", ACCESS_AUD: "" }, accessEnv({ ACCESS_AUD: "" }), accessEnv({ ACCESS_TEAM_DOMAIN: "evil.example.com" })] as Env[]) {
      const res = await rawMcpRequest({ ...env, ANALYTICS_DB: hyperdrive }, { [A]: assertion });
      expect(res.status).toBe(503);
      const body = await res.text();
      expect(JSON.parse(body)).toEqual({ error: "auth_unavailable" });
      expect(body).not.toContain(TEST_AUD);
      expect(pg.constructed).toBe(0);
    }
  });
  it("does not log assertions, credentials, or auth headers", async () => {
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => {}));
    const valid = await signAssertion();
    const bad = await signAssertion({ key: rogueKey.privateKey });
    await rawMcpRequest(makeEnv(), {
      [A]: bad,
      authorization: "Bearer oauth-opaque-token-1234",
      "cf-access-client-id": "svc-client-id.access",
      "cf-access-client-secret": "svc-client-secret-5678",
    });
    await rawMcpRequest(makeEnv(), { [A]: "malformed-assertion-value" });
    await rawMcpRequest(makeEnv());
    await rawMcpRequest({}, { [A]: valid });
    await mcpCall(makeEnv(), "tools/list");
    const logged = JSON.stringify(spies.flatMap((s) => s.mock.calls));
    expect(logged).toContain("access_rejected"); // rejections are observable via fixed reason codes only
    for (const secret of [valid, bad, "malformed-assertion-value", "oauth-opaque-token-1234", "svc-client-id.access", "svc-client-secret-5678", TEST_AUD]) {
      expect(logged).not.toContain(secret);
    }
    expect(logged.toLowerCase()).not.toContain("authorization");
    spies.forEach((s) => s.mockRestore());
  });
});

describe("/health", () => {
  it("is available without an Access assertion and stays minimal, even with no Access config", async () => {
    for (const env of [makeEnv(), {} as Env]) {
      const res = await handler.fetch!(new Request("http://localhost/health") as never, env, {} as ExecutionContext);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ service: "anas-mcp", status: "ok" });
    }
  });
});

describe("verifyAccessAssertion", () => {
  const req = (assertion?: string) => new Request("http://localhost/mcp", { headers: assertion ? { [A]: assertion } : {} });
  const config = { teamDomain: TEST_TEAM_DOMAIN, audience: TEST_AUD };

  it("reports stable non-sensitive reason codes", async () => {
    expect(await verifyAccessAssertion(req(), config)).toEqual({ ok: false, kind: "unauthorized", reason: "missing_assertion" });
    expect(await verifyAccessAssertion(req(), {})).toMatchObject({ kind: "misconfigured" });
    const { createLocalJWKSet } = await import("jose");
    const keys = createLocalJWKSet({ keys: [] });
    const r = await verifyAccessAssertion(req(await signAssertion()), config, keys);
    expect(r).toMatchObject({ ok: false, kind: "unauthorized" });
    expect(JSON.stringify(r)).not.toContain(TEST_AUD);
  });
  it("rejects assertions signed by an unlisted key", async () => {
    expect(signingKey.publicKey).toBeDefined();
    const r = await verifyAccessAssertion(req(await signAssertion({ key: rogueKey.privateKey })), config, async () => signingKey.publicKey);
    expect(r.ok).toBe(false);
  });
});
