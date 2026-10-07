/**
 * Bearer API-key authentication for `/mcp`.
 *
 * The credential is a dedicated anas-mcp key read from a Cloudflare Secrets Store binding. It must never be
 * logged, echoed in a response, or reused from another system (see docs/credentials.md).
 */

const encoder = new TextEncoder();

/** Extract the token from `Authorization: Bearer <token>`; undefined for a missing/malformed/empty value. */
export function parseBearerToken(header: string | null): string | undefined {
  if (!header) return undefined;
  const match = /^Bearer[ \t]+(\S+)$/i.exec(header.trim());
  return match?.[1];
}

/**
 * Timing-resistant equality: both values are hashed to fixed-length digests first so neither the length nor a
 * matching prefix influences the comparison, then compared with a constant-time loop over every byte.
 */
export async function secretsEqual(a: string, b: string): Promise<boolean> {
  const [da, db] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(a)),
    crypto.subtle.digest("SHA-256", encoder.encode(b)),
  ]);
  const ba = new Uint8Array(da);
  const bb = new Uint8Array(db);
  let diff = 0;
  for (let i = 0; i < ba.length; i++) diff |= ba[i] ^ bb[i];
  return diff === 0;
}

/** Read the configured key. Returns undefined when the binding is absent, unreadable, or empty. */
async function readConfiguredKey(binding: SecretsStoreSecret | undefined): Promise<string | undefined> {
  if (!binding) return undefined;
  try {
    const value = await binding.get();
    return value ? value : undefined;
  } catch {
    return undefined;
  }
}

/** True only when the request carries the configured dedicated API key. Fails closed on any problem. */
export async function isAuthorized(request: Request, binding: SecretsStoreSecret | undefined): Promise<boolean> {
  const supplied = parseBearerToken(request.headers.get("authorization"));
  const configured = await readConfiguredKey(binding);
  if (supplied === undefined || configured === undefined) return false;
  return secretsEqual(supplied, configured);
}

/** Small generic 401. Identical for every failure cause so it reveals nothing about the credential or binding. */
export function unauthorizedResponse(): Response {
  return new Response(JSON.stringify({ error: "unauthorized" }), {
    status: 401,
    headers: { "content-type": "application/json", "www-authenticate": "Bearer", "cache-control": "no-store" },
  });
}
