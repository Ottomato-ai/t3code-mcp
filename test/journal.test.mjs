// Delivery journal (src/delivery/journal.ts): exclusive claims, proof-only resolution.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DeliveryJournal, JournalConflictError, journalKey, STALE_IN_FLIGHT_MS } from "../dist/delivery/journal.js";
import { tempDir } from "./helpers.mjs";

const cmd = (id = "c1") => ({ type: "queued-run.start", commandId: id, threadId: "t", runId: "r" });
const claim = (j, over = {}) => j.claim({ threadId: "t", subject: { kind: "queued-run", runId: "r" }, messageId: "m", textSha256: "h", command: cmd(), ...over });

test("only one claim per send, across processes sharing the folder", (t) => {
  const dir = tempDir(t);
  const a = new DeliveryJournal(dir, { pid: 1, instance: "a" });
  const b = new DeliveryJournal(dir, { pid: 2, instance: "b" });
  const first = claim(a);
  const second = claim(b, { command: cmd("c2") });
  assert.equal(first.ok, true);
  assert.equal(second.ok, false);
  assert.equal(second.existing.commandId, "c1");
});

test("resolve moves the record to resolved/ and frees the send for a new attempt", (t) => {
  const dir = tempDir(t);
  const j = new DeliveryJournal(dir);
  const r = claim(j);
  j.resolve(r.record, "rejected", "thread active");
  assert.equal(j.get("t", "r"), null);
  assert.equal(readdirSync(join(dir, "resolved")).length, 1);
  assert.equal(claim(j, { command: cmd("c2") }).ok, true);
});

test("unknown records stay open: an exited owner does not clear them", (t) => {
  const dir = tempDir(t);
  const dead = new DeliveryJournal(dir, { pid: 999_999_998, instance: "gone" });
  dead.note(claim(dead).record, "dispatch_ambiguous", "timeout", "unknown");
  const me = new DeliveryJournal(dir);
  const rec = me.get("t", "r");
  assert.equal(rec.status, "unknown");
  assert.equal(me.ownerAlive(rec), false);
  assert.equal(me.isLive(rec), false);
  assert.equal(me.open().length, 1);
  assert.equal(claim(me, { command: cmd("c3") }).ok, false, "still blocks a new send");
});

test("an in-flight record of a live owner is live; past the stale age it is not (but stays open)", (t) => {
  const dir = tempDir(t);
  let now = Date.parse("2026-11-07T20:00:00Z");
  const j = new DeliveryJournal(dir, { now: () => now });
  const r = claim(j).record;
  assert.equal(j.isLive(r), true);
  now += STALE_IN_FLIGHT_MS + 1;
  assert.equal(j.isLive(j.get("t", "r")), false);
  assert.equal(j.open().length, 1);
});

test("an unreadable record is treated as unknown (quarantined), not as absent", (t) => {
  const dir = tempDir(t);
  const j = new DeliveryJournal(dir);
  claim(j);
  writeFileSync(join(dir, "open", `${journalKey("t", "r")}.json`), "{ half a rec");
  const rec = j.get("t", "r");
  assert.equal(rec.status, "unknown");
  assert.equal(claim(j, { command: cmd("c9") }).ok, false);
});

test("fencing: a stale writer cannot resolve or archive a newer claim for the same send", (t) => {
  const dir = tempDir(t);
  const a = new DeliveryJournal(dir, { pid: 1, instance: "a" });
  const b = new DeliveryJournal(dir, { pid: 2, instance: "b" });
  const first = a.note(claim(a).record, "dispatch_unproven", "timeout", "unknown");
  const staleCopy = b.get("t", "r"); // two reconcilers hold the same record
  a.resolve(first, "delivered", "proven by A");
  const second = claim(a, { command: cmd("c2") }); // a new send claims the slot
  assert.equal(second.ok, true);
  assert.throws(() => b.resolve(staleCopy, "rejected", "stale"), JournalConflictError);
  assert.throws(() => b.note(staleCopy, "x"), JournalConflictError);
  const now = b.get("t", "r");
  assert.equal(now.commandId, "c2");
  assert.equal(now.status, "in_flight");
});

test("a lock left by a crashed writer expires", (t) => {
  const dir = tempDir(t);
  const j = new DeliveryJournal(dir);
  const r = claim(j).record;
  const lock = join(dir, "open", `${journalKey("t", "r")}.lock`);
  writeFileSync(lock, "999:dead");
  const old = new Date(Date.now() - 60_000);
  utimesSync(lock, old, old);
  assert.equal(j.note(r, "after crash").events.at(-1).event, "after crash");
});
