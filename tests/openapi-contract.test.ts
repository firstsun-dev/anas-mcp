import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";

const spec = parse(readFileSync(new URL("../openapi.yaml", import.meta.url), "utf8")) as {
  components: { securitySchemes: Record<string, Record<string, unknown>> };
  paths: { "/mcp": { post: { security: Record<string, unknown>[] } } };
};

const RESOURCE = "https://mcp.firstsun.org/mcp";
const PRM_URL = "https://mcp.firstsun.org/.well-known/cloudflare-access-protected-resource/mcp";
const AS_ISSUER = "https://firstsun.cloudflareaccess.com";
const AS_METADATA_URL = `${AS_ISSUER}/.well-known/oauth-authorization-server`;

describe("openapi.yaml Cloudflare Access OAuth security scheme", () => {
  const oauth = spec.components.securitySchemes.CloudflareAccessOAuth;

  it("is type `oauth2` with `oauth2MetadataUrl` pointing at the real RFC 8414 discovery document", () => {
    // OpenAPI 3.2 (OAS spec section 4.27.1) added `oauth2MetadataUrl` to the `oauth2` Security Scheme Object
    // specifically for an authorization server whose real endpoints are published via RFC 8414 metadata rather
    // than fixed in advance. `openIdConnect`/`openIdConnectUrl` is the wrong vocabulary for this: it names a
    // full OpenID Connect Discovery document, and Cloudflare Access's Managed OAuth for MCP is plain OAuth 2.0
    // metadata (RFC 8414 + RFC 9728), not OIDC.
    expect(oauth.type).toBe("oauth2");
    expect(oauth.oauth2MetadataUrl).toBe(AS_METADATA_URL);
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

describe("OAuth discovery chain (RFC 9728 -> RFC 8414), mocked responses", () => {
  const oauth = spec.components.securitySchemes.CloudflareAccessOAuth;

  // Shapes copied from read-only production responses (2026-10-14); no network access in tests.
  const responses: Record<string, unknown> = {
    [PRM_URL]: { resource: RESOURCE, authorization_servers: [AS_ISSUER] },
    [AS_METADATA_URL]: {
      issuer: AS_ISSUER,
      authorization_endpoint: `${AS_ISSUER}/cdn-cgi/access/oauth/authorization`,
      token_endpoint: `${AS_ISSUER}/cdn-cgi/access/oauth/token`,
      registration_endpoint: `${AS_ISSUER}/cdn-cgi/access/oauth/registration`,
      response_types_supported: ["code"],
      code_challenge_methods_supported: ["S256"],
    },
  };
  const fetchMock = async (url: string) => {
    if (!(url in responses)) throw new Error(`unexpected fetch ${url}`);
    return responses[url] as Record<string, any>;
  };

  it("the advertised authorization server's RFC 8414 URL equals openapi oauth2MetadataUrl", async () => {
    const prm = await fetchMock(PRM_URL);
    expect(prm.resource).toBe(RESOURCE);
    expect(prm.authorization_servers).toHaveLength(1);
    const metadataUrl = `${prm.authorization_servers[0]}/.well-known/oauth-authorization-server`;
    expect(metadataUrl).toBe(oauth.oauth2MetadataUrl);
    const as = await fetchMock(metadataUrl);
    expect(as.issuer).toBe(prm.authorization_servers[0]);
    expect(as.code_challenge_methods_supported).toContain("S256");
  });

  it("does not use the MCP resource host or protected-resource URL as the authorization server", () => {
    const url = new URL(String(oauth.oauth2MetadataUrl));
    expect(url.host).not.toBe(new URL(RESOURCE).host);
    expect(oauth.oauth2MetadataUrl).not.toBe(PRM_URL);
    expect(String(oauth.oauth2MetadataUrl)).not.toContain("cloudflare-access-protected-resource");
    expect(url.pathname).toBe("/.well-known/oauth-authorization-server");
  });

  it("Service Token security schemes are two required headers; OAuth and Service Token are alternatives", () => {
    const schemes = spec.components.securitySchemes;
    expect(schemes.CloudflareAccessServiceTokenId).toMatchObject({ type: "apiKey", in: "header", name: "CF-Access-Client-Id" });
    expect(schemes.CloudflareAccessServiceTokenSecret).toMatchObject({ type: "apiKey", in: "header", name: "CF-Access-Client-Secret" });
    const security = spec.paths["/mcp"].post.security;
    expect(security).toHaveLength(2);
    expect(Object.keys(security[0])).toEqual(["CloudflareAccessOAuth"]);
    expect(Object.keys(security[1]).sort()).toEqual(["CloudflareAccessServiceTokenId", "CloudflareAccessServiceTokenSecret"]);
  });
});
