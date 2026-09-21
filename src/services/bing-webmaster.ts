// Bing Webmaster Tools read-only client.
//
// Contract (verified against Microsoft Learn, see openspec/changes/add-bing-webmaster-tools/design.md):
//   GET https://ssl.bing.com/webmaster/api.svc/json/<Method>?apikey=<token>&...
//   success: 200 { "d": ... }    provider error: 400 { "ErrorCode": n, "Message": "..." }
// Only the JSON/HTTP interface is used. SOAP/POX are retired and must never be referenced here.
// The token is only ever attached to the outgoing request URL and is redacted from every error.

export type BingErrorCode =
  | "validation"
  | "missing_configuration"
  | "authentication"
  | "rate_limited"
  | "upstream"
  | "timeout"
  | "network";

const SAFE_MESSAGES: Record<BingErrorCode, string> = {
  validation: "Invalid request parameters.",
  missing_configuration:
    "Bing Webmaster credential is not configured. Bind the BING_WEBMASTER_TOKEN Secrets Store secret to the Worker.",
  authentication:
    "Bing Webmaster rejected the configured credential. Check that the API key is valid and has access to this site.",
  rate_limited: "Bing Webmaster quota or rate limit reached. Retry later.",
  upstream: "Bing Webmaster returned an unexpected error. Retry later.",
  timeout: "Bing Webmaster request timed out. Retry later.",
  network: "Could not reach Bing Webmaster. Retry later.",
};

export class BingWebmasterError extends Error {
  readonly code: BingErrorCode;
  constructor(code: BingErrorCode, detail?: string) {
    super(detail ?? SAFE_MESSAGES[code]);
    this.name = "BingWebmasterError";
    this.code = code;
  }
}

/** Remove any credential material from text destined for logs or clients. */
export function redactSecrets(text: string, token?: string): string {
  let out = text.replace(/(apikey=)[^&\s"']*/gi, "$1[REDACTED]");
  out = out.replace(/(authorization:\s*)[^\r\n]*/gi, "$1[REDACTED]");
  if (token && token.length > 0) out = out.split(token).join("[REDACTED]");
  return out;
}

export interface BingSite {
  url: string;
  isVerified: boolean | null;
}

export interface BingQueryStatsRow {
  /** Search query (dimension "query") or page URL (dimension "page"). */
  key: string | null;
  /** ISO 8601 UTC timestamp of the provider row date, if parseable. */
  date: string | null;
  impressions: number | null;
  clicks: number | null;
  avgClickPosition: number | null;
  avgImpressionPosition: number | null;
}

export interface BingUrlInfo {
  url: string | null;
  isPage: boolean | null;
  httpStatus: number | null;
  documentSizeBytes: number | null;
  anchorCount: number | null;
  totalChildUrlCount: number | null;
  discoveryDate: string | null;
  lastCrawledDate: string | null;
}

export interface BingLogEvent {
  operation: string;
  latencyMs: number;
  statusClass: string;
  resultCount?: number;
}

export interface BingClientOptions {
  /** Returns the provider token (Secrets Store binding at runtime). */
  getToken: () => Promise<string | undefined | null>;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  baseUrl?: string;
  log?: (event: BingLogEvent) => void;
}

const DEFAULT_BASE_URL = "https://ssl.bing.com/webmaster/api.svc/json";
const DEFAULT_TIMEOUT_MS = 10_000;
// Bound provider rows we are willing to process, regardless of what upstream returns.
const MAX_PROVIDER_ROWS = 50_000;

/** Adapt a Secrets Store binding into a token provider. */
export function secretsStoreTokenProvider(
  binding: { get(): Promise<string> } | undefined,
): () => Promise<string | undefined> {
  return async () => {
    if (!binding) return undefined;
    try {
      return await binding.get();
    } catch {
      // Never surface the raw binding error; treat as not configured.
      return undefined;
    }
  };
}

export function parseSiteUrl(value: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(value.trim());
  } catch {
    throw new BingWebmasterError("validation", "siteUrl must be a valid absolute http(s) URL.");
  }
  if (
    (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
    parsed.username ||
    parsed.password
  ) {
    throw new BingWebmasterError("validation", "siteUrl must be an http(s) URL without credentials.");
  }
  return parsed;
}

/** Validate that `url` is an http(s) URL located under `siteUrl`. */
export function assertUrlBelongsToSite(siteUrl: string, url: string): void {
  const site = parseSiteUrl(siteUrl);
  let target: URL;
  try {
    target = new URL(url.trim());
  } catch {
    throw new BingWebmasterError("validation", "url must be a valid absolute http(s) URL.");
  }
  if (target.protocol !== "http:" && target.protocol !== "https:") {
    throw new BingWebmasterError("validation", "url must be an http(s) URL.");
  }
  const samePath =
    site.pathname === "/" ||
    target.pathname === site.pathname ||
    target.pathname.startsWith(site.pathname.endsWith("/") ? site.pathname : `${site.pathname}/`);
  if (target.origin !== site.origin || !samePath) {
    throw new BingWebmasterError("validation", "url must belong to the specified siteUrl.");
  }
}

/** Parse the WCF JSON date format `/Date(1316156400000-0700)/` to ISO UTC. */
export function parseBingDate(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const match = /^\/Date\((-?\d+)(?:[+-]\d{4})?\)\/$/.exec(value);
  if (!match) return null;
  const date = new Date(Number(match[1]));
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
function str(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}
function bool(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function classify(status: number, body: unknown): BingErrorCode {
  const message = isRecord(body) && typeof body.Message === "string" ? body.Message : "";
  if (/InvalidApiKey|NotAuthorized|UserBlocked|UserNotFound/i.test(message)) return "authentication";
  if (/Throttle|Quota|TooMany/i.test(message)) return "rate_limited";
  if (isRecord(body) && body.ErrorCode === 3) return "authentication";
  if (status === 401 || status === 403) return "authentication";
  if (status === 429) return "rate_limited";
  if (status === 400 && /InvalidUrl|InvalidParameter|NotFound/i.test(message)) return "validation";
  return "upstream";
}

export class BingWebmasterClient {
  private readonly getToken: BingClientOptions["getToken"];
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly baseUrl: string;
  private readonly log: (event: BingLogEvent) => void;

  constructor(options: BingClientOptions) {
    this.getToken = options.getToken;
    this.fetchImpl = options.fetchImpl ?? ((...args) => fetch(...args));
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
    this.log = options.log ?? ((event) => console.info(JSON.stringify({ provider: "bing", ...event })));
  }

  async listSites(): Promise<BingSite[]> {
    const data = await this.call("GetUserSites", {});
    // AuthenticationCode / DnsVerificationCode are intentionally dropped.
    return this.asArray(data)
      .map((row) => ({
        url: str(isRecord(row) ? row.Url : null) ?? "",
        isVerified: bool(isRecord(row) ? row.IsVerified : null),
      }))
      .filter((s) => s.url !== "");
  }

  /** dimension "query" -> GetQueryStats, "page" -> GetPageStats. */
  async searchStats(siteUrl: string, dimension: "query" | "page"): Promise<BingQueryStatsRow[]> {
    parseSiteUrl(siteUrl);
    const method = dimension === "query" ? "GetQueryStats" : "GetPageStats";
    const data = await this.call(method, { siteUrl: siteUrl.trim() });
    return this.asArray(data).map((row) => {
      const r = isRecord(row) ? row : {};
      return {
        key: str(r.Query),
        date: parseBingDate(r.Date),
        impressions: num(r.Impressions),
        clicks: num(r.Clicks),
        avgClickPosition: num(r.AvgClickPosition),
        avgImpressionPosition: num(r.AvgImpressionPosition),
      };
    });
  }

  async urlInfo(siteUrl: string, url: string): Promise<BingUrlInfo> {
    assertUrlBelongsToSite(siteUrl, url);
    // Microsoft's JSON samples send the url parameter as a JSON string literal.
    const data = await this.call("GetUrlInfo", {
      siteUrl: siteUrl.trim(),
      url: JSON.stringify(url.trim()),
    });
    if (!isRecord(data)) throw new BingWebmasterError("upstream");
    return {
      url: str(data.Url),
      isPage: bool(data.IsPage),
      httpStatus: num(data.HttpStatus),
      documentSizeBytes: num(data.DocumentSize),
      anchorCount: num(data.AnchorCount),
      totalChildUrlCount: num(data.TotalChildUrlCount),
      discoveryDate: parseBingDate(data.DiscoveryDate),
      lastCrawledDate: parseBingDate(data.LastCrawledDate),
    };
  }

  private asArray(data: unknown): unknown[] {
    if (!Array.isArray(data)) throw new BingWebmasterError("upstream");
    return data.slice(0, MAX_PROVIDER_ROWS);
  }

  private async call(method: string, params: Record<string, string>): Promise<unknown> {
    const token = (await this.getToken())?.trim();
    if (!token) throw new BingWebmasterError("missing_configuration");

    const url = new URL(`${this.baseUrl}/${method}`);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    url.searchParams.set("apikey", token);

    const started = Date.now();
    const logEvent = (statusClass: string) =>
      this.log({ operation: method, latencyMs: Date.now() - started, statusClass });

    let response: Response;
    try {
      response = await this.fetchImpl(url.toString(), {
        method: "GET",
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      const timedOut = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
      logEvent(timedOut ? "timeout" : "network");
      throw new BingWebmasterError(timedOut ? "timeout" : "network");
    }

    logEvent(`${Math.floor(response.status / 100)}xx`);

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new BingWebmasterError(response.ok ? "upstream" : classify(response.status, undefined));
    }

    if (!response.ok) throw new BingWebmasterError(classify(response.status, body));
    if (!isRecord(body) || !("d" in body)) throw new BingWebmasterError("upstream");
    return body.d;
  }
}
