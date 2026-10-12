// Phase 2 (F-45): Host Guard's headroom file and the effective cap decision.
import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { readHeadroom, defaultHeadroomFile, decideCap, HEADROOM_SCHEMA } from "../dist/desk/headroom.js";
import { T0, tempDir } from "./helpers.mjs";

const record = (o = {}) => ({
  schema: "hostguard.headroom/v1",
  at: new Date(T0).toISOString(),
  staleAfterSeconds: 120,
  commitPercent: 70,
  ceilingPercent: 80,
  openAlerts: [],
  t3: { live: 6 },
  baseCap: 15,
  hardCap: 20,
  agentCostBytes: 1073741824,
  allowedExtra: 2,
  measuring: null,
  measuringSince: null,
  reasons: [],
  ...o,
});
const write = (dir, body) => {
  const file = join(dir, "headroom.json");
  writeFileSync(file, typeof body === "string" ? body : JSON.stringify(body));
  return file;
};
const ok = (o = {}) => ({ status: "ok", at: T0, baseCap: 15, hardCap: 20, allowedExtra: 2, measuring: null, detail: null, ...o });

// ---------- reader ----------

test("schema constant", () => {
  assert.equal(HEADROOM_SCHEMA, "hostguard.headroom/v1");
});

test("a fresh record is read with its fields", (t) => {
  const r = readHeadroom({ file: write(tempDir(t), record({ measuring: "th1" })), nowMs: T0 + 5000 });
  assert.equal(r.status, "ok");
  assert.equal(r.at, T0);
  assert.equal(r.baseCap, 15);
  assert.equal(r.hardCap, 20);
  assert.equal(r.allowedExtra, 2);
  assert.equal(r.measuring, "th1");
  assert.equal(r.detail, null);
});

test("a missing or unparsable file is unreadable", (t) => {
  const dir = tempDir(t);
  assert.equal(readHeadroom({ file: join(dir, "nope.json"), nowMs: T0 }).status, "unreadable");
  assert.equal(readHeadroom({ file: write(dir, "{oops"), nowMs: T0 }).status, "unreadable");
  assert.equal(readHeadroom({ file: write(dir, "null"), nowMs: T0 }).status, "unreadable");
  assert.ok(readHeadroom({ file: join(dir, "nope.json"), nowMs: T0 }).detail);
});

test("an unknown schema is refused", (t) => {
  const dir = tempDir(t);
  assert.equal(readHeadroom({ file: write(dir, record({ schema: "hostguard.headroom/v2" })), nowMs: T0 }).status, "schema");
  assert.equal(readHeadroom({ file: write(dir, record({ schema: undefined })), nowMs: T0 }).status, "schema");
});

test("a record older than staleAfterSeconds is stale; exactly at the limit is still fresh", (t) => {
  const dir = tempDir(t);
  const file = write(dir, record({ staleAfterSeconds: 60 }));
  assert.equal(readHeadroom({ file, nowMs: T0 + 60_000 }).status, "ok");
  assert.equal(readHeadroom({ file, nowMs: T0 + 60_001 }).status, "stale");
});

test("staleAfterSeconds defaults to 120 when missing or invalid", (t) => {
  const dir = tempDir(t);
  for (const v of [undefined, "120", -5, 0]) {
    const file = write(dir, record({ staleAfterSeconds: v }));
    assert.equal(readHeadroom({ file, nowMs: T0 + 120_000 }).status, "ok", String(v));
    assert.equal(readHeadroom({ file, nowMs: T0 + 120_001 }).status, "stale", String(v));
  }
});

test("a record without a valid time is unreadable", (t) => {
  const dir = tempDir(t);
  assert.equal(readHeadroom({ file: write(dir, record({ at: "soon" })), nowMs: T0 }).status, "unreadable");
  assert.equal(readHeadroom({ file: write(dir, record({ at: undefined })), nowMs: T0 }).status, "unreadable");
});

test("bad numbers read as safe values: allowedExtra 0, caps null; measuring only as a string", (t) => {
  const dir = tempDir(t);
  const r = readHeadroom({
    file: write(dir, record({ allowedExtra: "3", baseCap: "15", hardCap: null, measuring: 42 })),
    nowMs: T0,
  });
  assert.equal(r.status, "ok");
  assert.equal(r.allowedExtra, 0);
  assert.equal(r.baseCap, null);
  assert.equal(r.hardCap, null);
  assert.equal(r.measuring, null);
});

test("default headroom file: HOST_GUARD_HOME, else %USERPROFILE%\\.host-guard", () => {
  assert.equal(defaultHeadroomFile({ HOST_GUARD_HOME: "X:\\hg", USERPROFILE: "C:\\U" }), join("X:\\hg", "headroom.json"));
  assert.equal(defaultHeadroomFile({ USERPROFILE: "C:\\U" }), join("C:\\U", ".host-guard", "headroom.json"));
  assert.equal(defaultHeadroomFile({ HOME: "/home/n" }), join("/home/n", ".host-guard", "headroom.json"));
});

// ---------- decision ----------

test("cap: base plus allowedExtra, one extra grant at a time", () => {
  assert.deepEqual(decideCap({ floor: 15, reading: ok(), lastExtraAt: null }), {
    effective: 17, base: 15, extra: 2, reason: "extra", extraGrants: 1,
  });
});

test("cap: no extra is plain base", () => {
  assert.deepEqual(decideCap({ floor: 15, reading: ok({ allowedExtra: 0 }), lastExtraAt: null }), {
    effective: 15, base: 15, extra: 0, reason: "base", extraGrants: 0,
  });
});

test("cap: never above hardCap, never above 20, never below 15", () => {
  assert.equal(decideCap({ floor: 15, reading: ok({ allowedExtra: 5, hardCap: 17 }), lastExtraAt: null }).effective, 17);
  assert.equal(decideCap({ floor: 15, reading: ok({ allowedExtra: 50, hardCap: 99 }), lastExtraAt: null }).effective, 20);
  assert.equal(decideCap({ floor: 15, reading: ok({ allowedExtra: 0, baseCap: 3 }), lastExtraAt: null }).effective, 15);
  assert.equal(decideCap({ floor: 15, reading: ok({ allowedExtra: 0, baseCap: 3 }), lastExtraAt: null }).base, 15);
  assert.equal(decideCap({ floor: 15, reading: ok({ allowedExtra: 0, baseCap: 40 }), lastExtraAt: null }).effective, 20);
  assert.equal(decideCap({ floor: 15, reading: ok({ allowedExtra: 4, hardCap: 10 }), lastExtraAt: null }).effective, 15);
  assert.equal(decideCap({ floor: 15, reading: ok({ allowedExtra: 2, baseCap: null, hardCap: null }), lastExtraAt: null }).effective, 17);
});

test("cap: allowedExtra is a whole, non-negative number", () => {
  assert.equal(decideCap({ floor: 15, reading: ok({ allowedExtra: 2.7 }), lastExtraAt: null }).extra, 2);
  assert.equal(decideCap({ floor: 15, reading: ok({ allowedExtra: -3 }), lastExtraAt: null }).effective, 15);
});

test("cap: stale, unreadable or unknown schema means the floor", () => {
  for (const status of ["stale", "unreadable", "schema"]) {
    assert.deepEqual(decideCap({ floor: 15, reading: ok({ status, allowedExtra: 5 }), lastExtraAt: null }), {
      effective: 15, base: 15, extra: 0, reason: status, extraGrants: 0,
    });
  }
});

test("cap: while Host Guard measures a launch, no extra", () => {
  assert.deepEqual(decideCap({ floor: 15, reading: ok({ measuring: "th1", allowedExtra: 5 }), lastExtraAt: null }), {
    effective: 15, base: 15, extra: 0, reason: "measuring", extraGrants: 0,
  });
});

test("cap: after an extra launch, no extra until a later record arrives", () => {
  const pending = decideCap({ floor: 15, reading: ok({ at: T0 }), lastExtraAt: T0 });
  assert.deepEqual(pending, { effective: 15, base: 15, extra: 0, reason: "pending-measurement", extraGrants: 0 });
  assert.equal(decideCap({ floor: 15, reading: ok({ at: T0 - 1 }), lastExtraAt: T0 }).reason, "pending-measurement");
  assert.equal(decideCap({ floor: 15, reading: ok({ at: T0 + 1 }), lastExtraAt: T0 }).reason, "extra");
});

test("cap: a configured floor above 15 is kept (T3_LAUNCH_CAP)", () => {
  assert.equal(decideCap({ floor: 18, reading: ok({ allowedExtra: 0 }), lastExtraAt: null }).effective, 18);
  assert.equal(decideCap({ floor: 18, reading: ok({ status: "stale" }), lastExtraAt: null }).effective, 18);
});

test("reader: allowedExtra is floored and never negative; a non-object record is unreadable; stale has a detail", (t) => {
  const dir = tempDir(t);
  assert.equal(readHeadroom({ file: write(dir, record({ allowedExtra: 2.7 })), nowMs: T0 }).allowedExtra, 2);
  assert.equal(readHeadroom({ file: write(dir, record({ allowedExtra: -3 })), nowMs: T0 }).allowedExtra, 0);
  assert.equal(readHeadroom({ file: write(dir, "5"), nowMs: T0 }).status, "unreadable");
  const stale = readHeadroom({ file: write(dir, record()), nowMs: T0 + 121_000 });
  assert.match(stale.detail, /121 s old/);
  assert.equal(readHeadroom({ file: write(dir, record()), nowMs: T0 }).detail, null);
});

test("cap: a configured floor above 20 is kept", () => {
  assert.equal(decideCap({ floor: 25, reading: ok({ allowedExtra: 3, hardCap: 99 }), lastExtraAt: null }).effective, 25);
});
