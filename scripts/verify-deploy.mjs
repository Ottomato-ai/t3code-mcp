#!/usr/bin/env node
// Check a deployed t3code-mcp dist against this checkout, read-only:
//   node scripts/verify-deploy.mjs --dist <deployed dist dir> [--env-file <launch env file>] [--json]
//
// 1. Builds this checkout with its own TypeScript into a temporary folder and compares every
//    emitted .js file with the deployed dist, byte for byte (missing, extra, different).
// 2. Compares the deployed dist/build-info.json (source hash, git sha) with this checkout.
// 3. Scans the deployed client for hardcoded timeouts (the drift found on 2026-11-07: a dist
//    with fixed 30 s timeouts while the source read them from the environment).
// 4. Shows the timeouts the deployed dist would use with the given launch environment, read by
//    the deployed dist's own config module (so an unknown variable name shows up as a default).
// Exit 0 when the deployed dist is exactly this checkout's build, 1 on any drift, 2 on usage errors.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { sourceHash } from "./source-hash.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const distArg = opt("--dist");
if (!distArg) {
  console.error("usage: node scripts/verify-deploy.mjs --dist <deployed dist dir> [--env-file <file>] [--json]");
  process.exit(2);
}
const deployed = resolve(distArg);
if (!existsSync(deployed)) {
  console.error(`no such folder: ${deployed}`);
  process.exit(2);
}

function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

/** Every emitted .js file under dir, as sorted forward-slash paths relative to dir. */
function files(dir) {
  return walk(dir)
    .filter((p) => p.endsWith(".js"))
    .map((p) => relative(dir, p).split(sep).join("/"))
    .sort();
}

const problems = [];
const report = { deployed, checkout: root };

// 1. Fresh build of this checkout.
const fresh = mkdtempSync(join(tmpdir(), "t3code-mcp-verify-"));
try {
  const tsc = join(root, "node_modules", "typescript", "bin", "tsc");
  if (!existsSync(tsc)) throw new Error("node_modules/typescript is missing: run pnpm install in the checkout");
  try {
    execFileSync(process.execPath, [tsc, "-p", join(root, "tsconfig.json"), "--outDir", fresh], { stdio: ["ignore", "pipe", "pipe"] });
  } catch (e) {
    throw new Error(`building the checkout failed:\n${e.stdout ?? ""}${e.stderr ?? ""}`);
  }
  const want = files(fresh);
  const have = files(deployed);
  const missing = want.filter((f) => !have.includes(f));
  const extra = have.filter((f) => !want.includes(f));
  const different = want.filter((f) => have.includes(f) && !readFileSync(join(fresh, f)).equals(readFileSync(join(deployed, f))));
  report.files = { expected: want.length, deployed: have.length, missing, extra, different };
  if (missing.length) problems.push(`${missing.length} file(s) missing from the deployed dist: ${missing.join(", ")}`);
  if (extra.length) problems.push(`${extra.length} file(s) in the deployed dist that this checkout does not build: ${extra.join(", ")}`);
  if (different.length) problems.push(`${different.length} file(s) differ from this checkout's build: ${different.join(", ")}`);
} finally {
  rmSync(fresh, { recursive: true, force: true });
}

// 2. Build info.
const checkoutHash = sourceHash(root);
let headSha = null;
try {
  headSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
} catch {
  // not a git checkout
}
const infoPath = join(deployed, "build-info.json");
const info = existsSync(infoPath) ? JSON.parse(readFileSync(infoPath, "utf8")) : null;
report.buildInfo = info;
report.checkoutSourceHash = checkoutHash;
report.checkoutGitSha = headSha;
if (!info) problems.push("the deployed dist has no build-info.json (built without scripts/build-info.mjs: its source is unknown)");
else {
  if (info.sourceHash !== checkoutHash) problems.push(`source hash differs: deployed ${info.sourceHash.slice(0, 12)}, checkout ${checkoutHash.slice(0, 12)}`);
  if (info.gitDirty) problems.push("the deployed dist was built from a checkout with uncommitted changes");
  if (headSha && info.gitSha && info.gitSha !== headSha) problems.push(`git sha differs: deployed ${info.gitSha.slice(0, 12)}, checkout ${headSha.slice(0, 12)}`);
}

// 3. Hardcoded timeouts in the deployed client.
const clientPath = join(deployed, "client.js");
if (existsSync(clientPath)) {
  const src = readFileSync(clientPath, "utf8");
  const hardcoded = [...src.matchAll(/AbortSignal\.timeout\(\s*[\d_]+\s*\)|timeoutMs\s*\?\?\s*[\d_]+/g)].map((m) => m[0]);
  report.hardcodedTimeouts = hardcoded;
  if (hardcoded.length) problems.push(`the deployed client has hardcoded timeouts: ${hardcoded.join("; ")}`);
} else problems.push("the deployed dist has no client.js");

// 4. Effective timeouts under the launch environment, read by the deployed config module.
const envFile = opt("--env-file");
const launchEnv = {};
if (envFile) {
  for (const line of readFileSync(envFile, "utf8").split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (m && !line.trimStart().startsWith("#")) launchEnv[m[1]] = m[2].replace(/^(["'])(.*)\1$/, "$2");
  }
}
const configPath = join(deployed, "config.js");
if (existsSync(configPath)) {
  const saved = { ...process.env };
  try {
    Object.assign(process.env, launchEnv);
    const config = await import(pathToFileURL(configPath).href);
    report.effectiveTimeouts = typeof config.loadTimeouts === "function" ? config.loadTimeouts() : "the deployed config has no loadTimeouts (timeouts are not configurable)";
    report.timeoutVariables = config.TIMEOUT_ENV ?? null;
    if (typeof config.loadTimeouts !== "function") problems.push("the deployed dist cannot read timeouts from the environment");
    const unknown = Object.keys(launchEnv).filter((k) => /TIMEOUT/i.test(k) && !Object.values(config.TIMEOUT_ENV ?? {}).includes(k));
    if (unknown.length) problems.push(`launch environment sets timeout variables this dist ignores: ${unknown.join(", ")}`);
  } catch (e) {
    problems.push(`could not load the deployed config (${e.message})`);
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  }
}

report.ok = problems.length === 0;
report.problems = problems;
if (args.includes("--json")) console.log(JSON.stringify(report, null, 2));
else {
  console.log(`deployed dist: ${deployed}`);
  console.log(`checkout:      ${root} (${headSha?.slice(0, 12) ?? "no git"}, source ${checkoutHash.slice(0, 12)})`);
  if (report.effectiveTimeouts) console.log(`timeouts:      ${JSON.stringify(report.effectiveTimeouts)}`);
  console.log(report.ok ? "OK: the deployed dist is this checkout's build." : `DRIFT:\n- ${problems.join("\n- ")}`);
}
process.exit(report.ok ? 0 : 1);
