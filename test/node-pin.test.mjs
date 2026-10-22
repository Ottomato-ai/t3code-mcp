import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// Node.js October 2026 security release: 22.23.4 and 24.22.1 are the first fixed patches.
const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("package accepts only the fixed patch of each supported line", () => {
  assert.equal(JSON.parse(read("package.json")).engines.node, ">=22.23.4 <23 || >=24.22.1 <25 || >=26.12.1");
});

test("CI runs on the fixed 24.x patch", () => {
  const versions = [...read(".github/workflows/ci.yml").matchAll(/node-version:\s*(\S+)/g)].map((m) => m[1]);
  assert.deepEqual(versions, ["24.22.1"]);
});
