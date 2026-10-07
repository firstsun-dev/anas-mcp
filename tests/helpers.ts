import worker, { type Env } from "../src/index";

let id = 0;

/** Obviously fake, test-only key. Never a real credential. */
export const TEST_API_KEY = "test-only-fake-key-0000";
export const testKeyBinding = (value: string = TEST_API_KEY): SecretsStoreSecret => ({ get: async () => value });
const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;

export function rawMcpRequest(env: Env, headers: Record<string, string> = {}) {
  return worker.fetch(
    new Request("http://localhost/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", host: "localhost", ...headers },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method: "tools/list", params: {} }),
    }),
    env,
    ctx,
  );
}

/** Authenticated MCP call: supplies the test key binding (unless the env has its own) and the matching header. */
export async function mcpCall(env: Env, method: string, params: Record<string, unknown> = {}) {
  env = { ANAS_MCP_API_KEY: testKeyBinding(), ...env };
  const res = await worker.fetch(
    new Request("http://localhost/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", host: "localhost", authorization: `Bearer ${TEST_API_KEY}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
    }),
    env,
    ctx,
  );
  const text = await res.text();
  const dataLine = text.split("\n").find((l) => l.startsWith("data:"));
  return { status: res.status, text, json: JSON.parse(dataLine ? dataLine.slice(5) : text) };
}
