import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// GHSA-mrhx-c7xc-m3w5 (zod < 4.6.6) and GHSA-27r3-jxmh-p828 (body-parser 2.x < 2.4.0), both high.
// The MCP SDK parses every JSON-RPC message with "zod/v4", so the copy the SDK resolves matters too.

/** Version of the package `name` as Node resolves `specifier` (default `name`) from the file `fromFile`. */
function resolvedVersion(name, fromFile, specifier = name) {
  let dir = dirname(createRequire(fromFile).resolve(specifier));
  for (;;) {
    const pkg = join(dir, "package.json");
    if (existsSync(pkg)) {
      const json = JSON.parse(readFileSync(pkg, "utf8"));
      if (json.name === name) return { version: json.version, file: pkg };
    }
    const up = dirname(dir);
    assert.notEqual(up, dir, `no package.json for ${name}`);
    dir = up;
  }
}

const atLeast = (version, min) => {
  const a = version.split(/[.-]/).map(Number);
  const b = min.split(".").map(Number);
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return true;
};

const here = fileURLToPath(import.meta.url);
const SDK_ENTRY = "@modelcontextprotocol/sdk/server/mcp.js";

test("zod our code imports is 4.6.6 or later", () => {
  const { version } = resolvedVersion("zod", here);
  assert.ok(atLeast(version, "4.6.6"), `zod ${version} is below 4.6.6`);
});

test("zod the MCP SDK imports is 4.6.6 or later", () => {
  const sdk = resolvedVersion("@modelcontextprotocol/sdk", here, SDK_ENTRY);
  const { version } = resolvedVersion("zod", sdk.file);
  assert.ok(atLeast(version, "4.6.6"), `SDK resolves zod ${version}`);
});

test("body-parser under the SDK's express is 2.4.0 or later", () => {
  const sdk = resolvedVersion("@modelcontextprotocol/sdk", here, SDK_ENTRY);
  const express = resolvedVersion("express", sdk.file);
  const { version } = resolvedVersion("body-parser", express.file);
  assert.ok(atLeast(version, "2.4.0"), `body-parser ${version} is below 2.4.0`);
});

// The fixed behaviour: a size bound rejects an oversized array before its elements are walked,
// so the issue list stays small instead of one issue per bad element.
for (const entry of ["zod", "zod/v4"]) {
  test(`${entry}: an oversized bounded array is rejected without one issue per element`, async () => {
    const { z } = await import(entry);
    const schema = z.array(z.string()).max(10);
    const result = schema.safeParse(Array.from({ length: 100_000 }, (_, i) => i));
    assert.equal(result.success, false);
    assert.ok(result.error.issues.length <= 10, `${result.error.issues.length} issues`);
  });
}

// Tool schemas stay on "zod/v3" so tools/list is byte-identical to zod 3 (the v4 serializer drops
// additionalProperties:false). The zod/v3 code did not get the fix, so it must not see arrays,
// sets or maps: a tool that needs one moves to "zod" (v4) first.
const ARRAY_LIKE = /\bz\s*\.\s*(array|set|map|tuple)\s*\(|\.array\s*\(\s*\)/;

test("the array guard matches array, set and map schemas", () => {
  for (const s of ["z.array(z.string())", "z.set(z.string())", "z.map(a, b)", "z.tuple([])", "z.string().array()"]) {
    assert.match(s, ARRAY_LIKE, s);
  }
  assert.doesNotMatch('z.record(z.string(), z.unknown())', ARRAY_LIKE);
});

test("tool schemas on zod/v3 declare no array, set or map", () => {
  const src = new URL("../src/", import.meta.url);
  const read = (f) => readFileSync(new URL(String(f).replaceAll("\\", "/"), src), "utf8");
  const files = readdirSync(src, { recursive: true }).filter((f) => String(f).endsWith(".ts"));
  const onV3 = files.filter((f) => read(f).includes('from "zod/v3"'));
  assert.ok(onV3.length >= 5, `expected the 5 tool files on zod/v3, found ${onV3.length}`);
  for (const f of onV3) assert.doesNotMatch(read(f), ARRAY_LIKE, `${f} uses an array/set/map schema`);
});
