import { existsSync, readdirSync, readFileSync } from "node:fs";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";

const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const stripComments = (s: string) => s.replace(/^\s*\/\/.*$/gm, "");
const sourceFiles = (dir: string): string[] =>
  readdirSync(new URL(`../${dir}`, import.meta.url), { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? sourceFiles(`${dir}/${e.name}`) : [`${dir}/${e.name}`],
  );
/** The only modules allowed to make outbound calls: fixed Google endpoints (token + Analytics Data API). */
const GOOGLE_MODULES = ["src/auth/google-oauth.ts", "src/services/google-analytics.ts"];
const allSource = () => sourceFiles("src").map(read).join("\n");
const nonGoogleSource = () => sourceFiles("src").filter((f) => !GOOGLE_MODULES.includes(f)).map(read).join("\n");

describe("repository guardrails", () => {
  it("the Worker never calls Bing: no Bing host, apikey, or outbound fetch in src/", () => {
    const code = stripComments(allSource());
    expect(code).not.toMatch(/ssl\.bing\.com|api\.svc|webmaster\/api|apikey|BING_WEBMASTER_TOKEN|ThrottleIP/i);
    // Outbound fetch is confined to the two Google modules; everything else stays fetch-free.
    expect(stripComments(nonGoogleSource())).not.toMatch(/(await\s+|=\s*|return\s+)fetch\(|globalThis\.fetch/);
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
    for (const file of ["src/services/bing-analytics.ts", "src/services/clarity-analytics.ts", "src/services/sql-session.ts"]) {
      const service = stripComments(read(file));
      expect(service, file).not.toMatch(/\b(INSERT|UPDATE|DELETE|DROP|ALTER|TRUNCATE|CREATE|GRANT)\b\s/i);
      expect(service, file).not.toMatch(/export\s+(async\s+)?function\s+(executeSql|rawQuery)/);
    }
    // The shared runner is the single place sessions are opened, and it is always read-only.
    expect(stripComments(read("src/services/sql-session.ts"))).toMatch(/READ ONLY/);
    expect(stripComments(read("src/services/clarity-analytics.ts"))).not.toMatch(/from "pg"/);
  });
  it("the Worker never calls Microsoft Clarity and never reads the stored raw payload", () => {
    const code = stripComments(allSource());
    expect(code).not.toMatch(/clarity\.ms|project-live-insights|clarity_api_token/i);
    expect(code).not.toMatch(/raw_payload/);
  });
  it("wrangler.jsonc has only non-secret Access/Clarity/GA4 vars, only the Google credential Secrets Store binding, and the ANALYTICS_DB Hyperdrive binding", () => {
    const config = JSON.parse(stripComments(read("wrangler.jsonc"))) as Record<string, any>;
    expect(config.secrets_store_secrets).toEqual([
      { binding: "GOOGLE_OAUTH_CREDENTIALS", store_id: expect.stringMatching(/^[0-9a-f]{32}$/), secret_name: "ANAS_PROD_GOOGLE_OAUTH_CREDENTIALS" },
    ]);
    expect(Object.keys(config.vars ?? {}).sort()).toEqual(["ACCESS_AUD", "ACCESS_TEAM_DOMAIN", "CLARITY_PROJECT_KEYS", "GA4_PROPERTY_IDS"]);
    expect(config.hyperdrive).toEqual([expect.objectContaining({ binding: "ANALYTICS_DB" })]);
    expect(JSON.stringify(config)).not.toMatch(/bing|apikey|postgres(ql)?:\/\//i);
  });
  it("outbound hosts are fixed Google endpoints only, confined to the Google modules", () => {
    const hosts = (file: string) => [...stripComments(read(file)).matchAll(/https?:\/\/[^\s"'`/]+/g)].map((m) => m[0]);
    expect(new Set(hosts("src/auth/google-oauth.ts"))).toEqual(new Set(["https://oauth2.googleapis.com", "https://www.googleapis.com"]));
    expect(new Set(hosts("src/services/google-analytics.ts"))).toEqual(new Set(["https://analyticsdata.googleapis.com"]));
    // Only read-only Google scopes are ever referenced.
    const scopes = [...stripComments(allSource()).matchAll(/googleapis\.com\/(auth\/[a-z.]+)/g)].map((m) => m[1]);
    expect(new Set(scopes)).toEqual(new Set(["auth/analytics.readonly", "auth/webmasters.readonly"]));
    expect(stripComments(allSource())).not.toMatch(/GOOGLE_TOKEN_URL|token_uri|tokenEndpoint\s*[:=]\s*input/);
  });
  it("the Google credential binding is read only inside the shared Google token provider", () => {
    for (const f of sourceFiles("src").filter((f) => f !== "src/auth/google-oauth.ts" && f !== "src/index.ts" && f !== "src/server.ts")) {
      expect(stripComments(read(f)), f).not.toMatch(/GOOGLE_OAUTH_CREDENTIALS|\.secret\.get\(|SecretsStoreSecret/);
    }
  });
  it("workers.dev and Version/Preview URLs are disabled so Access on the custom domain cannot be bypassed", () => {
    // workers.dev and Version/Preview URLs are a separate ingress that does not go through the Access
    // application attached to the custom domain. If either were left enabled (or omitted, since `workers_dev`
    // defaults to `true` when no `routes`/`route` field is configured here), `/mcp` would be reachable without
    // a Cloudflare Access assertion. See wrangler.jsonc and docs/cloudflare-access.md.
    const config = JSON.parse(stripComments(read("wrangler.jsonc"))) as Record<string, any>;
    expect(config.workers_dev).toBe(false);
    expect(config.preview_urls).toBe(false);
  });
  it("never configures wildcard Host or Origin acceptance for the MCP handler", () => {
    const code = stripComments(read("src/index.ts"));
    expect(code).toMatch(/allowedOriginHostnames:\s*\[\]/);
    expect(code).toMatch(/allowedHostnames:\s*MCP_ALLOWED_HOSTNAMES/);
    expect(code).not.toMatch(/allowed(Origin)?Hostnames:\s*"\*"/);
    expect(code).not.toMatch(/MCP_PUBLIC_HOSTNAME\s*=\s*"[^"]*\*/);
  });
  it("the PR verification workflow cannot deploy: pull_request only, read-only, no secrets, dry-run wrangler, hosted runner", () => {
    const wf = read(".github/workflows/pr-verify.yml");
    const code = wf.replace(/^\s*#.*$/gm, "");
    expect(code).toMatch(/^on:\s*\n\s+pull_request:\s*$/m);
    expect(code).not.toMatch(/^\s+(push|workflow_dispatch|schedule|pull_request_target|workflow_run):/m);
    expect(code).toMatch(/permissions:\s*\n\s+contents: read\s*\n/);
    expect(code).not.toMatch(/\bsecrets\b|CLOUDFLARE_|id-token|contents: write|uses:\s*firstsun-dev\//);
    expect(code).not.toMatch(/wrangler (deploy(?! --dry-run)|versions|rollback|secret)/);
    expect(code).toMatch(/pnpm install --frozen-lockfile/);
    expect(code).toMatch(/pnpm run check/);
    expect(code).toMatch(/pnpm exec wrangler deploy --dry-run/);
    expect(code).not.toMatch(/\bnpm\b|\bnpx\b/);
    expect(code).toMatch(/runs-on:\s*ubuntu-latest/);
  });
  describe("production CI/CD caller", () => {
    const raw = read(".github/workflows/cicd.yml");
    const code = raw.replace(/^\s*#.*$/gm, "");
    const wf = parse(raw) as Record<string, any>;
    // Inputs published by _cf-worker-template.yml@v1.5.0 (verified against the tag); an unknown input fails the caller.
    const TEMPLATE_INPUTS = new Set([
      "app_name", "app_path", "app_version", "build_cmd", "migrate_cmd_prod", "migrate_cmd_dev", "test_unit_cmd",
      "test_integration_cmd", "test_e2e_setup_cmd", "test_e2e_cmd", "test_e2e_variants", "verify_cmd", "app_url_prod",
      "app_url_dev", "runner", "use_mailpit", "vite_env_prod", "vite_env_dev", "test_e2e_env", "verify_env",
      "enable_preview_alias", "worker_name_dev",
    ]);

    it("triggers on push to main only (no PR, dispatch, schedule, or other branches)", () => {
      expect(wf.on).toEqual({ push: { branches: ["main"] } });
    });
    it("delegates to the reusable workflow pinned to an immutable-style release ref, with only supported inputs", () => {
      const pipeline = wf.jobs.pipeline;
      expect(pipeline.uses).toMatch(
        /^firstsun-dev\/\.github\/\.github\/workflows\/_cf-worker-template\.yml@(v\d+\.\d+\.\d+|[0-9a-f]{40})$/,
      );
      expect(pipeline.uses).not.toMatch(/@(main|master|v\d+)$/);
      for (const key of Object.keys(pipeline.with)) expect(TEMPLATE_INPUTS.has(key), key).toBe(true);
      expect(pipeline.with).toMatchObject({
        app_name: "anas-mcp",
        app_path: ".",
        test_unit_cmd: "pnpm run check",
        build_cmd: "pnpm exec wrangler deploy --dry-run",
        app_url_prod: "https://mcp.firstsun.org",
      });
      expect(pipeline.with.app_version).toBe("${{ github.sha }}");
    });
    it("does not enable dev/preview deploys or the rollback-capable verify path", () => {
      const keys = Object.keys(wf.jobs.pipeline.with);
      for (const k of ["verify_cmd", "app_url_dev", "worker_name_dev", "enable_preview_alias", "migrate_cmd_prod", "migrate_cmd_dev"])
        expect(keys).not.toContain(k);
    });
    it("serializes production deploys without cancelling an in-flight one", () => {
      expect(wf.concurrency).toEqual({ group: "anas-mcp-production-deploy", "cancel-in-progress": false });
    });
    it("duplicates no deployment logic: no wrangler upload/deploy/rollback/secret commands in the caller or smoke script", () => {
      const smoke = read("scripts/smoke-prod.sh").replace(/^\s*#.*$/gm, "");
      for (const text of [code, smoke]) {
        expect(text).not.toMatch(/wrangler (deploy(?! --dry-run)|versions|rollback|secret|publish)/);
        expect(text).not.toMatch(/CLOUDFLARE_API_TOKEN|CLOUDFLARE_ACCOUNT_ID|--var\b|--env\b/);
      }
      expect(Object.keys(wf.jobs).sort()).toEqual(["pipeline", "smoke"]);
    });
    it("smoke job is credential-free, GitHub-hosted, read-only, and never reverts", () => {
      const smoke = wf.jobs.smoke;
      expect(smoke.needs).toBe("pipeline");
      expect(smoke["runs-on"]).toBe("ubuntu-latest");
      expect(smoke.permissions).toEqual({ contents: "read" });
      expect(JSON.stringify(smoke)).not.toMatch(/secrets\./);
      const script = read("scripts/smoke-prod.sh").replace(/^\s*#.*$/gm, "");
      expect(script).not.toMatch(/-X (PUT|DELETE|PATCH)|-H\s+["']?authorization|cf-access-client|wrangler|versions deploy/i);
    });
    it("smoke targets match the Worker's configured hostname and Access issuer (no drift)", () => {
      const env = wf.jobs.smoke.steps.find((s: any) => s.env).env;
      const vars = (JSON.parse(stripComments(read("wrangler.jsonc"))) as any).vars;
      expect(env.EXPECTED_ISSUER).toBe(`https://${vars.ACCESS_TEAM_DOMAIN}`);
      expect(env.BASE_URL).toBe("https://mcp.firstsun.org");
      expect(read("src/index.ts")).toContain('MCP_PUBLIC_HOSTNAME = "mcp.firstsun.org"');
    });
    it("the shared template's --var COMMIT_HASH/VERSION cannot collide with configured vars", () => {
      const vars = (JSON.parse(stripComments(read("wrangler.jsonc"))) as any).vars;
      expect(Object.keys(vars)).not.toContain("COMMIT_HASH");
      expect(Object.keys(vars)).not.toContain("VERSION");
    });
  });
  it("uses pnpm: pinned packageManager, committed pnpm lockfile, no npm lockfile", () => {
    const pkg = JSON.parse(read("package.json")) as Record<string, any>;
    expect(pkg.packageManager).toMatch(/^pnpm@\d+\.\d+\.\d+$/);
    expect(pkg.scripts.check).not.toMatch(/\bnpm\b/);
    expect(existsSync(new URL("../pnpm-lock.yaml", import.meta.url))).toBe(true);
    expect(existsSync(new URL("../package-lock.json", import.meta.url))).toBe(false);
  });
  it("the transitional Worker-local API key is fully removed (Access JWT is the only production gate)", () => {
    expect(sourceFiles("src")).not.toContain("src/auth/mcp-api-key.ts");
    const code = stripComments(allSource() + read("wrangler.jsonc"));
    expect(code).not.toMatch(/ANAS_MCP_API_KEY|ANAS_PROD_MCP_API_KEY/);
    // The only approved Secrets Store consumer is the Google credential binding (not an MCP auth mechanism).
    expect(stripComments(read("wrangler.jsonc")).match(/secret_name/g)).toHaveLength(1);
    expect(code).not.toMatch(/headers\.get\(["']authorization["']\)/i);
  });
  it("no database URL or credential is committed in config or source", () => {
    expect(stripComments(read("wrangler.jsonc")) + stripComments(allSource())).not.toMatch(/postgres(ql)?:\/\/[^\s"']*@/i);
  });
});
