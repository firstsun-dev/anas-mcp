import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const stripComments = (s: string) => s.replace(/^\s*\/\/.*$/gm, "");
const sourceFiles = (dir: string): string[] =>
  readdirSync(new URL(`../${dir}`, import.meta.url), { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? sourceFiles(`${dir}/${e.name}`) : [`${dir}/${e.name}`],
  );
const allSource = () => sourceFiles("src").map(read).join("\n");

describe("repository guardrails", () => {
  it("the Worker never calls Bing: no Bing host, apikey, or outbound fetch in src/", () => {
    const code = stripComments(allSource());
    expect(code).not.toMatch(/ssl\.bing\.com|api\.svc|webmaster\/api|apikey|BING_WEBMASTER_TOKEN|ThrottleIP/i);
    expect(code).not.toMatch(/(await\s+|=\s*|return\s+)fetch\(|globalThis\.fetch/);
  });
  it("no direct Bing client module remains", () => {
    expect(sourceFiles("src")).not.toContain("src/services/bing-webmaster.ts");
  });
  it("source contains no SOAP/POX endpoints or Bing write methods", () => {
    const code = stripComments(allSource());
    expect(code).not.toMatch(/\/soap|\/pox|\?wsdl/i);
    expect(code).not.toMatch(/SubmitUrl|SubmitSitemap|AddSite|RemoveSite|VerifySite|RemoveSitemap|GetUrlInfo/);
  });
  it("only fixed read-only statements are used against PostgreSQL (no writes, no generic SQL entry point)", () => {
    const service = stripComments(read("src/services/bing-analytics.ts"));
    expect(service).not.toMatch(/\b(INSERT|UPDATE|DELETE|DROP|ALTER|TRUNCATE|CREATE|GRANT)\b\s/i);
    expect(service).toMatch(/READ ONLY/);
    expect(service).not.toMatch(/export\s+(async\s+)?function\s+(executeSql|rawQuery)/);
  });
  it("wrangler.jsonc has no Bing Secrets Store binding and uses the ANALYTICS_DB Hyperdrive binding", () => {
    const config = JSON.parse(stripComments(read("wrangler.jsonc"))) as Record<string, any>;
    expect(config.secrets_store_secrets).toBeUndefined();
    expect(config.vars).toBeUndefined();
    expect(config.hyperdrive).toEqual([expect.objectContaining({ binding: "ANALYTICS_DB" })]);
    expect(JSON.stringify(config)).not.toMatch(/bing|apikey|postgres(ql)?:\/\//i);
  });
  it("no database URL or credential is committed in config or source", () => {
    expect(stripComments(read("wrangler.jsonc")) + stripComments(allSource())).not.toMatch(/postgres(ql)?:\/\/[^\s"']*@/i);
  });
});
