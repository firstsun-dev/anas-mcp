import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";

const spec = parse(readFileSync(new URL("../openapi.yaml", import.meta.url), "utf8")) as {
  components: { securitySchemes: Record<string, Record<string, unknown>> };
  paths: { "/mcp": { post: { security: Record<string, unknown>[] } } };
};

describe("openapi.yaml Cloudflare Access OAuth security scheme", () => {
  const oauth = spec.components.securitySchemes.CloudflareAccessOAuth;

  it("is type `oauth2` with `oauth2MetadataUrl` pointing at the real RFC 8414 discovery document", () => {
    // OpenAPI 3.2 (OAS spec section 4.27.1) added `oauth2MetadataUrl` to the `oauth2` Security Scheme Object
    // specifically for an authorization server whose real endpoints are published via RFC 8414 metadata rather
    // than fixed in advance. `openIdConnect`/`openIdConnectUrl` is the wrong vocabulary for this: it names a
    // full OpenID Connect Discovery document, and Cloudflare Access's Managed OAuth for MCP is plain OAuth 2.0
    // metadata (RFC 8414 + RFC 9728), not OIDC.
    expect(oauth.type).toBe("oauth2");
    expect(oauth.oauth2MetadataUrl).toBe("https://mcp.firstsun.org/.well-known/oauth-authorization-server");
    expect(oauth).not.toHaveProperty("openIdConnectUrl");
  });

  it("has a `flows` object present (required by the OAS 3.2 schema for type oauth2) without fabricating a flow", () => {
    // The OAS 3.2 JSON Schema requires the `flows` key to be present when `type: oauth2`, but the "OAuth Flows
    // Object" schema itself has no required/minProperties constraint, so `{}` is schema-valid. Verified against
    // https://spec.openapis.org/oas/3.2/schema/2026-08-30 directly (fetched and checked with ajv) and confirmed
    // with `redocly lint`, which errors if `flows` is removed entirely and also strictly rejects unknown
    // security-scheme fields (checked by injecting a bogus field), so its clean pass on this shape is meaningful.
    expect(oauth.flows).toEqual({});
  });

  it("never fabricates a fixed authorization_endpoint/token_endpoint and never reuses the metadata URL as one", () => {
    // Cloudflare Access does not publish fixed authorize/token endpoints for Managed OAuth; stating any single
    // URL for either would be false. This also guards against regressing to the earlier, also-wrong shape that
    // pointed both `authorizationUrl` and `tokenUrl` at the metadata document itself.
    const flows = oauth.flows as Record<string, unknown>;
    for (const flow of Object.values(flows)) {
      expect(flow).not.toHaveProperty("authorizationUrl");
      expect(flow).not.toHaveProperty("tokenUrl");
    }
    expect(String(oauth.oauth2MetadataUrl)).not.toMatch(/cdn-cgi\/access\/oauth/);
  });

  it("/mcp requires Managed OAuth (Mode A) OR both Service Token headers together (Mode B), never a third mode", () => {
    const security = spec.paths["/mcp"].post.security;
    expect(security).toHaveLength(2);
    expect(security[0]).toEqual({ CloudflareAccessOAuth: [] });
    expect(security[1]).toEqual({
      CloudflareAccessServiceTokenId: [],
      CloudflareAccessServiceTokenSecret: [],
    });
  });
});
