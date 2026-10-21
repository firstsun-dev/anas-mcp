import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// Deterministic tests for scripts/smoke-prod.sh. A mock `curl` replaces the network: it serves a scripted sequence of
// outcomes per URL path, records every call, and mimics curl's `-w '%{http_code}'` / `-o` / exit-status behaviour
// (including printing 000 on transport failure). No real network, credentials, or sleeping.

const SCRIPT = new URL("../scripts/smoke-prod.sh", import.meta.url).pathname;
const hasTools = ["bash", "jq"].every((t) => spawnSync("sh", ["-c", `command -v ${t}`]).status === 0);

const ISSUER = "https://team.example.test";
const BASE = "https://mcp.example.test";
const HEALTH = JSON.stringify({ service: "anas-mcp", status: "ok" });
const PRM = JSON.stringify({ resource: `${BASE}/anas/mcp`, authorization_servers: [ISSUER] });
const AS = JSON.stringify({ issuer: ISSUER, authorization_endpoint: `${ISSUER}/a`, token_endpoint: `${ISSUER}/t` });
const NOT_FOUND = JSON.stringify({ error: "not_found" });
const UNAUTH = JSON.stringify({ error: "invalid_token" });

type Step = { exit?: number; status: string; body?: string };
type Plan = Record<string, Step[]>;
const ok = (status: string, body = ""): Step => ({ status, body });
const transport = (exit: number): Step => ({ exit, status: "000" }); // curl prints 000 *and* exits non-zero

const healthy = (): Plan => ({
  "mcp.example.test/health": [ok("200", HEALTH)],
  "mcp.example.test/anas/mcp": [ok("401", UNAUTH)],
  "mcp.example.test/mcp": [ok("404", NOT_FOUND)],
  "mcp.example.test/anas": [ok("404", NOT_FOUND)],
  "mcp.example.test/anas/mcp/": [ok("404", NOT_FOUND)],
  "mcp.example.test/anas/mcp2": [ok("404", NOT_FOUND)],
  "mcp.example.test/anas2/mcp": [ok("404", NOT_FOUND)],
  "mcp.example.test/infra/mcp": [ok("404", NOT_FOUND)],
  "mcp.example.test/.well-known/cloudflare-access-protected-resource/anas/mcp": [ok("200", PRM)],
  "team.example.test/.well-known/oauth-authorization-server": [ok("200", AS)],
});

const MOCK = `#!/usr/bin/env bash
out=""; url=""; hdr=""; args=("$@")
for ((i = 0; i < \${#args[@]}; i++)); do
  case "\${args[$i]}" in -o) out="\${args[$((i + 1))]}";; -D) hdr="\${args[$((i + 1))]}";; https://*) url="\${args[$i]}";; esac
done
key="\${url#https://}"; id="$(printf '%s' "$key" | tr -c 'A-Za-z0-9' _)"
echo "$key" >> "$MOCK_DIR/calls.log"
n=0; [[ -f "$MOCK_DIR/$id.n" ]] && n="$(cat "$MOCK_DIR/$id.n")"
total="$(wc -l < "$MOCK_DIR/$id.seq")"; idx=$((n < total ? n : total - 1)); echo $((n + 1)) > "$MOCK_DIR/$id.n"
line="$(sed -n "$((idx + 1))p" "$MOCK_DIR/$id.seq")"
rc="\${line%%|*}"; rest="\${line#*|}"; status="\${rest%%|*}"; body="\${rest#*|}"
[[ -n "$out" ]] && printf '%s' "$body" > "$out"
# Access challenge: the canonical endpoint advertises its protected-resource metadata URL (unless a test removes it).
if [[ -n "$hdr" && "$hdr" != /dev/null && "$status" == "401" && "$key" == */anas/mcp && ! -f "$MOCK_DIR/no_challenge" ]]; then
  printf 'HTTP/2 401\r\nwww-authenticate: Bearer resource_metadata="https://mcp.example.test/.well-known/cloudflare-access-protected-resource/anas/mcp"\r\n\r\n' > "$hdr"
fi
printf '%s' "$status"
exit "$rc"
`;

describe.skipIf(!hasTools)("scripts/smoke-prod.sh (mock curl)", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "smoke-"));
    writeFileSync(join(dir, "curl"), MOCK);
    chmodSync(join(dir, "curl"), 0o755);
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  function run(plan: Plan, attempts = 3) {
    for (const [key, steps] of Object.entries(plan)) {
      const id = key.replace(/[^A-Za-z0-9]/g, "_");
      writeFileSync(join(dir, `${id}.seq`), steps.map((s) => `${s.exit ?? 0}|${s.status}|${s.body ?? ""}`).join("\n") + "\n");
    }
    const r = spawnSync("bash", [SCRIPT], {
      encoding: "utf8",
      env: {
        PATH: `${dir}:${process.env.PATH}`,
        MOCK_DIR: dir,
        BASE_URL: BASE,
        EXPECTED_ISSUER: ISSUER,
        SMOKE_ATTEMPTS: String(attempts),
        SMOKE_DELAY_SECONDS: "0",
      },
    });
    const log = existsSync(join(dir, "calls.log")) ? readFileSync(join(dir, "calls.log"), "utf8").trim().split("\n") : [];
    const calls = (path: string) => log.filter((l) => l === path).length;
    return { ...r, calls };
  }

  it("passes on healthy responses with exactly one request per check", () => {
    const r = run(healthy());
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("All smoke checks passed.");
    for (const p of Object.keys(healthy())) expect(r.calls(p)).toBe(1);
  });

  it.each([
    ["DNS failure (curl exit 6)", 6],
    ["connection refused (curl exit 7)", 7],
    ["timeout (curl exit 28)", 28],
  ])("retries a transport error then succeeds: %s", (_n, code) => {
    const plan = healthy();
    plan["mcp.example.test/health"] = [transport(code), ok("200", HEALTH)];
    const r = run(plan);
    expect(r.status).toBe(0);
    expect(r.calls("mcp.example.test/health")).toBe(2);
  });

  it.each([
    ["DNS failure", 6],
    ["connection refused", 7],
  ])("persistent %s fails after exactly ATTEMPTS requests with a clean 000 status (not 000000)", (_n, code) => {
    const plan = healthy();
    plan["mcp.example.test/health"] = [transport(code)];
    const r = run(plan, 3);
    expect(r.status).toBe(1);
    expect(r.calls("mcp.example.test/health")).toBe(3);
    expect(r.stdout + r.stderr).toContain("got HTTP 000");
    expect(r.stdout + r.stderr).not.toContain("000000");
    expect(r.stdout + r.stderr).toContain("OPERATOR INTERVENTION REQUIRED");
  });

  it("retries 502 and then accepts 200", () => {
    const plan = healthy();
    plan["mcp.example.test/health"] = [ok("502"), ok("200", HEALTH)];
    const r = run(plan);
    expect(r.status).toBe(0);
    expect(r.calls("mcp.example.test/health")).toBe(2);
  });

  it("persistent 503 fails after exactly ATTEMPTS requests", () => {
    const plan = healthy();
    plan["mcp.example.test/health"] = [ok("503")];
    const r = run(plan, 4);
    expect(r.status).toBe(1);
    expect(r.calls("mcp.example.test/health")).toBe(4);
    expect(r.stdout + r.stderr).toContain("got HTTP 503");
  });

  it("does not retry definitive 4xx answers (401 on /anas/mcp is the expected pass; 404 on health fails fast)", () => {
    const plan = healthy();
    plan["mcp.example.test/health"] = [ok("404")];
    const r = run(plan);
    expect(r.status).toBe(1);
    expect(r.calls("mcp.example.test/health")).toBe(1);
    expect(r.calls("mcp.example.test/anas/mcp")).toBe(1);
  });

  it("fails when unauthenticated /anas/mcp is accepted (200) or leaks tools", () => {
    for (const step of [ok("200", JSON.stringify({ result: { tools: [] } })), ok("401", '{"tools":[]}')]) {
      const plan = healthy();
      plan["mcp.example.test/anas/mcp"] = [step];
      expect(run(plan).status).toBe(1);
      rmSync(join(dir, "calls.log"), { force: true });
    }
  });

  it("fails when the authorization server or issuer does not match the configured Access issuer", () => {
    const wrongPrm = healthy();
    wrongPrm["mcp.example.test/.well-known/cloudflare-access-protected-resource/anas/mcp"] = [
      ok("200", JSON.stringify({ resource: `${BASE}/anas/mcp`, authorization_servers: ["https://evil.example.test"] })),
    ];
    expect(run(wrongPrm).status).toBe(1);
    rmSync(join(dir, "calls.log"), { force: true });
    const wrongAs = healthy();
    wrongAs["team.example.test/.well-known/oauth-authorization-server"] = [ok("200", JSON.stringify({ ...JSON.parse(AS), issuer: "https://evil.example.test" }))];
    expect(run(wrongAs).status).toBe(1);
  });

  it("fails when the 401 challenge advertises no protected-resource metadata (no hardcoded fallback)", () => {
    writeFileSync(join(dir, "no_challenge"), "");
    const r = run(healthy());
    expect(r.status).toBe(1);
    expect(r.calls("mcp.example.test/.well-known/cloudflare-access-protected-resource/anas/mcp")).toBe(0);
  });

  it.each(["mcp", "anas", "anas/mcp/", "anas/mcp2", "anas2/mcp", "infra/mcp"])("fails when /%s still serves MCP (2xx or tools) and passes on 401/403/404", (path) => {
    for (const step of [ok("200", JSON.stringify({ result: { tools: [] } })), ok("404", '{"tools":[]}'), ok("302")]) {
      const plan = healthy();
      plan[`mcp.example.test/${path}`] = [step];
      expect(run(plan).status, `${path} ${step.status}`).toBe(1);
      rmSync(join(dir, "calls.log"), { force: true });
    }
    for (const status of ["401", "403", "404"]) {
      const plan = healthy();
      plan[`mcp.example.test/${path}`] = [ok(status, NOT_FOUND)];
      expect(run(plan).status, `${path} ${status}`).toBe(0);
      rmSync(join(dir, "calls.log"), { force: true });
    }
  });
});
