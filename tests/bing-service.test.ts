import { describe, expect, it, vi } from "vitest";
import {
  BingWebmasterClient,
  BingWebmasterError,
  assertUrlBelongsToSite,
  isValidCalendarDate,
  parseBingDate,
  redactSecrets,
  secretsStoreTokenProvider,
} from "../src/services/bing-webmaster";

const TOKEN = "test-token-SECRET-123";
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function client(fetchImpl: typeof fetch, token: string | undefined | null = TOKEN) {
  return new BingWebmasterClient({ getToken: async () => token, fetchImpl, log: () => {} });
}
const stub = (res: Response | (() => Response)) =>
  vi.fn(async () => (typeof res === "function" ? res() : res.clone())) as unknown as typeof fetch;

async function codeOf(p: Promise<unknown>) {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(BingWebmasterError);
    // no credential in any error
    expect(String((e as Error).message)).not.toContain(TOKEN);
    expect(JSON.stringify(e)).not.toContain(TOKEN);
    return (e as BingWebmasterError).code;
  }
  throw new Error("expected rejection");
}

describe("secret handling", () => {
  it("missing binding -> missing_configuration", async () => {
    const c = new BingWebmasterClient({ getToken: secretsStoreTokenProvider(undefined), fetchImpl: stub(json({})), log: () => {} });
    expect(await codeOf(c.listSites())).toBe("missing_configuration");
  });
  it("empty / whitespace token -> missing_configuration and no upstream call", async () => {
    const f = stub(json({ d: [] }));
    expect(await codeOf(client(f, "").listSites())).toBe("missing_configuration");
    expect(await codeOf(client(f, "   ").listSites())).toBe("missing_configuration");
    expect(f).not.toHaveBeenCalled();
  });
  it("throwing binding is treated as missing configuration", async () => {
    const getToken = secretsStoreTokenProvider({ get: async () => { throw new Error(`boom ${TOKEN}`); } });
    expect(await getToken()).toBeUndefined();
  });
  it("redactSecrets removes apikey values and the token", () => {
    const out = redactSecrets(`GET https://x/y?siteUrl=a&apikey=${TOKEN}&z=1 ${TOKEN}`, TOKEN);
    expect(out).not.toContain(TOKEN);
    expect(out).toContain("apikey=[REDACTED]");
  });
  it("authentication failure (InvalidApiKey) does not leak the token", async () => {
    const f = stub(json({ ErrorCode: 3, Message: `InvalidApiKey ${TOKEN}` }, 400));
    expect(await codeOf(client(f).listSites())).toBe("authentication");
  });
});

describe("provider requests", () => {
  it("uses the JSON endpoint with GET and apikey query param, never SOAP/POX", async () => {
    const f = stub(json({ d: [] }));
    await client(f).listSites();
    const [url, init] = (f as any).mock.calls[0];
    expect(url).toMatch(/^https:\/\/ssl\.bing\.com\/webmaster\/api\.svc\/json\/GetUserSites\?apikey=/);
    expect(url).not.toMatch(/soap|pox/i);
    expect(init.method).toBe("GET");
    expect(init.headers.Authorization).toBeUndefined();
  });

  it("list sites: normalizes and drops verification codes", async () => {
    const f = stub(json({ d: [{ __type: "Site", AuthenticationCode: "AUTHSECRET", DnsVerificationCode: "DNSSECRET", IsVerified: true, Url: "https://example.com/" }] }));
    const sites = await client(f).listSites();
    expect(sites).toEqual([{ url: "https://example.com/", isVerified: true }]);
    expect(JSON.stringify(sites)).not.toMatch(/SECRET/);
  });

  it("search stats: normalizes rows and keeps missing values null", async () => {
    const f = stub(json({ d: [
      { Query: "q1", Date: "/Date(1316156400000-0700)/", Impressions: 100, Clicks: 15, AvgClickPosition: 18, AvgImpressionPosition: 17 },
      { Query: "q2", Impressions: 5 },
    ] }));
    const rows = await client(f).searchStats("https://example.com/", "query");
    expect(rows[0]).toEqual({ key: "q1", date: "2011-09-16T07:00:00.000Z", impressions: 100, clicks: 15, avgClickPosition: 18, avgImpressionPosition: 17 });
    expect(rows[1]).toEqual({ key: "q2", date: null, impressions: 5, clicks: null, avgClickPosition: null, avgImpressionPosition: null });
    expect((f as any).mock.calls[0][0]).toContain("/GetQueryStats?");
  });

  it("page dimension uses GetPageStats", async () => {
    const f = stub(json({ d: [] }));
    await client(f).searchStats("https://example.com/", "page");
    expect((f as any).mock.calls[0][0]).toContain("/GetPageStats?");
  });

  it("url info: normalizes subset", async () => {
    const f = stub(json({ d: { __type: "UrlInfo", AnchorCount: 50, DiscoveryDate: "/Date(1315349995266-0700)/", DocumentSize: 10, HttpStatus: 200, IsPage: true, LastCrawledDate: "/Date(1316213995266-0700)/", TotalChildUrlCount: 100, Url: "https://example.com/a" } }));
    const info = await client(f).urlInfo("https://example.com/", "https://example.com/a");
    expect(info).toMatchObject({ url: "https://example.com/a", isPage: true, httpStatus: 200, documentSizeBytes: 10, anchorCount: 50, totalChildUrlCount: 100 });
    expect(info.lastCrawledDate).toBe("2011-09-16T22:59:55.266Z");
    expect(JSON.stringify(info)).not.toContain("__type");
  });

  it.each([
    [401, {}, "authentication"],
    [403, {}, "authentication"],
    [429, {}, "rate_limited"],
    [400, { ErrorCode: 4, Message: "ThrottleUser" }, "rate_limited"],
    [500, { Message: `oops ${TOKEN}` }, "upstream"],
    [503, {}, "upstream"],
  ])("HTTP %s -> %s", async (status, body, code) => {
    expect(await codeOf(client(stub(json(body, status as number))).listSites())).toBe(code);
  });

  it("invalid JSON -> upstream", async () => {
    const f = stub(() => new Response("<html>nope</html>", { status: 200 }));
    expect(await codeOf(client(f).listSites())).toBe("upstream");
  });
  it("unexpected payload shape -> upstream", async () => {
    expect(await codeOf(client(stub(json({ d: "x" }))).listSites())).toBe("upstream");
    expect(await codeOf(client(stub(json({ nope: 1 }))).listSites())).toBe("upstream");
  });
  it("network failure (with token in error text) -> network, no leak", async () => {
    const f = vi.fn(async () => { throw new TypeError(`fetch failed apikey=${TOKEN}`); }) as unknown as typeof fetch;
    expect(await codeOf(client(f).listSites())).toBe("network");
  });
  it("timeout -> timeout", async () => {
    const f = vi.fn(async () => { throw new DOMException("t", "TimeoutError"); }) as unknown as typeof fetch;
    expect(await codeOf(client(f).listSites())).toBe("timeout");
  });
  it("logs only safe metadata", async () => {
    const log = vi.fn();
    await new BingWebmasterClient({ getToken: async () => TOKEN, fetchImpl: stub(json({ d: [] })), log }).listSites();
    expect(Object.keys(log.mock.calls[0][0]).sort()).toEqual(["latencyMs", "operation", "statusClass"]);
    expect(JSON.stringify(log.mock.calls)).not.toContain(TOKEN);
  });
});

describe("validation", () => {
  it.each(["not a url", "ftp://example.com/", "https://user:pw@example.com/", ""])("rejects invalid siteUrl %j", async (s) => {
    expect(await codeOf(client(stub(json({ d: [] }))).searchStats(s, "query"))).toBe("validation");
  });
  it("rejects malformed url", () => {
    expect(() => assertUrlBelongsToSite("https://example.com/", "::::")).toThrow(BingWebmasterError);
  });
  it.each([
    ["https://example.com/", "https://other-domain.com/foo"],
    ["https://example.com/", "https://example.com.evil.com/foo"],
    ["https://example.com/", "http://example.com/foo"],
    ["https://example.com/blog/", "https://example.com/other"],
    ["https://example.com/blog", "https://example.com/blogger"],
  ])("cross-site url rejected: %s vs %s", (site, url) => {
    expect(() => assertUrlBelongsToSite(site, url)).toThrow(/belong/);
  });
  it("accepts url under site", () => {
    expect(() => assertUrlBelongsToSite("https://example.com/", "https://example.com/a?b=1")).not.toThrow();
    expect(() => assertUrlBelongsToSite("https://example.com/blog/", "https://example.com/blog/post")).not.toThrow();
  });
  it("cross-domain urlInfo never reaches upstream", async () => {
    const f = stub(json({ d: {} }));
    await codeOf(client(f).urlInfo("https://example.com", "https://other-domain.com/foo"));
    expect(f).not.toHaveBeenCalled();
  });
});

describe("target url userinfo", () => {
  it.each(["https://user@example.com/a", "https://user:password@example.com/a"])("rejects %s", (url) => {
    expect(() => assertUrlBelongsToSite("https://example.com/", url)).toThrow(/without credentials/);
  });
  it("urlInfo with userinfo never reaches upstream", async () => {
    const f = stub(json({ d: {} }));
    expect(await codeOf(client(f).urlInfo("https://example.com/", "https://user:pass@example.com/a"))).toBe("validation");
    expect(f).not.toHaveBeenCalled();
  });
});

describe("isValidCalendarDate", () => {
  it.each(["2026-02-30", "2026-02-31", "2026-13-01", "2026-00-10", "2026-04-31", "2026-01-00", "2025-02-29", "2026-1-01", "2026-01-01x", ""])(
    "rejects %j",
    (v) => expect(isValidCalendarDate(v)).toBe(false),
  );
  it.each(["2024-02-29", "2026-02-28", "2026-12-31", "2000-02-29", "0004-02-29"])("accepts %j", (v) =>
    expect(isValidCalendarDate(v)).toBe(true),
  );
});

describe("parseBingDate", () => {
  it("parses WCF dates and rejects garbage", () => {
    expect(parseBingDate("/Date(0)/")).toBe("1970-01-01T00:00:00.000Z");
    expect(parseBingDate("2011-09-16")).toBeNull();
    expect(parseBingDate(5)).toBeNull();
  });
});
