// Launch desk store: pure queue rules plus the shared desk.json file.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as S from "../dist/desk/store.js";
import { T0, MIN, HOUR, tempDir, ownerOnlyAcl, inheritedAcl } from "./helpers.mjs";

/** pid of a process that has already exited. */
const DEAD = spawnSync(process.execPath, ["-e", ""]).pid;
const ctx = (o = {}) => ({ runningThreadIds: [], cap: 2, commitPercent: 50, nowMs: T0, ...o });
const add = (st, lane, priority = "normal", at = T0) =>
  S.enqueue(st, { lane, project: "Scratch", project_id: "p1", task: `task ${lane}`, priority, nowMs: at });
const events = (dir) =>
  existsSync(join(dir, "events.jsonl"))
    ? readFileSync(join(dir, "events.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l))
    : [];
const age = (file, ms) => {
  const old = new Date(Date.now() - ms);
  utimesSync(file, old, old);
};

// ---------- queue rules ----------

test("order: Ned entries first, then normal entries first in, first out", () => {
  const st = S.emptyState();
  add(st, "A", "normal");
  add(st, "B", "ned");
  add(st, "C", "normal");
  add(st, "D", "ned");
  assert.deepEqual(S.orderedWaiting(st).map((e) => e.lane), ["B", "D", "A", "C"]);
});

test("order follows arrival, not the wall clock (sort key is a counter that only goes up)", () => {
  const st = S.emptyState();
  add(st, "A", "normal", T0 + 5000);
  add(st, "B", "normal", T0); // clock stepped back
  add(st, "C", "normal", T0);
  assert.deepEqual(S.orderedWaiting(st).map((e) => e.lane), ["A", "B", "C"]);
  assert.deepEqual(st.entries.map((e) => e.sort_key), [1, 2, 3]);
  assert.equal(st.seq, 3);
});

test("positions are dense and 1-based; non-waiting entries have no position", () => {
  const st = S.emptyState();
  const a = add(st, "A");
  const b = add(st, "B");
  const c = add(st, "C");
  assert.deepEqual([a, b, c].map((e) => S.positionOf(st, e.id)), [1, 2, 3]);
  b.state = "cancelled";
  assert.equal(S.positionOf(st, a.id), 1);
  assert.equal(S.positionOf(st, b.id), null);
  assert.equal(S.positionOf(st, c.id), 2);
  assert.equal(S.positionOf(st, "nope"), null);
});

test("enqueue records the entry fields", () => {
  const st = S.emptyState();
  const e = add(st, "A", "ned", T0);
  assert.equal(e.state, "waiting");
  assert.equal(e.priority, "ned");
  assert.equal(e.lane, "A");
  assert.equal(e.project, "Scratch");
  assert.equal(e.project_id, "p1");
  assert.equal(e.task, "task A");
  assert.equal(e.kind, "create");
  assert.equal(e.target_thread_id, null);
  assert.equal(e.created_at, new Date(T0).toISOString());
  assert.equal(e.granted_at, null);
  assert.equal(e.grant_expires_at, null);
  assert.equal(e.thread_id, null);
  assert.match(e.id, /^[0-9a-f-]{36}$/);
  const r = S.enqueue(st, { lane: "B", project: "P", project_id: "p1", task: "t", priority: "normal", nowMs: T0, kind: "resume", target_thread_id: "th1" });
  assert.equal(r.kind, "resume");
  assert.equal(r.target_thread_id, "th1");
});

test("grant only while running + live grants is under the cap", () => {
  const st = S.emptyState();
  const a = add(st, "A");
  const b = add(st, "B");
  const c = add(st, "C");
  const r1 = S.recompute(st, ctx({ cap: 2, runningThreadIds: ["t1"] }));
  assert.deepEqual(r1.granted.map((e) => e.id), [a.id]);
  assert.equal(a.state, "granted");
  assert.equal(a.granted_at, new Date(T0).toISOString());
  assert.equal(a.grant_expires_at, new Date(T0 + 10 * MIN).toISOString());
  const r2 = S.recompute(st, ctx({ cap: 2, runningThreadIds: ["t1"] }));
  assert.equal(r2.granted.length, 0);
  assert.equal(b.state, "waiting");
  const r3 = S.recompute(st, ctx({ cap: 4, runningThreadIds: ["t1"] }));
  assert.deepEqual(r3.granted.map((e) => e.lane), ["B", "C"]);
  assert.equal(c.state, "granted");
});

test("no grant at the cap exactly", () => {
  const st = S.emptyState();
  add(st, "A");
  assert.equal(S.recompute(st, ctx({ cap: 2, runningThreadIds: ["t1", "t2"] })).granted.length, 0);
});

test("memory guard: no grant at or above 90% commit; unknown commit does not block", () => {
  for (const [commitPercent, expected] of [[90, 0], [97.5, 0], [89.9, 1], [null, 1]]) {
    const st = S.emptyState();
    add(st, "A");
    assert.equal(S.recompute(st, ctx({ commitPercent })).granted.length, expected, `commit ${commitPercent}`);
  }
});

test("a grant expires after 10 minutes and the next entry is granted", () => {
  const st = S.emptyState();
  const a = add(st, "A");
  const b = add(st, "B");
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
  const a = add(st, "A");
  S.recompute(st, ctx({ cap: 0, nowMs: T0 + 24 * HOUR - 1 }));
  assert.equal(a.state, "waiting");
  const r = S.recompute(st, ctx({ cap: 0, nowMs: T0 + 24 * HOUR }));
  assert.equal(a.state, "expired");
  assert.deepEqual(r.expired.map((e) => e.id), [a.id]);
});

// ---------- claims (one grant, one launch) ----------

test("claim moves a granted entry to launching with a token; a second claim is refused as in progress", () => {
  const st = S.emptyState();
  const a = add(st, "A");
  S.recompute(st, ctx({ cap: 1 }));
  const token = S.claim(st, a.id, T0 + 1000);
  assert.equal(a.state, "launching");
  assert.equal(a.claim, token);
  assert.equal(a.claimed_at, new Date(T0 + 1000).toISOString());
  assert.match(token, /^[0-9a-f-]{36}$/);
  assert.throws(() => S.claim(st, a.id, T0 + 2000), /in progress/);
  const w = add(st, "W");
  assert.throws(() => S.claim(st, w.id, T0), /not granted/);
});

test("a launching entry holds its slot", () => {
  const st = S.emptyState();
  const a = add(st, "A");
  S.recompute(st, ctx({ cap: 1 }));
  S.claim(st, a.id, T0);
  assert.equal(S.slotsUsed(st, ctx({ cap: 1 })), 1);
  add(st, "B");
  assert.equal(S.recompute(st, ctx({ cap: 1 })).granted.length, 0);
});

test("markLaunched needs the claim token", () => {
  const st = S.emptyState();
  const a = add(st, "A");
  S.recompute(st, ctx({ cap: 1 }));
  const token = S.claim(st, a.id, T0);
  assert.throws(() => S.markLaunched(st, a.id, "thread-x", T0, "wrong"), /claim/);
  S.markLaunched(st, a.id, "thread-x", T0, token);
  assert.equal(a.state, "launched");
  assert.equal(a.thread_id, "thread-x");
  assert.equal(a.claim, null);
});

test("release before thread.create was sent gives the grant back; after, the entry is failed", () => {
  const st = S.emptyState();
  const a = add(st, "A");
  S.recompute(st, ctx({ cap: 1 }));
  const t1 = S.claim(st, a.id, T0);
  S.releaseClaim(st, a.id, t1, { createSent: false, threadId: "th-1", nowMs: T0 + 1 });
  assert.equal(a.state, "granted");
  assert.equal(a.claim, null);
  assert.equal(a.grant_expires_at, new Date(T0 + 10 * MIN).toISOString(), "grant window unchanged");
  const t2 = S.claim(st, a.id, T0 + 2);
  S.releaseClaim(st, a.id, "wrong", { createSent: true, threadId: "th-2", nowMs: T0 + 3 });
  assert.equal(a.state, "launching", "a wrong token changes nothing");
  S.releaseClaim(st, a.id, t2, { createSent: true, threadId: "th-2", nowMs: T0 + 3 });
  assert.equal(a.state, "failed");
  assert.equal(a.thread_id, "th-2");
  assert.equal(a.updated_at, new Date(T0 + 3).toISOString());
});

test("a failed launch holds its slot for 2 minutes unless T3 shows the thread", () => {
  const st = S.emptyState();
  const a = add(st, "A");
  S.recompute(st, ctx({ cap: 1 }));
  const tok = S.claim(st, a.id, T0);
  S.releaseClaim(st, a.id, tok, { createSent: true, threadId: "th", nowMs: T0 });
  assert.equal(S.slotsUsed(st, ctx({ cap: 1 })), 1);
  assert.equal(S.slotsUsed(st, ctx({ cap: 1, runningThreadIds: ["th"] })), 1);
  assert.equal(S.slotsUsed(st, ctx({ cap: 1, nowMs: T0 + 2 * MIN })), 0);
});

test("a launching entry older than 5 minutes is failed (the launcher died)", () => {
  const st = S.emptyState();
  const a = add(st, "A");
  S.recompute(st, ctx({ cap: 1 }));
  S.claim(st, a.id, T0);
  S.recompute(st, ctx({ cap: 1, nowMs: T0 + 5 * MIN - 1 }));
  assert.equal(a.state, "launching");
  const r = S.recompute(st, ctx({ cap: 1, nowMs: T0 + 5 * MIN }));
  assert.equal(a.state, "failed");
  assert.deepEqual(r.expired.map((e) => e.id), [a.id]);
});

test("a launch not yet visible in T3 keeps its slot for 2 minutes", () => {
  const st = S.emptyState();
  const a = add(st, "A");
  S.recompute(st, ctx({ cap: 1 }));
  const tok = S.claim(st, a.id, T0);
  S.markLaunched(st, a.id, "thread-x", T0, tok);
  assert.equal(S.slotsUsed(st, ctx({ cap: 1 })), 1);
  assert.equal(S.slotsUsed(st, ctx({ cap: 1, runningThreadIds: ["thread-x"] })), 1);
  assert.equal(S.slotsUsed(st, ctx({ cap: 1, nowMs: T0 + 2 * MIN - 1 })), 1);
  assert.equal(S.slotsUsed(st, ctx({ cap: 1, nowMs: T0 + 2 * MIN })), 0);
});

// ---------- history and moves ----------

test("history keeps the last 200 entries and never drops a waiting, granted or launching entry", () => {
  const st = S.emptyState();
  const waiting = [add(st, "W1"), add(st, "W2")];
  const granted = add(st, "G");
  granted.state = "granted";
  const launching = add(st, "L");
  launching.state = "launching";
  const old = [];
  for (let i = 0; i < 250; i++) {
    const e = add(st, `old${i}`, "normal", T0 + 10 + i);
    e.state = "launched";
    e.updated_at = new Date(T0 + 10 + i).toISOString();
    old.push(e);
  }
  S.trimHistory(st);
  assert.equal(st.entries.length, 200);
  for (const e of [...waiting, granted, launching]) assert.ok(st.entries.includes(e), e.lane);
  assert.ok(!st.entries.includes(old[0]));
  assert.ok(st.entries.includes(old[249]));
  assert.ok(!st.entries.includes(old[53]), "exactly the oldest 54 dropped");
  assert.ok(st.entries.includes(old[54]));
});

test("history at exactly 200 is not trimmed", () => {
  const st = S.emptyState();
  for (let i = 0; i < 200; i++) add(st, `e${i}`).state = "expired";
  S.trimHistory(st);
  assert.equal(st.entries.length, 200);
});

test("moveBefore reorders waiting entries and sets updated_at", () => {
  const st = S.emptyState();
  const a = add(st, "A");
  const b = add(st, "B");
  const c = add(st, "C");
  S.moveBefore(st, c.id, a.id, T0 + 7);
  assert.deepEqual(S.orderedWaiting(st).map((e) => e.lane), ["C", "A", "B"]);
  assert.equal(c.updated_at, new Date(T0 + 7).toISOString());
  S.moveBefore(st, c.id, b.id, T0 + 8);
  assert.deepEqual(S.orderedWaiting(st).map((e) => e.lane), ["A", "C", "B"]);
  const n = add(st, "N", "ned");
  S.moveBefore(st, b.id, n.id, T0 + 9);
  assert.deepEqual(S.orderedWaiting(st).map((e) => e.lane), ["B", "N", "A", "C"]);
  assert.equal(b.priority, "ned");
  const later = add(st, "Z");
  assert.deepEqual(S.orderedWaiting(st).map((e) => e.lane), ["B", "N", "A", "C", "Z"], "new entries still go last");
  assert.ok(later.sort_key > Math.max(...st.entries.filter((e) => e !== later).map((e) => e.sort_key)));
});

test("moveBefore works when neighbours have equal keys", () => {
  const st = S.emptyState();
  const a = add(st, "A");
  const b = add(st, "B");
  const c = add(st, "C");
  a.sort_key = b.sort_key = c.sort_key = 5;
  S.moveBefore(st, c.id, b.id, T0);
  assert.deepEqual(S.orderedWaiting(st).map((e) => e.lane), ["A", "C", "B"]);
});

test("moveBefore ahead of a normal entry that sits right after a Ned entry", () => {
  const st = S.emptyState();
  const a = add(st, "A");
  add(st, "N", "ned");
  const c = add(st, "C");
  S.moveBefore(st, c.id, a.id, T0);
  assert.deepEqual(S.orderedWaiting(st).map((e) => e.lane), ["N", "C", "A"]);
});

test("moveBefore refuses entries that are not waiting", () => {
  const st = S.emptyState();
  const a = add(st, "A");
  const b = add(st, "B");
  a.state = "granted";
  assert.throws(() => S.moveBefore(st, a.id, b.id, T0), /not waiting/);
  assert.throws(() => S.moveBefore(st, b.id, a.id, T0), /not waiting/);
  assert.throws(() => S.moveBefore(st, "nope", b.id, T0), /No queue entry/);
  assert.throws(() => S.moveBefore(st, b.id, b.id, T0), /itself/);
});

// ---------- validation ----------

test("validState accepts a good state and rejects bad shapes and bad entry fields", () => {
  const st = S.emptyState();
  add(st, "A");
  assert.equal(S.validState(JSON.parse(JSON.stringify(st))), true);
  assert.equal(S.validState({ version: 1, entries: [] }), true, "seq may be missing in an older file");
  const bad = (mutate) => {
    const s = JSON.parse(JSON.stringify(st));
    mutate(s);
    return S.validState(s);
  };
  assert.equal(bad((s) => (s.version = 2)), false);
  assert.equal(bad((s) => (s.entries = "x")), false);
  assert.equal(bad((s) => (s.seq = "1")), false);
  for (const field of ["id", "lane", "project", "project_id", "task", "created_at", "updated_at"]) {
    assert.equal(bad((s) => (s.entries[0][field] = 7)), false, field);
  }
  assert.equal(bad((s) => (s.entries[0].priority = "vip")), false);
  assert.equal(bad((s) => (s.entries[0].state = "dancing")), false);
  assert.equal(bad((s) => (s.entries[0].sort_key = "1")), false);
  assert.equal(bad((s) => (s.entries[0].kind = "other")), false);
  assert.equal(bad((s) => (s.entries[0].created_at = "not a date")), false);
  assert.equal(bad((s) => (s.entries[0] = null)), false);
});

// ---------- file store ----------

test("update writes the whole file and read returns it; no temp files left", (t) => {
  const dir = tempDir(t);
  const store = new S.DeskStore(dir);
  const e = store.update((st) => add(st, "A"));
  const back = store.read();
  assert.equal(back.entries.length, 1);
  assert.equal(back.entries[0].id, e.id);
  assert.equal(back.seq, 1);
  assert.equal(JSON.parse(readFileSync(join(dir, "desk.json"), "utf8")).version, 1);
  assert.deepEqual(readdirSync(dir).filter((n) => n.includes(".tmp")), []);
  assert.ok(!existsSync(join(dir, "desk.lock")), "lock released");
});

test("a missing file reads as empty without an event", (t) => {
  const dir = tempDir(t);
  assert.deepEqual(new S.DeskStore(dir).read().entries, []);
  assert.deepEqual(events(dir), []);
});

test("a corrupt file reads as empty, keeps a timestamped copy, and logs once until a good read", (t) => {
  const dir = tempDir(t);
  writeFileSync(join(dir, "desk.json"), "{ not json");
  const store = new S.DeskStore(dir);
  assert.deepEqual(store.read().entries, []);
  assert.deepEqual(store.read().entries, []);
  assert.equal(events(dir).filter((e) => e.type === "corrupt_state").length, 1);
  const copies = readdirSync(dir).filter((n) => /^desk\.json\.corrupt-\d+$/.test(n));
  assert.equal(copies.length, 1);
  assert.equal(readFileSync(join(dir, copies[0]), "utf8"), "{ not json");
  store.update((st) => add(st, "A"));
  assert.equal(store.read().entries.length, 1);
  writeFileSync(join(dir, "desk.json"), "[]");
  store.read();
  assert.equal(events(dir).filter((e) => e.type === "corrupt_state").length, 2, "a new corruption is logged again");
});

test("a file with an invalid entry counts as corrupt", (t) => {
  const dir = tempDir(t);
  writeFileSync(join(dir, "desk.json"), JSON.stringify({ version: 1, seq: 1, entries: [{ id: 1 }] }));
  assert.deepEqual(new S.DeskStore(dir).read().entries, []);
  assert.equal(events(dir).filter((e) => e.type === "corrupt_state").length, 1);
});

test("two processes share one lock: no update is lost", async (t) => {
  const dir = tempDir(t);
  await runWriters(dir, ["one-", "two-"], 25);
  const st = new S.DeskStore(dir).read();
  assert.equal(st.entries.length, 50);
  assert.equal(new Set(st.entries.map((e) => e.id)).size, 50);
  assert.equal(new Set(st.entries.map((e) => e.sort_key)).size, 50, "sort keys stay unique across processes");
});

test("two breakers and a dead holder's lock: one breaks it, no update is lost, nothing is left behind", async (t) => {
  const dir = tempDir(t);
  new S.DeskStore(dir).ensureDir();
  const lock = join(dir, "desk.lock");
  writeFileSync(lock, `${DEAD}:dead`);
  await runWriters(dir, ["one-", "two-"], 10);
  assert.equal(new S.DeskStore(dir).read().entries.length, 20);
  assert.equal(events(dir).filter((e) => e.type === "stale_lock_broken").length, 1);
  assert.deepEqual(readdirSync(dir).filter((n) => n.startsWith("desk.lock")), []);
});

test("a lock whose holder process is dead is broken at once, by renaming it away", (t) => {
  const dir = tempDir(t);
  const store = new S.DeskStore(dir);
  store.ensureDir();
  writeFileSync(join(dir, "desk.lock"), `${DEAD}:dead`);
  store.update((st) => add(st, "A"));
  assert.equal(store.read().entries.length, 1);
  assert.deepEqual(readdirSync(dir).filter((n) => n.startsWith("desk.lock")), []);
  assert.equal(events(dir).find((e) => e.type === "stale_lock_broken").holder, `${DEAD}:dead`);
});

test("a lock whose holder is alive is not broken before 60 s, even when it is stalled", (t) => {
  const dir = tempDir(t);
  const store = new S.DeskStore(dir, { lockTimeoutMs: 300 });
  store.ensureDir();
  const lock = join(dir, "desk.lock");
  writeFileSync(lock, `${process.pid}:stalled-holder`);
  age(lock, 59_000);
  assert.throws(() => store.update((st) => add(st, "A")), /could not take the lock/);
  assert.equal(readFileSync(lock, "utf8"), `${process.pid}:stalled-holder`);
});

test("a lock 60 s or older is broken even when its holder is alive", (t) => {
  const dir = tempDir(t);
  const store = new S.DeskStore(dir);
  store.ensureDir();
  const lock = join(dir, "desk.lock");
  writeFileSync(lock, `${process.pid}:hung-holder`);
  age(lock, 60_500);
  store.update((st) => add(st, "A"));
  assert.equal(store.read().entries.length, 1);
});

test("a lock without a readable pid (still being written, or garbage) waits for 60 s", (t) => {
  for (const content of ["", "garbage", "abc:def"]) {
    const dir = tempDir(t);
    const store = new S.DeskStore(dir, { lockTimeoutMs: 200 });
    store.ensureDir();
    const lock = join(dir, "desk.lock");
    writeFileSync(lock, content);
    age(lock, 30_000);
    assert.throws(() => store.update((st) => add(st, "A")), /could not take the lock/, JSON.stringify(content));
    age(lock, 61_000);
    store.update((st) => add(st, "A"));
  }
});

test("lockHolderDead: dead pid true; live, own, missing or garbage pid false", () => {
  assert.equal(S.lockHolderDead(`${DEAD}:x`), true);
  assert.equal(S.lockHolderDead(`${process.pid}:x`), false);
  assert.equal(S.lockHolderDead(`${process.ppid}:x`), false);
  for (const v of [null, "", "x", ":x", "0:x", "-5:x", "12a:x"]) assert.equal(S.lockHolderDead(v), false, JSON.stringify(v));
});

test("a lock replaced during the break is not put back; nothing is left behind", (t) => {
  const dir = tempDir(t);
  const lock = join(dir, "desk.lock");
  let raced = false;
  const store = new S.DeskStore(dir, {
    testHook: (stage) => {
      if (raced || stage !== "rename") return;
      raced = true;
      writeFileSync(lock, `${process.pid}:other-holder`); // replaced between the check and the rename
    },
  });
  store.ensureDir();
  writeFileSync(lock, `${DEAD}:dead`);
  store.update((st) => add(st, "A"));
  assert.equal(store.read().entries.length, 1);
  assert.deepEqual(readdirSync(dir).filter((n) => n.startsWith("desk.lock")), []);
  assert.equal(events(dir).find((e) => e.type === "stale_lock_broken").holder, `${process.pid}:other-holder`);
});

test("inside the break guard the lock is checked again: a lock taken meanwhile is not broken", (t) => {
  const dir = tempDir(t);
  const lock = join(dir, "desk.lock");
  const store = new S.DeskStore(dir, {
    lockTimeoutMs: 300,
    testHook: (stage) => {
      if (stage === "guard") writeFileSync(lock, `${process.pid}:new-holder`); // broken and re-taken by another process
    },
  });
  store.ensureDir();
  writeFileSync(lock, `${DEAD}:dead`);
  assert.throws(() => store.update((st) => add(st, "A")), /could not take the lock/);
  assert.equal(readFileSync(lock, "utf8"), `${process.pid}:new-holder`);
  assert.equal(events(dir).filter((e) => e.type === "stale_lock_broken").length, 0);
});

test("while a live breaker holds the break guard, the stale lock is left to it", (t) => {
  const dir = tempDir(t);
  const store = new S.DeskStore(dir, { lockTimeoutMs: 300 });
  store.ensureDir();
  const lock = join(dir, "desk.lock");
  writeFileSync(lock, `${DEAD}:dead`);
  const guard = join(dir, "desk.lock.break");
  writeFileSync(guard, `${process.pid}:live-breaker`);
  assert.throws(() => store.update((st) => add(st, "A")), /could not take the lock/);
  assert.equal(readFileSync(lock, "utf8"), `${DEAD}:dead`);
  assert.equal(readFileSync(guard, "utf8"), `${process.pid}:live-breaker`, "a live guard is not removed");
});

test("a break guard left by a breaker that died is cleared by rename-aside", (t) => {
  const dir = tempDir(t);
  const store = new S.DeskStore(dir);
  store.ensureDir();
  writeFileSync(join(dir, "desk.lock"), `${DEAD}:dead`);
  writeFileSync(join(dir, "desk.lock.break"), `${DEAD}:dead-breaker`);
  store.update((st) => add(st, "A"));
  assert.equal(store.read().entries.length, 1);
  assert.deepEqual(readdirSync(dir).filter((n) => n.startsWith("desk.lock")), []);
});

test("a breaker removes the guard only while it still holds its own token", (t) => {
  const dir = tempDir(t);
  const guard = join(dir, "desk.lock.break");
  const store = new S.DeskStore(dir, {
    testHook: (stage) => {
      if (stage === "guard") writeFileSync(guard, `${DEAD}:another-breaker`);
    },
  });
  store.ensureDir();
  writeFileSync(join(dir, "desk.lock"), `${DEAD}:dead`);
  store.update((st) => add(st, "A"));
  assert.equal(readFileSync(guard, "utf8"), `${DEAD}:another-breaker`);
});

test("a fresh lock held by a live process makes update time out without taking the guard", (t) => {
  const dir = tempDir(t);
  let guards = 0;
  const store = new S.DeskStore(dir, { lockTimeoutMs: 200, testHook: (stage) => { if (stage === "guard") guards++; } });
  store.ensureDir();
  writeFileSync(join(dir, "desk.lock"), `${process.pid}:other`);
  assert.throws(() => store.update((st) => add(st, "A")), /lock/i);
  assert.equal(readFileSync(join(dir, "desk.lock"), "utf8"), `${process.pid}:other`);
  assert.equal(guards, 0, "a live fresh lock does not take the break guard");
});

test("the lock file holds pid:token", (t) => {
  const dir = tempDir(t);
  const store = new S.DeskStore(dir);
  let seen;
  store.update(() => {
    seen = readFileSync(join(dir, "desk.lock"), "utf8");
  });
  assert.match(seen, new RegExp(`^${process.pid}:[0-9a-f-]{36}$`));
});

test("a holder that lost its lock does not write and does not delete the new holder's lock", (t) => {
  const dir = tempDir(t);
  const store = new S.DeskStore(dir);
  store.update((st) => add(st, "A"));
  const before = readFileSync(join(dir, "desk.json"), "utf8");
  assert.throws(
    () =>
      store.update((st) => {
        add(st, "B");
        writeFileSync(join(dir, "desk.lock"), `${process.pid}:new-holder`); // our lock was broken and re-taken
      }),
    /lock/,
  );
  assert.equal(readFileSync(join(dir, "desk.json"), "utf8"), before, "the old snapshot is not written");
  assert.equal(readFileSync(join(dir, "desk.lock"), "utf8"), `${process.pid}:new-holder`);
  assert.deepEqual(readdirSync(dir).filter((n) => n.endsWith(".tmp")), []);
});

test("lockBusy: EEXIST and EPERM mean busy, other errors do not", () => {
  assert.equal(S.lockBusy("EEXIST"), true);
  assert.equal(S.lockBusy("EPERM"), true);
  assert.equal(S.lockBusy("ENOENT"), false);
  assert.equal(S.lockBusy("EACCES"), false);
  assert.equal(S.lockBusy(undefined), false);
});

test("an error other than a busy lock fails at once, not after the lock timeout", (t) => {
  const file = join(tempDir(t), "not-a-dir");
  writeFileSync(file, "x");
  const store = new S.DeskStore(file, { lockTimeoutMs: 3000, platform: "linux" });
  const started = Date.now();
  assert.throws(() => store.update(() => {}), (e) => !/could not take the lock/.test(e.message));
  assert.ok(Date.now() - started < 1000);
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
    for (let i = 0; i < 205; i++) add(st, `e${i}`).state = "expired";
  });
  assert.equal(store.read().entries.length, 200);
});

test("old temp files and stale-lock leftovers are swept at start; fresh ones are kept", (t) => {
  const dir = tempDir(t);
  const oldTmp = join(dir, "desk.json.1.aaa.tmp");
  const freshTmp = join(dir, "desk.json.2.bbb.tmp");
  const oldStale = join(dir, "desk.lock.stale.ccc");
  const oldOther = [join(dir, "desk.json"), join(dir, "events.jsonl"), join(dir, "notes.tmp")];
  for (const f of [oldTmp, freshTmp, oldStale, ...oldOther]) writeFileSync(f, "x");
  for (const f of [oldTmp, oldStale, ...oldOther]) age(f, 2 * MIN);
  new S.DeskStore(dir).read();
  new S.DeskStore(dir).ensureDir();
  assert.ok(!existsSync(oldTmp));
  assert.ok(!existsSync(oldStale));
  assert.ok(existsSync(freshTmp));
  for (const f of oldOther) assert.ok(existsSync(f), `${f} is not a leftover`);
});

// ---------- owner-only folder ----------

test("the desk folder is created owner-only (no inherited access)", { skip: process.platform !== "win32" }, (t) => {
  const dir = join(tempDir(t), "launch-desk");
  new S.DeskStore(dir).ensureDir();
  const acl = execFileSync("icacls", [dir], { encoding: "utf8" });
  assert.doesNotMatch(acl, /\(I\)/, acl);
  assert.match(acl, new RegExp(process.env.USERNAME, "i"));
  assert.doesNotMatch(acl, /BUILTIN\\Users|Everyone|BUILTIN\\Administrators|Authenticated Users/i, acl);
});

test("an existing folder with inherited and explicit access is made owner-only", { skip: process.platform !== "win32" }, (t) => {
  // Build the inherited state here instead of relying on the temp folder ACL of the machine:
  // the parent grants BUILTIN\Users read with (OI)(CI), so the child inherits it as (I).
  const parent = join(tempDir(t), "parent");
  mkdirSync(parent);
  execFileSync("icacls", [parent, "/inheritance:e", "/grant", "*S-1-5-32-545:(OI)(CI)R"], { stdio: "ignore" });
  const dir = join(parent, "launch-desk");
  mkdirSync(dir);
  execFileSync("icacls", [dir, "/grant", "*S-1-5-32-544:(OI)(CI)R"], { stdio: "ignore" }); // explicit BUILTIN\Administrators
  const before = execFileSync("icacls", [dir], { encoding: "utf8" });
  assert.match(before, /BUILTIN\\Users:\(I\)/, before);
  assert.match(before, /BUILTIN\\Administrators:\(OI\)/, before);
  new S.DeskStore(dir).ensureDir();
  const acl = execFileSync("icacls", [dir], { encoding: "utf8" });
  assert.doesNotMatch(acl, /\(I\)|BUILTIN\\Users|BUILTIN\\Administrators/, acl);
  assert.match(acl, new RegExp(process.env.USERNAME, "i"));
});

test("aclIsOwnerOnly reads icacls output", () => {
  const dir = "C:\\x\\launch-desk";
  assert.equal(S.aclIsOwnerOnly(ownerOnlyAcl(dir), dir, "TESTDOMAIN\\tester"), true);
  assert.equal(S.aclIsOwnerOnly(ownerOnlyAcl(dir), dir, "testdomain\\TESTER"), true, "case-insensitive");
  assert.equal(S.aclIsOwnerOnly(inheritedAcl(dir), dir, "TESTDOMAIN\\tester"), false);
  assert.equal(S.aclIsOwnerOnly(ownerOnlyAcl(dir, "TESTDOMAIN\\intruder"), dir, "TESTDOMAIN\\tester"), false);
  assert.equal(S.aclIsOwnerOnly("", dir, "TESTDOMAIN\\tester"), false, "no entries is not owner-only");
  const inheritedOwner = `${dir} NT AUTHORITY\\SYSTEM:(I)(OI)(CI)(F)\n  TESTDOMAIN\\tester:(OI)(CI)(F)\n`;
  assert.equal(S.aclIsOwnerOnly(inheritedOwner, dir, "TESTDOMAIN\\tester"), false, "inherited even for an allowed principal");
});

test("ACL: verified once per process; re-applied when not owner-only", (t) => {
  const dir = join(tempDir(t), "d1");
  const calls = [];
  let fixed = false;
  const icacls = (args) => {
    calls.push(args);
    if (args.includes("/inheritance:r")) fixed = true;
    return fixed ? ownerOnlyAcl(dir) : inheritedAcl(dir);
  };
  const opts = { platform: "win32", icacls, user: "TESTDOMAIN\\tester" };
  new S.DeskStore(dir, opts).ensureDir();
  assert.ok(calls.some((a) => a.includes("/inheritance:r")), "applied");
  const n = calls.length;
  new S.DeskStore(dir, opts).ensureDir();
  new S.DeskStore(dir, opts).update(() => {});
  assert.equal(calls.length, n, "not checked again in this process");
});

test("ACL: an owner-only folder is only verified, not changed", (t) => {
  const dir = join(tempDir(t), "d2");
  const calls = [];
  const icacls = (args) => (calls.push(args), ownerOnlyAcl(dir));
  new S.DeskStore(dir, { platform: "win32", icacls, user: "TESTDOMAIN\\tester" }).ensureDir();
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], [dir]);
});

test("ACL: other principals are removed when re-applying", (t) => {
  const dir = join(tempDir(t), "d4");
  const calls = [];
  let removed = false;
  let applied = false;
  const icacls = (args) => {
    calls.push(args);
    if (args.includes("/inheritance:r")) applied = true;
    if (args.includes("/remove")) removed = true;
    if (!applied) return inheritedAcl(dir);
    return removed ? ownerOnlyAcl(dir) : `${dir} BUILTIN\\Administrators:(OI)(CI)(F)\n  TESTDOMAIN\\tester:(OI)(CI)(F)\n`;
  };
  new S.DeskStore(dir, { platform: "win32", icacls, user: "TESTDOMAIN\\tester" }).ensureDir();
  assert.ok(calls.some((a) => a.includes("/remove") && a.includes("BUILTIN\\Administrators")));
});

test("ACL: when owner-only cannot be applied, the folder is refused", (t) => {
  const dir = join(tempDir(t), "d3");
  const icacls = () => inheritedAcl(dir);
  const store = new S.DeskStore(dir, { platform: "win32", icacls, user: "TESTDOMAIN\\tester" });
  assert.throws(() => store.update((st) => add(st, "A")), /owner-only/);
  assert.ok(!existsSync(join(dir, "desk.json")));
  assert.throws(() => store.ensureDir(), /owner-only/, "still refused on the next call");
});

test("ACL: an icacls failure refuses the folder", (t) => {
  const dir = join(tempDir(t), "d5");
  const icacls = () => { throw new Error("icacls not found"); };
  assert.throws(() => new S.DeskStore(dir, { platform: "win32", icacls, user: "U" }).ensureDir(), /owner-only/);
});

test("logEvent appends one JSON line with a timestamp", (t) => {
  const dir = tempDir(t);
  const store = new S.DeskStore(dir);
  store.logEvent({ type: "ned_entry", lane: "L" });
  store.logEvent({ type: "queue_move", lane: "M" });
  const lines = events(dir);
  assert.equal(lines.length, 2);
  assert.equal(lines[0].type, "ned_entry");
  assert.equal(lines[0].lane, "L");
  assert.ok(Date.parse(lines[0].at) > 0);
});

// ---------- helpers ----------

function runWriters(dir, names, count) {
  const storeUrl = pathToFileURL(fileURLToPath(new URL("../dist/desk/store.js", import.meta.url))).href;
  const script = `
    const S = await import(${JSON.stringify(storeUrl)});
    const store = new S.DeskStore(process.argv[1]);
    for (let i = 0; i < ${count}; i++) {
      store.update((st) => S.enqueue(st, { lane: process.argv[2] + i, project: "p", project_id: "p1", task: "t", priority: "normal", nowMs: Date.now() }));
    }
  `;
  const run = (name) =>
    new Promise((resolve, reject) => {
      const p = spawn(process.execPath, ["--input-type=module", "-e", script, dir, name], { stdio: "inherit" });
      p.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`${name} exited ${code}`))));
    });
  return Promise.allSettled(names.map(run)).then((rs) => {
    const bad = rs.find((r) => r.status === "rejected");
    if (bad) throw bad.reason;
  });
}
