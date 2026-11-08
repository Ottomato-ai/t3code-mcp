// Build provenance and deployment verification (defect 5: deployed dist drifted from source).
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, readFileSync, rmSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { sourceHash } from "../scripts/source-hash.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const dist = join(root, "dist");

function verify(args) {
  try {
    const out = execFileSync(process.execPath, [join(root, "scripts", "verify-deploy.mjs"), ...args, "--json"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return { code: 0, report: JSON.parse(out) };
  } catch (e) {
    return { code: e.status, report: JSON.parse(e.stdout) };
  }
}

function copyDist(t) {
  const dir = mkdtempSync(join(tmpdir(), "t3code-mcp-deployed-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  cpSync(dist, dir, { recursive: true });
  return dir;
}

test("dist/build-info.json names the exact source it was built from", () => {
  const info = JSON.parse(readFileSync(join(dist, "build-info.json"), "utf8"));
  assert.equal(info.name, "t3code-mcp");
  assert.equal(info.version, JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version);
  assert.equal(info.sourceHash, sourceHash(root));
});

test("verify-deploy: this checkout's own dist matches file for file, with no hardcoded timeouts", () => {
  const { report } = verify(["--dist", dist]);
  assert.deepEqual(report.files.missing, []);
  assert.deepEqual(report.files.extra, []);
  assert.deepEqual(report.files.different, []);
  assert.deepEqual(report.hardcodedTimeouts, []);
  assert.equal(report.buildInfo.sourceHash, report.checkoutSourceHash);
});

test("verify-deploy: a dist with a hardcoded 30 s timeout and no build info is reported as drift", (t) => {
  const dir = copyDist(t);
  const client = join(dir, "client.js");
  const original = readFileSync(client, "utf8");
  const tampered = original.replace(/AbortSignal\.timeout\(timeoutMs\)/, "AbortSignal.timeout(30_000)");
  assert.notEqual(tampered, original, "the fixture must actually change the client");
  writeFileSync(client, tampered);
  rmSync(join(dir, "build-info.json"));
  const { code, report } = verify(["--dist", dir]);
  assert.equal(code, 1);
  assert.deepEqual(report.files.different, ["client.js"]);
  assert.ok(report.hardcodedTimeouts.includes("AbortSignal.timeout(30_000)"));
  assert.ok(report.problems.some((p) => /no build-info\.json/.test(p)));
});

test("verify-deploy: shows the timeouts a launch environment gives, and flags variables the dist ignores", (t) => {
  const dir = copyDist(t);
  const env = join(dir, "launch.env");
  writeFileSync(env, "T3_HTTP_TIMEOUT_MS=120000\nT3_PROBE_TIMEOUT_MS=15000\nexport T3_RPC_TIMEOUT_MS=30000\nT3_MCP_HTTP_TIMEOUT=5\n");
  const { report } = verify(["--dist", dir, "--env-file", env]);
  assert.deepEqual(report.effectiveTimeouts, { httpMs: 120000, probeMs: 15000, rpcMs: 30000 });
  assert.ok(report.problems.some((p) => /ignores: T3_MCP_HTTP_TIMEOUT/.test(p)));
});
