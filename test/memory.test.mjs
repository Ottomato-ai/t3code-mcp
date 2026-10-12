// Memory guard input (host-guard heartbeat) and the running count from the T3 shell.
import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { readHostGuardMemory, defaultHostGuardFile } from "../dist/desk/memory.js";
import { runningThreadIds } from "../dist/desk/running.js";
import { T0, tempDir } from "./helpers.mjs";

const beat = (dir, body) => {
  const file = join(dir, "heartbeat.json");
  writeFileSync(file, typeof body === "string" ? body : JSON.stringify(body));
  return file;
};

test("a fresh heartbeat gives the commit percent; 90% or more blocks", (t) => {
  const dir = tempDir(t);
  const file = beat(dir, { at: new Date(T0 - 5000).toISOString(), commitPercent: 91.2, pressure: "block" });
  const m = readHostGuardMemory({ file, nowMs: T0 });
  assert.equal(m.status, "ok");
  assert.equal(m.commitPercent, 91.2);
  assert.equal(m.blocks, true);
});

test("exactly 90% blocks, 89.9% does not", (t) => {
  const dir = tempDir(t);
  const at = new Date(T0).toISOString();
  assert.equal(readHostGuardMemory({ file: beat(dir, { at, commitPercent: 90 }), nowMs: T0 }).blocks, true);
  assert.equal(readHostGuardMemory({ file: beat(dir, { at, commitPercent: 89.9 }), nowMs: T0 }).blocks, false);
});

test("a missing file is unreadable and does not block", (t) => {
  const dir = tempDir(t);
  const m = readHostGuardMemory({ file: join(dir, "nope.json"), nowMs: T0 });
  assert.equal(m.status, "unreadable");
  assert.equal(m.commitPercent, null);
  assert.equal(m.blocks, false);
  assert.ok(m.detail);
});

test("invalid JSON or no commit number is unreadable and does not block", (t) => {
  const dir = tempDir(t);
  for (const body of ["{oops", { at: new Date(T0).toISOString() }, { at: new Date(T0).toISOString(), commitPercent: "95" }]) {
    const m = readHostGuardMemory({ file: beat(dir, body), nowMs: T0 });
    assert.equal(m.status, "unreadable", JSON.stringify(body));
    assert.equal(m.blocks, false);
  }
});

test("a heartbeat older than 2 minutes is stale and does not block", (t) => {
  const dir = tempDir(t);
  const file = beat(dir, { at: new Date(T0 - 120_000).toISOString(), commitPercent: 95 });
  const m = readHostGuardMemory({ file, nowMs: T0 });
  assert.equal(m.status, "stale");
  assert.equal(m.commitPercent, 95);
  assert.equal(m.blocks, false);
  const fresh = readHostGuardMemory({ file, nowMs: T0 - 1 });
  assert.equal(fresh.status, "ok");
  assert.equal(fresh.blocks, true);
});

test("a heartbeat with no valid time is unreadable", (t) => {
  const dir = tempDir(t);
  const m = readHostGuardMemory({ file: beat(dir, { at: "never", commitPercent: 95 }), nowMs: T0 });
  assert.equal(m.status, "unreadable");
  assert.equal(m.blocks, false);
});

test("default heartbeat file: HOST_GUARD_HOME, else %USERPROFILE%\\.host-guard", () => {
  assert.equal(defaultHostGuardFile({ HOST_GUARD_HOME: "X:\\hg", USERPROFILE: "C:\\Users\\N" }), join("X:\\hg", "heartbeat.json"));
  assert.equal(defaultHostGuardFile({ USERPROFILE: "C:\\Users\\N" }), join("C:\\Users\\N", ".host-guard", "heartbeat.json"));
  assert.equal(defaultHostGuardFile({ HOME: "/home/n" }), join("/home/n", ".host-guard", "heartbeat.json"));
});

test("running count: sessions running, ready or starting, not archived", () => {
  const th = (id, status, archivedAt = null) => ({ id, archivedAt, session: status ? { threadId: id, status } : null });
  const shell = {
    threads: [
      th("run", "running"),
      th("ready", "ready"),
      th("start", "starting"),
      th("stopped", "stopped"),
      th("error", "error"),
      th("idle", "idle"),
      th("interrupted", "interrupted"),
      th("none", null),
      th("archived", "running", "2026-10-11T00:00:00Z"),
    ],
  };
  assert.deepEqual(runningThreadIds(shell), ["run", "ready", "start"]);
});
