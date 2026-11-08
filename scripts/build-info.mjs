// Writes dist/build-info.json after `tsc`: what source this dist was built from. t3_status
// reports it and scripts/verify-deploy.mjs checks a deployed dist against a checkout with it.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { sourceHash } from "./source-hash.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

function git(args) {
  try {
    return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
}

const status = git(["status", "--porcelain", "--", "src", "tsconfig.json", "package.json", "pnpm-lock.yaml"]);
const info = {
  name: pkg.name,
  version: pkg.version,
  gitSha: git(["rev-parse", "HEAD"]),
  gitDirty: status === null ? null : status.length > 0,
  sourceHash: sourceHash(root),
  builtAt: new Date().toISOString(),
  node: process.version,
};
if (!existsSync(join(root, "dist"))) throw new Error("dist/ is missing: run tsc first");
writeFileSync(join(root, "dist", "build-info.json"), `${JSON.stringify(info, null, 2)}\n`);
console.error(`build-info: ${info.name} ${info.version} ${info.gitSha ?? "(no git)"}${info.gitDirty ? " (dirty)" : ""} source ${info.sourceHash.slice(0, 12)}`);
