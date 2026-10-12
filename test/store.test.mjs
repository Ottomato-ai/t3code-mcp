// Launch desk store: pure queue rules plus the shared desk.json file.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as S from "../dist/desk/store.js";
import { T0, MIN, HOUR, tempDir } from "./helpers.mjs";

const ctx = (o = {}) => ({ runningThreadIds: [], cap: 2, commitPercent: 50, nowMs: T0, ...o });
const add = (st, lane, priority = "normal", at = T0) =>
  S.enqueue(st, { lane, project: "Scratch", task: `task ${lane}`, priority, nowMs: at });

test("order: Ned entries first by time, then normal entries first in, first out", () => {
  const st = S.emptyState();
  add(st, "A", "normal", T0);
  add(st, "B", "ned", T0 + 1000);
  add(st, "C", "normal", T0 + 2000);
  add(st, "D", "ned", T0 + 3000);
  assert.deepEqual(S.orderedWaiting(st).map((e) => e.lane), ["B", "D", "A", "C"]);
});

test("entries created in the same millisecond keep arrival order", () => {
  for (let round = 0; round < 20; round++) {
    const st = S.emptyState();
    for (const lane of ["A", "B", "C", "D"]) add(st, lane, "normal", T0);
    assert.deepEqual(S.orderedWaiting(st).map((e) => e.lane), ["A", "B", "C", "D"]);
  }
});

test("positions are dense and 1-based; non-waiting entries have no position", () => {
  const st = S.emptyState();
  const a = add(st, "A", "normal", T0);
  const b = add(st, "B", "normal", T0 + 1);
  const c = add(st, "C", "normal", T0 + 2);
  assert.deepEqual([a, b, c].map((e) => S.positionOf(st, e.id)), [1, 2, 3]);
  b.state = "cancelled";
  assert.equal(S.positionOf(st, a.id), 1);
  assert.equal(S.positionOf(st, b.id), null);
  assert.equal(S.positionOf(st, c.id), 2);
  assert.equal(S.positionOf(st, "nope"), null);
});

test("enqueue records the entry fields from the design", () => {
  const st = S.emptyState();
  const e = add(st, "A", "ned", T0);
  assert.equal(e.state, "waiting");
  assert.equal(e.priority, "ned");
  assert.equal(e.lane, "A");
  assert.equal(e.project, "Scratch");
  assert.equal(e.task, "task A");
  assert.equal(e.created_at, new Date(T0).toISOString());
  assert.equal(e.granted_at, null);
  assert.equal(e.grant_expires_at, null);
  assert.equal(e.thread_id, null);
  assert.match(e.id, /^[0-9a-f-]{36}$/);
});

test("grant only while running + live grants is under the cap", () => {
  const st = S.emptyState();
  const a = add(st, "A", "normal", T0);
  const b = add(st, "B", "normal", T0 + 1);
  const c = add(st, "C", "normal", T0 + 2);
  const r1 = S.recompute(st, ctx({ cap: 2, runningThreadIds: ["t1"] }));
  assert.deepEqual(r1.granted.map((e) => e.id), [a.id]);
  assert.equal(a.state, "granted");
  assert.equal(a.granted_at, new Date(T0).toISOString());
  assert.equal(a.grant_expires_at, new Date(T0 + 10 * MIN).toISOString());
  // The live grant holds its slot: nothing more fits.
  const r2 = S.recompute(st, ctx({ cap: 2, runningThreadIds: ["t1"] }));
  assert.equal(r2.granted.length, 0);
  assert.equal(b.state, "waiting");
  assert.equal(S.positionOf(st, b.id), 1);
  // Two slots free: both remaining waiters are granted, in order.
  const r3 = S.recompute(st, ctx({ cap: 4, runningThreadIds: ["t1"] }));
  assert.deepEqual(r3.granted.map((e) => e.lane), ["B", "C"]);
  assert.equal(c.state, "granted");
});

test("no grant at the cap exactly", () => {
  const st = S.emptyState();
  add(st, "A");
  const r = S.recompute(st, ctx({ cap: 2, runningThreadIds: ["t1", "t2"] }));
  assert.equal(r.granted.length, 0);
});

test("memory guard: no grant at or above 90% commit; unknown commit does not block", () => {
  for (const [commitPercent, expected] of [
    [90, 0],
    [97.5, 0],
    [89.9, 1],
    [null, 1],
  ]) {
    const st = S.emptyState();
    add(st, "A");
    const r = S.recompute(st, ctx({ commitPercent }));
    assert.equal(r.granted.length, expected, `commit ${commitPercent}`);
  }
});

test("a grant expires after 10 minutes and the next entry is granted", () => {
  const st = S.emptyState();
  const a = add(st, "A", "normal", T0);
  const b = add(st, "B", "normal", T0 + 1);
  S.recompute(st, ctx({ cap: 1 }));
  assert.equal(a.state, "granted");
  S.recompute(st, ctx({ cap: 1, nowMs: T0 + 10 * MIN - 1 }));
  assert.equal(a.state, "granted");
  assert.equal(b.state, "waiting");
  const r = S.recompute(st, ctx({ cap: 1, nowMs: T0 + 10 * MIN }));
  assert.equal(a.state, "expired");
  assert.equal(b.state, "granted");
  assert.deepEqual(r.expired.map((e) => e.id), [a.id]);
});

test("the grant window is configurable", () => {
  const st = S.emptyState();
  const a = add(st, "A");
  S.recompute(st, ctx({ grantWindowMs: 1000 }));
  assert.equal(a.grant_expires_at, new Date(T0 + 1000).toISOString());
});

test("waiting entries expire after 24 hours", () => {
  const st = S.emptyState();
  const a = add(st, "A", "normal", T0);
  S.recompute(st, ctx({ cap: 0, nowMs: T0 + 24 * HOUR - 1 }));
  assert.equal(a.state, "waiting");
  const r = S.recompute(st, ctx({ cap: 0, nowMs: T0 + 24 * HOUR }));
  assert.equal(a.state, "expired");
  assert.deepEqual(r.expired.map((e) => e.id), [a.id]);
});

test("a launch not yet visible in T3 keeps its slot for 2 minutes", () => {
  const st = S.emptyState();
  const a = add(st, "A");
  S.recompute(st, ctx({ cap: 1 }));
  S.markLaunched(st, a.id, "thread-x", T0);
  assert.equal(a.state, "launched");
  assert.equal(a.thread_id, "thread-x");
  assert.equal(S.slotsUsed(st, ctx({ cap: 1 })), 1);
  // Visible in T3: counted once, not twice.
  assert.equal(S.slotsUsed(st, ctx({ cap: 1, runningThreadIds: ["thread-x"] })), 1);
  assert.equal(S.slotsUsed(st, ctx({ cap: 1, nowMs: T0 + 2 * MIN - 1 })), 1);
  assert.equal(S.slotsUsed(st, ctx({ cap: 1, nowMs: T0 + 2 * MIN })), 0);
});

test("history keeps the last 200 entries and never drops a waiting or granted entry", () => {
  const st = S.emptyState();
  const waiting = [add(st, "W1", "normal", T0), add(st, "W2", "normal", T0 + 1)];
  const granted = add(st, "G", "normal", T0 + 2);
  granted.state = "granted";
  const old = [];
  for (let i = 0; i < 250; i++) {
    const e = add(st, `old${i}`, "normal", T0 + 10 + i);
    e.state = "launched";
    e.updated_at = new Date(T0 + 10 + i).toISOString();
    old.push(e);
  }
  S.trimHistory(st);
  assert.equal(st.entries.length, 200);
  for (const e of [...waiting, granted]) assert.ok(st.entries.includes(e), e.lane);
  assert.ok(!st.entries.includes(old[0]), "oldest terminal entry dropped");
  assert.ok(st.entries.includes(old[249]), "newest terminal entry kept");
  assert.ok(!st.entries.includes(old[52]), "exactly the oldest 53 dropped");
  assert.ok(st.entries.includes(old[53]));
});

test("history at exactly 200 is not trimmed", () => {
  const st = S.emptyState();
  for (let i = 0; i < 200; i++) add(st, `e${i}`, "normal", T0 + i).state = "expired";
  S.trimHistory(st);
  assert.equal(st.entries.length, 200);
});

test("moveBefore reorders waiting entries; moving ahead of a Ned entry makes it Ned", () => {
  const st = S.emptyState();
  const a = add(st, "A", "normal", T0);
  const b = add(st, "B", "normal", T0 + 1000);
  const c = add(st, "C", "normal", T0 + 2000);
  S.moveBefore(st, c.id, a.id);
  assert.deepEqual(S.orderedWaiting(st).map((e) => e.lane), ["C", "A", "B"]);
  S.moveBefore(st, c.id, b.id);
  assert.deepEqual(S.orderedWaiting(st).map((e) => e.lane), ["A", "C", "B"]);
  const n = add(st, "N", "ned", T0 + 3000);
  S.moveBefore(st, b.id, n.id);
  assert.deepEqual(S.orderedWaiting(st).map((e) => e.lane), ["B", "N", "A", "C"]);
  assert.equal(b.priority, "ned");
});

test("moveBefore refuses entries that are not waiting", () => {
  const st = S.emptyState();
  const a = add(st, "A");
  const b = add(st, "B", "normal", T0 + 1);
  a.state = "granted";
  assert.throws(() => S.moveBefore(st, a.id, b.id), /not waiting/);
  assert.throws(() => S.moveBefore(st, b.id, a.id), /not waiting/);
  assert.throws(() => S.moveBefore(st, "nope", b.id), /No queue entry/);
  assert.throws(() => S.moveBefore(st, b.id, b.id), /itself/);
});

// ---------- file store ----------

test("update writes the whole file and read returns it; no temp files left", (t) => {
  const dir = tempDir(t);
  const store = new S.DeskStore(dir);
  const e = store.update((st) => add(st, "A"));
  const back = store.read();
  assert.equal(back.entries.length, 1);
  assert.equal(back.entries[0].id, e.id);
  assert.equal(JSON.parse(readFileSync(join(dir, "desk.json"), "utf8")).version, 1);
  assert.deepEqual(readdirSync(dir).filter((n) => n.includes(".tmp")), []);
  assert.ok(!existsSync(join(dir, "desk.lock")), "lock released");
});

test("a missing file reads as empty without an event", (t) => {
  const dir = tempDir(t);
  const store = new S.DeskStore(dir);
  assert.deepEqual(store.read().entries, []);
  assert.ok(!existsSync(join(dir, "events.jsonl")));
});

test("a corrupt file reads as empty, keeps a copy, and logs one event", (t) => {
  const dir = tempDir(t);
  writeFileSync(join(dir, "desk.json"), "{ not json");
  const store = new S.DeskStore(dir);
  assert.deepEqual(store.read().entries, []);
  assert.deepEqual(store.read().entries, []);
  const events = readFileSync(join(dir, "events.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(events.filter((e) => e.type === "corrupt_state").length, 1);
  assert.equal(readFileSync(join(dir, "desk.json.corrupt"), "utf8"), "{ not json");
  // The next write replaces it with a valid file.
  store.update((st) => add(st, "A"));
  assert.equal(store.read().entries.length, 1);
});

test("a file with the wrong shape counts as corrupt", (t) => {
  const dir = tempDir(t);
  writeFileSync(join(dir, "desk.json"), JSON.stringify({ version: 1, entries: "x" }));
  const store = new S.DeskStore(dir);
  assert.deepEqual(store.read().entries, []);
  assert.match(readFileSync(join(dir, "events.jsonl"), "utf8"), /corrupt_state/);
});

test("two processes share one lock: no update is lost", async (t) => {
  const dir = tempDir(t);
  const storeUrl = pathToFileURL(fileURLToPath(new URL("../dist/desk/store.js", import.meta.url))).href;
  const script = `
    const S = await import(${JSON.stringify(storeUrl)});
    const store = new S.DeskStore(process.argv[1]);
    for (let i = 0; i < 25; i++) {
      store.update((st) => S.enqueue(st, { lane: process.argv[2] + i, project: "p", task: "t", priority: "normal", nowMs: Date.now() }));
    }
  `;
  const run = (name) =>
    new Promise((resolve, reject) => {
      const p = spawn(process.execPath, ["--input-type=module", "-e", script, dir, name], { stdio: "inherit" });
      p.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`${name} exited ${code}`))));
    });
  await Promise.all([run("one-"), run("two-")]);
  const st = new S.DeskStore(dir).read();
  assert.equal(st.entries.length, 50);
  assert.equal(new Set(st.entries.map((e) => e.id)).size, 50);
});

test("a stale lock (older than 15 s) is broken", (t) => {
  const dir = tempDir(t);
  const store = new S.DeskStore(dir);
  store.ensureDir();
  const lock = join(dir, "desk.lock");
  writeFileSync(lock, "999999");
  const old = new Date(Date.now() - 16_000);
  utimesSync(lock, old, old);
  store.update((st) => add(st, "A"));
  assert.equal(store.read().entries.length, 1);
});

test("a fresh lock held by another process makes update time out", (t) => {
  const dir = tempDir(t);
  const store = new S.DeskStore(dir, { lockTimeoutMs: 200 });
  store.ensureDir();
  writeFileSync(join(dir, "desk.lock"), "999999");
  assert.throws(() => store.update((st) => add(st, "A")), /lock/i);
  assert.ok(existsSync(join(dir, "desk.lock")), "someone else's lock is not removed");
});

test("the lock is released when the update function throws", (t) => {
  const dir = tempDir(t);
  const store = new S.DeskStore(dir);
  assert.throws(() => store.update(() => { throw new Error("boom"); }), /boom/);
  assert.ok(!existsSync(join(dir, "desk.lock")));
});

test("update trims history to 200", (t) => {
  const dir = tempDir(t);
  const store = new S.DeskStore(dir);
  store.update((st) => {
    for (let i = 0; i < 205; i++) add(st, `e${i}`, "normal", T0 + i).state = "expired";
  });
  assert.equal(store.read().entries.length, 200);
});

test("the desk folder is created owner-only (no inherited access)", { skip: process.platform !== "win32" }, (t) => {
  const dir = join(tempDir(t), "launch-desk");
  new S.DeskStore(dir).ensureDir();
  const acl = execFileSync("icacls", [dir], { encoding: "utf8" });
  assert.doesNotMatch(acl, /\(I\)/, acl);
  assert.match(acl, new RegExp(process.env.USERNAME, "i"));
  assert.doesNotMatch(acl, /BUILTIN\\Users|Everyone|BUILTIN\\Administrators|Authenticated Users/i, acl);
});

test("logEvent appends one JSON line with a timestamp", (t) => {
  const dir = tempDir(t);
  const store = new S.DeskStore(dir);
  store.logEvent({ type: "ned_entry", lane: "L" });
  store.logEvent({ type: "queue_move", lane: "M" });
  const lines = readFileSync(join(dir, "events.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(lines.length, 2);
  assert.equal(lines[0].type, "ned_entry");
  assert.equal(lines[0].lane, "L");
  assert.ok(Date.parse(lines[0].at) > 0);
});
