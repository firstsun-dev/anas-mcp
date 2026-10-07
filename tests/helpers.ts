import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair, type JWTVerifyGetKey } from "jose";
import { createHandler, type Env } from "../src/index";

let id = 0;

/** Obviously fake, test-only Access identifiers. Never real production values. */
export const TEST_TEAM_DOMAIN = "test-team.cloudflareaccess.com";
export const TEST_ISSUER = `https://${TEST_TEAM_DOMAIN}`;
export const TEST_AUD = "test-only-aud-0000000000000000";

const kid = "test-key-1";
export const signingKey = await generateKeyPair("RS256", { extractable: true });
/** A second, unrelated key: signatures from it must be rejected. */
export const rogueKey = await generateKeyPair("RS256", { extractable: true });
const jwk = { ...(await exportJWK(signingKey.publicKey)), kid, alg: "RS256", use: "sig" };
const getKey: JWTVerifyGetKey = createLocalJWKSet({ keys: [jwk] });

const worker = createHandler(getKey);
const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;

export const accessEnv = (extra: Partial<Env> = {}): Env => ({ ACCESS_TEAM_DOMAIN: TEST_TEAM_DOMAIN, ACCESS_AUD: TEST_AUD, ...extra });

export interface AssertionOptions {
  iss?: string;
  aud?: string | string[];
  /** Seconds relative to now. */
  exp?: number;
  nbf?: number;
  key?: CryptoKey;
  alg?: string;
}

/** Sign a test Access assertion. Defaults produce a valid token for TEST_ISSUER/TEST_AUD. */
export async function signAssertion(o: AssertionOptions = {}): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const jwt = new SignJWT({ type: "app", sub: "test-subject" })
    .setProtectedHeader({ alg: o.alg ?? "RS256", kid })
    .setIssuedAt(now)
    .setIssuer(o.iss ?? TEST_ISSUER)
    .setAudience(o.aud ?? TEST_AUD)
    .setExpirationTime(now + (o.exp ?? 300));
  if (o.nbf !== undefined) jwt.setNotBefore(now + o.nbf);
  return jwt.sign(o.key ?? signingKey.privateKey);
}

export function rawMcpRequest(env: Env, headers: Record<string, string> = {}, body: unknown = { method: "tools/list", params: {} }) {
  return worker.fetch!(
    new Request("http://localhost/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", host: "localhost", ...headers },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++id, ...(body as object) }),
    }) as never,
    env,
    ctx,
  );
}

export const handler = worker;

/** Authenticated MCP call: supplies Access config (unless given) and a valid Access assertion header. */
export async function mcpCall(env: Env, method: string, params: Record<string, unknown> = {}) {
  const res = await rawMcpRequest(accessEnv(env), { "cf-access-jwt-assertion": await signAssertion() }, { method, params });
  const text = await res.text();
  const dataLine = text.split("\n").find((l) => l.startsWith("data:"));
  return { status: res.status, text, json: JSON.parse(dataLine ? dataLine.slice(5) : text) };
}
