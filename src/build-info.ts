import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export interface BuildInfo {
  name: string;
  version: string;
  gitSha: string | null;
  gitDirty: boolean | null;
  sourceHash: string;
  builtAt: string;
  node: string;
}

let cached: BuildInfo | null | undefined;

/** dist/build-info.json written by scripts/build-info.mjs; null when the dist was built without it. */
export function readBuildInfo(): BuildInfo | null {
  if (cached !== undefined) return cached;
  try {
    const path = join(dirname(fileURLToPath(import.meta.url)), "build-info.json");
    cached = JSON.parse(readFileSync(path, "utf8")) as BuildInfo;
  } catch {
    cached = null;
  }
  return cached;
}

/** Package version: from the build info, else package.json next to dist/. */
export function connectorVersion(): string {
  const info = readBuildInfo();
  if (info?.version) return info.version;
  try {
    const pkg = join(dirname(dirname(fileURLToPath(import.meta.url))), "package.json");
    return (JSON.parse(readFileSync(pkg, "utf8")) as { version?: string }).version ?? "unknown";
  } catch {
    return "unknown";
  }
}
