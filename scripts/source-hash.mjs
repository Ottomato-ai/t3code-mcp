// SHA-256 over everything that decides what `tsc` emits: every file under src/ (sorted, with
// its path), tsconfig.json, package.json and pnpm-lock.yaml. Line endings are normalised so a
// Windows checkout hashes like a Linux one.
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, relative, sep } from "node:path";

function walk(dir) {
  return readdirSync(dir)
    .flatMap((name) => {
      const p = join(dir, name);
      return statSync(p).isDirectory() ? walk(p) : [p];
    })
    .sort();
}

export function sourceHash(root) {
  const h = createHash("sha256");
  const files = [...walk(join(root, "src")), ...["tsconfig.json", "package.json", "pnpm-lock.yaml"].map((f) => join(root, f)).filter(existsSync)];
  for (const file of files) {
    const rel = relative(root, file).split(sep).join("/");
    h.update(`${rel}\n`);
    h.update(readFileSync(file, "utf8").replace(/\r\n/g, "\n"));
    h.update("\n\0\n");
  }
  return h.digest("hex");
}
