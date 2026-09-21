import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

describe("repository guardrails", () => {
  it("provider sources do not reference SOAP/POX endpoints", () => {
    for (const f of ["src/services/bing-webmaster.ts", "src/tools/bing-webmaster.ts"]) {
      const code = read(f).split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");
      expect(code).not.toMatch(/\/soap|\/pox|\?wsdl/i);
    }
  });
  it("provider sources contain no write-oriented Bing methods", () => {
    const code = read("src/services/bing-webmaster.ts") + read("src/tools/bing-webmaster.ts");
    expect(code).not.toMatch(/SubmitUrl|SubmitSitemap|AddSite|RemoveSite|VerifySite|RemoveSitemap|method:\s*"(POST|PUT|DELETE|PATCH)"/);
  });
  it("wrangler.jsonc keeps the Bing token in Secrets Store, not vars", () => {
    const w = read("wrangler.jsonc");
    expect(w).toContain("secrets_store_secrets");
    expect(w).not.toMatch(/"vars"/);
  });
});
