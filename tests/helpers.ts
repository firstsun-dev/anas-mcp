import worker, { type Env } from "../src/index";

let id = 0;

export async function mcpCall(env: Env, method: string, params: Record<string, unknown> = {}) {
  const res = await worker.fetch(
    new Request("http://localhost/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", host: "localhost" },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
    }),
    env,
    { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext,
  );
  const text = await res.text();
  const dataLine = text.split("\n").find((l) => l.startsWith("data:"));
  return { status: res.status, text, json: JSON.parse(dataLine ? dataLine.slice(5) : text) };
}

export const TOKEN = "test-token-SECRET-123";
export const envWithToken = (token = TOKEN): Env => ({ BING_WEBMASTER_TOKEN: { get: async () => token } });
