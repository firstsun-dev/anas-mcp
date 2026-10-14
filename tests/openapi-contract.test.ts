import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";

const spec = parse(readFileSync(new URL("../openapi.yaml", import.meta.url), "utf8")) as {
  components: { securitySchemes: Record<string, Record<string, unknown>> };
  paths: { "/mcp": { post: { security: Record<string, unknown>[] } } };
};

describe("openapi.yaml Cloudflare Access OAuth security scheme", () => {
  const oauth = spec.components.securitySchemes.CloudflareAccessOAuth;

  it("does not model Managed OAuth as `oauth2` with a hard-coded authorizationUrl/tokenUrl", () => {
    // Cloudflare Access does not publish fixed authorization/token endpoints for Managed OAuth: they are only
    // discoverable dynamically from the RFC 8414/9728 metadata document. An `oauth2` scheme requires fixed
    // `authorizationUrl`/`tokenUrl` strings, so using one here -- especially pointing both at the metadata
    // document -- would misrepresent the discovery document as the real endpoints to any Swagger/OpenAPI client
    // that tries to actually drive the flow.
    expect(oauth.type).not.toBe("oauth2");
    expect(oauth).not.toHaveProperty("flows");
  });

  it("uses `openIdConnect` with the real discovery URL instead", () => {
    expect(oauth.type).toBe("openIdConnect");
    expect(oauth.openIdConnectUrl).toBe("https://mcp.firstsun.org/.well-known/oauth-authorization-server");
  });

  it("the discovery URL is never reused as a fabricated authorization/token endpoint path", () => {
    expect(String(oauth.openIdConnectUrl)).not.toMatch(/cdn-cgi\/access\/oauth/);
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
