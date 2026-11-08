// send_now: transition-safe delivery of one queued message (defects 3 and 4 of 2026-11-07).
import { test } from "node:test";
import assert from "node:assert/strict";
import { sendNow, reconcileQueuedRun, MAX_READS_PER_CALL } from "../dist/delivery/deliver.js";
import { DeliveryJournal } from "../dist/delivery/journal.js";
import { T3Error } from "../dist/client.js";
import { fakeThread, queuedUser, run, message, types, NOW, MIN, iso } from "./fake-t3.mjs";
import { tempDir } from "./helpers.mjs";

const journalIn = (t, opts) => new DeliveryJournal(tempDir(t), opts);

/** A thread with one queued user message (run q1) and, optionally, other runs. */
function thread(extraRuns = [], extra = {}) {
  return fakeThread({ items: [queuedUser("q1", { ordinal: 10 })], runs: extraRuns, ...extra });
}

test("stopped thread: starts the queued run once, verifies it left the queue, resolves the journal", async (t) => {
  const f = thread([run("done1", { status: "completed", ordinal: 9 })]);
  const journal = journalIn(t);
  const r = await sendNow(f.deps(journal), { threadId: "t-1", queuedRunId: "q1" });
  assert.equal(r.outcome, "delivered");
  assert.equal(r.reason, "started");
  assert.deepEqual(types(f.state), ["queued-run.start"]);
  assert.equal(f.state.dispatched[0].runId, "q1");
  assert.equal(r.messageId, "m-q1");
  assert.equal(r.textSha256.length, 64);
  assert.equal(journal.open().length, 0, "nothing left in the journal");
  assert.ok(f.state.reads.every((x) => x.bounded), "every read is the bounded snapshot");
});

for (const phase of ["preparing", "starting", "running", "waiting"]) {
  test(`${phase} thread is not stopped: deferred, nothing sent (defect 3: starting/preparing are not stopped)`, async (t) => {
    const f = thread([run("a1", { status: phase, ordinal: 11 })]);
    const r = await sendNow(f.deps(journalIn(t)), { threadId: "t-1", queuedRunId: "q1" });
    assert.equal(r.outcome, "deferred");
    assert.equal(r.reason, `thread_${phase}`);
    assert.equal(r.phase, phase);
    assert.deepEqual(types(f.state), []);
    assert.equal(r.reads, 1);
  });
}

test("run-state precedence: running beats waiting beats starting beats preparing", async (t) => {
  const f = thread([run("a1", { status: "preparing" }), run("a2", { status: "waiting" }), run("a3", { status: "running" })]);
  const r = await sendNow(f.deps(journalIn(t)), { threadId: "t-1", queuedRunId: "q1" });
  assert.equal(r.phase, "running");
  assert.deepEqual(types(f.state), []);
});

test("bounded wait: waiting -> completed is seen on a fresh read and only then sent", async (t) => {
  const f = thread([run("a1", { status: "waiting", ordinal: 11 })]);
  f.state.onRead = (s, n) => {
    if (n === 3) s.runs.find((x) => x.id === "a1").status = "completed";
  };
  const r = await sendNow(f.deps(journalIn(t)), { threadId: "t-1", queuedRunId: "q1", waitSeconds: 30, pollSeconds: 2 });
  assert.equal(r.outcome, "delivered");
  assert.deepEqual(types(f.state), ["queued-run.start"]);
  // reads 1-2 saw waiting, read 3 saw stopped and preceded the send; then verification.
  assert.ok(f.state.reads.length >= 3);
});

test("bounded wait: a thread that never stops is deferred at the deadline with a bounded number of reads (defect 4)", async (t) => {
  const f = thread([run("a1", { status: "waiting", ordinal: 11 })]);
  const r = await sendNow(f.deps(journalIn(t)), { threadId: "t-1", queuedRunId: "q1", waitSeconds: 20, pollSeconds: 2 });
  assert.equal(r.outcome, "deferred");
  assert.equal(r.reason, "thread_waiting");
  assert.equal(r.reads, 10, "one read now and one per 2 s poll while a read still fits in 20 s");
  assert.ok(r.waitedMs <= 20_000);
  assert.deepEqual(types(f.state), []);
});

test("bounded wait never exceeds the per-call read budget, whatever the settings", async (t) => {
  const f = thread([run("a1", { status: "running", ordinal: 11 })]);
  const r = await sendNow(f.deps(journalIn(t)), { threadId: "t-1", queuedRunId: "q1", waitSeconds: 120, pollSeconds: 1 });
  assert.equal(r.outcome, "deferred");
  assert.ok(r.reads <= MAX_READS_PER_CALL, `${r.reads} reads`);
  assert.ok(f.state.reads.every((x) => x.bounded), "no full projection while waiting");
});

test("revalidation: the run that was queued at the first read is started by T3 meanwhile: nothing sent", async (t) => {
  const f = thread([run("a1", { status: "running", ordinal: 11 })]);
  f.state.onRead = (s, n) => {
    if (n === 2) {
      s.runs.find((x) => x.id === "a1").status = "completed";
      Object.assign(s.runs.find((x) => x.id === "q1"), { status: "running", startedAt: iso(NOW) });
    }
  };
  const r = await sendNow(f.deps(journalIn(t)), { threadId: "t-1", queuedRunId: "q1", waitSeconds: 10, pollSeconds: 2 });
  assert.equal(r.outcome, "delivered");
  assert.equal(r.reason, "already_started");
  assert.deepEqual(types(f.state), []);
});

test("revalidation: another run starts between rounds (stopped -> starting): no send", async (t) => {
  const f = thread([run("a1", { status: "completed", ordinal: 9 })]);
  f.state.onRead = (s, n) => {
    if (n === 1) s.runs.push(run("auto9", { status: "starting", ordinal: 12 }));
  };
  const r = await sendNow(f.deps(journalIn(t)), { threadId: "t-1", queuedRunId: "q1" });
  assert.equal(r.reason, "thread_starting");
  assert.deepEqual(types(f.state), []);
});

test("automatic completions and notifications cannot be sent now", async (t) => {
  const f = fakeThread({
    items: [
      { run: run("auto1", { ordinal: 5 }), message: message("m-auto1", { delegatedCompletion: { parentRunId: "x", generation: 1, taskIds: [] } }) },
      { run: run("note1", { ordinal: 6 }), message: message("m-note1", { notification: { source: { kind: "monitor" } } }) },
    ],
  });
  for (const id of ["auto1", "note1"]) {
    const r = await sendNow(f.deps(journalIn(t)), { threadId: "t-1", queuedRunId: id });
    assert.equal(r.outcome, "deferred");
    assert.equal(r.reason, "automatic_run");
  }
  assert.deepEqual(types(f.state), []);
});

test("the five-minute minimum age holds and cannot be lowered", async (t) => {
  const f = fakeThread({ items: [queuedUser("q1", { requestedAt: iso(NOW - 4 * MIN) })] });
  const r = await sendNow(f.deps(journalIn(t)), { threadId: "t-1", queuedRunId: "q1", minAgeSeconds: 60 });
  assert.equal(r.outcome, "deferred");
  assert.equal(r.reason, "too_recent");
  assert.match(r.detail, /minimum is 300s/);
  assert.deepEqual(types(f.state), []);
});

test("held queue: deferred unless releaseHold, because starting releases every hold", async (t) => {
  const f = fakeThread({ items: [queuedUser("q1", { queueHeld: true }), queuedUser("q2", { queueHeld: true, ordinal: 12 })] });
  const held = await sendNow(f.deps(journalIn(t)), { threadId: "t-1", queuedRunId: "q1" });
  assert.equal(held.reason, "queue_held");
  assert.deepEqual(types(f.state), []);
  const released = await sendNow(f.deps(journalIn(t)), { threadId: "t-1", queuedRunId: "q1", releaseHold: true });
  assert.equal(released.outcome, "delivered");
  assert.equal(f.state.runs.find((x) => x.id === "q2").queueHeld, false, "T3 released the other hold too");
});

test("parked thread: never read, never started or released", async (t) => {
  const f = thread();
  const r = await sendNow(f.deps(journalIn(t), { parked: ["t-1"] }), { threadId: "t-1", queuedRunId: "q1", releaseHold: true });
  assert.equal(r.outcome, "deferred");
  assert.equal(r.reason, "thread_parked");
  assert.equal(f.state.reads.length, 0);
  assert.deepEqual(types(f.state), []);
});

test("without queuedRunId: the oldest eligible user message, never an automatic one", async (t) => {
  const f = fakeThread({
    items: [
      { run: run("auto1", { ordinal: 1, requestedAt: iso(NOW - 90 * MIN) }), message: message("m-auto1", { delegatedCompletion: { parentRunId: "x", generation: 1, taskIds: [] } }) },
      queuedUser("young", { ordinal: 2, requestedAt: iso(NOW - 2 * MIN) }),
      queuedUser("old", { ordinal: 9, requestedAt: iso(NOW - 60 * MIN) }),
      queuedUser("mid", { ordinal: 3, requestedAt: iso(NOW - 20 * MIN) }),
    ],
  });
  const r = await sendNow(f.deps(journalIn(t)), { threadId: "t-1" });
  assert.equal(r.outcome, "delivered");
  assert.equal(f.state.dispatched[0].runId, "old");
});

test("a run no longer queued: completed is reported delivered, cancelled is deferred, nothing sent", async (t) => {
  const f = fakeThread({ runs: [run("c1", { status: "completed" }), run("x1", { status: "cancelled" })] });
  const done = await sendNow(f.deps(journalIn(t)), { threadId: "t-1", queuedRunId: "c1" });
  assert.equal(done.outcome, "delivered");
  assert.equal(done.reason, "already_started");
  const gone = await sendNow(f.deps(journalIn(t)), { threadId: "t-1", queuedRunId: "x1" });
  assert.equal(gone.outcome, "deferred");
  assert.equal(gone.reason, "run_not_queued");
  assert.deepEqual(types(f.state), []);
});

test("T3 rejects (thread became active between read and send): deferred, journal resolved rejected", async (t) => {
  const f = thread();
  f.state.behaviours.push("reject");
  const journal = journalIn(t);
  const r = await sendNow(f.deps(journal), { threadId: "t-1", queuedRunId: "q1" });
  assert.equal(r.outcome, "deferred");
  assert.equal(r.reason, "rejected_by_t3");
  assert.equal(journal.open().length, 0);
  assert.equal(f.state.runs.find((x) => x.id === "q1").status, "queued", "content still queued");
});

test("connection refused: deferred t3_unreachable, nothing quarantined", async (t) => {
  const f = thread();
  f.state.behaviours.push("not_sent");
  const journal = journalIn(t);
  const r = await sendNow(f.deps(journal), { threadId: "t-1", queuedRunId: "q1" });
  assert.equal(r.reason, "t3_unreachable");
  assert.equal(journal.open().length, 0);
});

test("timeout after send, applied: reconciled from state, never sent again", async (t) => {
  const f = thread();
  f.state.behaviours.push("apply_then_timeout");
  const journal = journalIn(t);
  const r = await sendNow(f.deps(journal), { threadId: "t-1", queuedRunId: "q1" });
  assert.equal(r.outcome, "delivered");
  assert.equal(r.reason, "started");
  assert.equal(f.state.dispatched.length, 1, "no retry once state proves it");
  assert.equal(journal.open().length, 0);
});

test("timeout after send, not applied: replayed with the same commandId (never a new one), applied once", async (t) => {
  const f = thread();
  f.state.behaviours.push("drop");
  const journal = journalIn(t);
  const r = await sendNow(f.deps(journal), { threadId: "t-1", queuedRunId: "q1" });
  assert.equal(r.outcome, "delivered");
  assert.equal(f.state.dispatched.length, 2);
  assert.equal(f.state.dispatched[0].commandId, f.state.dispatched[1].commandId);
  assert.deepEqual(f.state.dispatched[0], f.state.dispatched[1], "the replay is the same command");
});

test("timeout after an accepted start that left the run queued: stays open (unknown); reconcile replays the same id and starts it", async (t) => {
  const f = thread();
  f.state.behaviours.push("apply_no_start_then_timeout", "apply_no_start");
  const journal = journalIn(t);
  const r = await sendNow(f.deps(journal), { threadId: "t-1", queuedRunId: "q1", verifySeconds: 2 });
  assert.equal(r.outcome, "unknown");
  assert.equal(r.reason, "accepted_not_started");
  assert.equal(f.state.receipts.size, 1, "one receipt: applied once");
  assert.equal(journal.open().length, 1, "not delivered yet: the record stays open");
  const again = await sendNow(f.deps(journal), { threadId: "t-1", queuedRunId: "q1" });
  assert.equal(again.reason, "quarantined", "no new commandId while it is open");
  const rec = await reconcileQueuedRun(f.deps(journal), journal.get("t-1", "q1"), { allowReplay: true });
  assert.equal(rec.outcome, "delivered");
  assert.equal(new Set(f.state.dispatched.map((d) => d.commandId)).size, 1);
  assert.equal(journal.open().length, 0);
});

test("a replay refused for authorization (or a refused connection) does not clear the quarantine", async (t) => {
  const f = thread();
  f.state.behaviours.push("drop", "drop");
  const journal = journalIn(t);
  await sendNow(f.deps(journal), { threadId: "t-1", queuedRunId: "q1" });
  for (const behaviour of ["auth", "not_sent"]) {
    f.state.behaviours.push(behaviour);
    const rec = await reconcileQueuedRun(f.deps(journal), journal.get("t-1", "q1"), { allowReplay: true });
    assert.equal(rec.outcome, "unknown", behaviour);
    assert.equal(journal.open().length, 1, behaviour);
  }
});

test("timeout, then the replay times out too: unknown, quarantined; later sends refuse without sending", async (t) => {
  const f = thread();
  f.state.behaviours.push("drop", "drop");
  const journal = journalIn(t);
  const r = await sendNow(f.deps(journal), { threadId: "t-1", queuedRunId: "q1" });
  assert.equal(r.outcome, "unknown");
  assert.equal(r.reason, "replay_failed");
  assert.equal(journal.open().length, 1);
  assert.equal(journal.open()[0].status, "unknown");

  const again = await sendNow(f.deps(journal), { threadId: "t-1", queuedRunId: "q1" });
  assert.equal(again.outcome, "unknown");
  assert.equal(again.reason, "quarantined");
  assert.equal(f.state.dispatched.length, 2, "no third send");
});

test("quarantine survives its owner process exiting and the message staying queued", async (t) => {
  const dir = tempDir(t);
  const f = thread();
  f.state.behaviours.push("drop", "drop");
  const owner = new DeliveryJournal(dir, { pid: 999_999_999, host: "this-host", instance: "dead-owner" });
  const first = await sendNow(f.deps(owner), { threadId: "t-1", queuedRunId: "q1" });
  assert.equal(first.outcome, "unknown");
  // Another process on the same host, while the first one is gone and q1 is still queued.
  const other = new DeliveryJournal(dir, { host: "this-host" });
  assert.equal(other.ownerAlive(other.get("t-1", "q1")), false);
  assert.equal(f.state.runs.find((x) => x.id === "q1").status, "queued");
  const r = await sendNow(f.deps(other), { threadId: "t-1", queuedRunId: "q1" });
  assert.equal(r.outcome, "unknown");
  assert.equal(r.reason, "quarantined");
  // Reconcile without replay: still queued proves nothing, so the record stays.
  const rec = await reconcileQueuedRun(f.deps(other), other.get("t-1", "q1"), { allowReplay: false });
  assert.equal(rec.outcome, "unknown");
  assert.equal(rec.reason, "still_queued");
  assert.equal(other.open().length, 1);
  // Reconcile with replay: T3 answers by commandId; the record resolves on that proof.
  const proven = await reconcileQueuedRun(f.deps(other), other.get("t-1", "q1"), { allowReplay: true });
  assert.equal(proven.outcome, "delivered");
  assert.equal(other.open().length, 0);
  const ids = new Set(f.state.dispatched.map((d) => d.commandId));
  assert.equal(ids.size, 1, "every attempt used the one commandId");
});

test("reconcile: a replay T3 previously rejected resolves as rejected; the message stays queued", async (t) => {
  const f = thread();
  // The send was rejected but its answer was lost, and the replay's answer was lost too.
  f.state.behaviours.push("reject_then_timeout", "drop");
  const journal = journalIn(t);
  const r = await sendNow(f.deps(journal), { threadId: "t-1", queuedRunId: "q1" });
  assert.equal(r.outcome, "unknown");
  const rec = await reconcileQueuedRun(f.deps(journal), journal.get("t-1", "q1"), { allowReplay: true });
  assert.equal(rec.outcome, "deferred");
  assert.equal(rec.reason, "rejected_by_t3");
  assert.match(rec.detail, /previously rejected/);
  assert.equal(journal.open().length, 0);
  assert.equal(f.state.runs.find((x) => x.id === "q1").status, "queued");
});

test("reconcile does not replay when the queued message changed since the send", async (t) => {
  const f = thread();
  f.state.behaviours.push("drop", "drop");
  const journal = journalIn(t);
  await sendNow(f.deps(journal), { threadId: "t-1", queuedRunId: "q1" });
  f.state.messages.find((m) => m.id === "m-q1").text = "edited after the send";
  const sent = f.state.dispatched.length;
  const rec = await reconcileQueuedRun(f.deps(journal), journal.get("t-1", "q1"), { allowReplay: true });
  assert.equal(rec.outcome, "unknown");
  assert.equal(rec.reason, "replay_unsafe");
  assert.equal(f.state.dispatched.length, sent);
});

test("duplicate prevention: two concurrent send_now calls for one run send one command", async (t) => {
  const f = thread();
  const journal = journalIn(t);
  let release;
  const gate = new Promise((r) => (release = r));
  const slow = { ...f.client, dispatch: async (cmd) => { await gate; return f.client.dispatch(cmd); } };
  const d = { ...f.deps(journal), client: slow };
  const first = sendNow(d, { threadId: "t-1", queuedRunId: "q1" });
  await new Promise((r) => setImmediate(r));
  const second = await sendNow(d, { threadId: "t-1", queuedRunId: "q1" });
  release();
  const r1 = await first;
  assert.equal(r1.outcome, "delivered");
  assert.equal(second.outcome, "unknown");
  assert.equal(second.reason, "in_flight");
  assert.equal(f.state.dispatched.length, 1);
});

test("a failed read is deferred (nothing sent), never an empty queue", async (t) => {
  const f = thread();
  f.state.failReads = 1;
  const r = await sendNow(f.deps(journalIn(t)), { threadId: "t-1", queuedRunId: "q1" });
  assert.equal(r.outcome, "deferred");
  assert.equal(r.reason, "read_failed");
  assert.deepEqual(types(f.state), []);
});

test("an accepted send whose verification read fails is unknown and stays open until reconciled", async (t) => {
  const f = thread();
  f.state.onRead = (s, n) => {
    if (n === 2) s.failReads = 5;
  };
  const journal = journalIn(t);
  const r = await sendNow(f.deps(journal), { threadId: "t-1", queuedRunId: "q1" });
  assert.equal(r.outcome, "unknown");
  assert.equal(r.reason, "accepted_unverified");
  assert.equal(journal.open().length, 1);
  assert.equal(journal.open()[0].status, "unknown");
  f.state.failReads = 0;
  const rec = await reconcileQueuedRun(f.deps(journal), journal.get("t-1", "q1"), { allowReplay: false });
  assert.equal(rec.outcome, "delivered", "state proves it: the run started");
  assert.equal(journal.open().length, 0);
  assert.equal(f.state.dispatched.length, 1);
});

test("T3's failure answer alone is not proof: the same commandId is replayed and the receipt decides", async (t) => {
  const f = thread([run("a1", { status: "starting", ordinal: 11 })]);
  // The read showed a stopped thread, but a run started before the send landed.
  f.state.onRead = (s, n) => {
    if (n === 1) s.runs.find((x) => x.id === "a1").status = "completed";
  };
  const journal = journalIn(t);
  const d = f.deps(journal);
  const r = await sendNow({ ...d, client: { ...f.client, dispatch: async (cmd) => {
    if (f.state.dispatched.length === 0) f.state.runs.find((x) => x.id === "a1").status = "starting";
    return f.client.dispatch(cmd);
  } } }, { threadId: "t-1", queuedRunId: "q1" });
  assert.equal(r.outcome, "deferred");
  assert.equal(r.reason, "rejected_by_t3");
  assert.match(r.detail, /previously rejected/);
  assert.deepEqual(f.state.dispatched.map((x) => x.commandId), [f.state.dispatched[0].commandId, f.state.dispatched[0].commandId]);
  assert.equal(journal.open().length, 0);
});

test("deadline: every read's timeout fits the remaining budget, and nothing is sent after it", async (t) => {
  const f = thread([run("a1", { status: "running", ordinal: 11 })]);
  // Each read hangs for its whole timeout (but answers), and the thread never stops.
  f.state.onRead = (s) => {
    f.clock.t += s.reads.at(-1).timeoutMs;
  };
  const d = { ...f.deps(journalIn(t)), readTimeoutMs: 65_000 };
  const start = f.clock.t;
  const r = await sendNow(d, { threadId: "t-1", queuedRunId: "q1", waitSeconds: 120, pollSeconds: 3 });
  assert.equal(r.outcome, "deferred");
  assert.ok(f.clock.t - start <= 120_000 + 1_000, `took ${f.clock.t - start} ms`);
  for (const read of f.state.reads) assert.ok(read.timeoutMs <= 65_000);
  assert.deepEqual(types(f.state), []);
});

test("deadline: with waitSeconds 120 and 65-second reads, a send never goes out after 120 s", async (t) => {
  const f = thread([run("a1", { status: "running", ordinal: 11 })]);
  const sentAt = [];
  f.state.onRead = (s, n) => {
    f.clock.t += s.reads.at(-1).timeoutMs;
    if (n === 2) s.runs.find((x) => x.id === "a1").status = "completed";
  };
  const start = f.clock.t;
  const d = f.deps(journalIn(t));
  const r = await sendNow({ ...d, readTimeoutMs: 65_000, client: { ...f.client, dispatch: async (cmd) => { sentAt.push(f.clock.t - start); return f.client.dispatch(cmd); } } },
    { threadId: "t-1", queuedRunId: "q1", waitSeconds: 120, pollSeconds: 3, verifySeconds: 0 });
  assert.ok(sentAt.every((ms) => ms <= 120_000), `sent at ${sentAt}`);
  assert.ok(["delivered", "deferred"].includes(r.outcome));
});

test("deadline: a read that answers after the send deadline is not acted on", async (t) => {
  const f = thread([run("a1", { status: "running", ordinal: 11 })]);
  f.state.onRead = (s, n) => {
    if (n === 2) {
      f.clock.t += 400_000; // a clock jump: the answer arrives long after the deadline
      s.runs.find((x) => x.id === "a1").status = "completed";
    }
  };
  const r = await sendNow({ ...f.deps(journalIn(t)), readTimeoutMs: 30_000 }, { threadId: "t-1", queuedRunId: "q1", waitSeconds: 10, pollSeconds: 2 });
  assert.equal(r.outcome, "deferred");
  assert.equal(r.reason, "deadline_reached");
  assert.deepEqual(types(f.state), []);
});

test("the five-minute floor is exact: 299.9 s is too recent", async (t) => {
  const f = fakeThread({ items: [queuedUser("q1", { requestedAt: iso(NOW - 299_900) })] });
  const r = await sendNow(f.deps(journalIn(t)), { threadId: "t-1", queuedRunId: "q1" });
  assert.equal(r.reason, "too_recent");
  assert.deepEqual(types(f.state), []);
});

test("deadline: a send whose answer is lost after the deadline is not replayed; the record stays open", async (t) => {
  const f = thread();
  f.state.behaviours.push("drop");
  const d = f.deps(journalIn(t));
  // The command goes out at once, but its answer is lost only after a 30 s RPC timeout.
  const slow = { ...f.client, dispatch: async (cmd) => { f.clock.t += 30_000; return f.client.dispatch(cmd); } };
  const r = await sendNow({ ...d, client: slow }, { threadId: "t-1", queuedRunId: "q1", waitSeconds: 1 });
  assert.equal(r.outcome, "unknown");
  assert.equal(r.reason, "deadline_reached");
  assert.equal(f.state.dispatched.length, 1, "no replay after the send deadline");
  assert.equal(d.journal.open().length, 1);
});

test("deadline: verification never runs past verifySeconds, even with reads that hang", async (t) => {
  const f = thread();
  f.state.behaviours.push("apply_no_start");
  let verifyStart;
  f.state.onRead = (s, n) => {
    if (n === 1) return;
    verifyStart ??= f.clock.t;
    f.clock.t += s.reads.at(-1).timeoutMs;
  };
  const r = await sendNow({ ...f.deps(journalIn(t)), readTimeoutMs: 65_000 }, { threadId: "t-1", queuedRunId: "q1", verifySeconds: 30 });
  assert.equal(r.outcome, "unknown");
  assert.equal(r.reason, "accepted_not_started");
  assert.ok(f.clock.t - verifyStart <= 30_000, `verification took ${f.clock.t - verifyStart} ms`);
});

test("deadline: a replay never runs past the send deadline, and a second replay is not started after it", async (t) => {
  const f = thread();
  const d = f.deps(journalIn(t));
  const answeredFailure = () => new T3Error("T3 RPC orchestration.dispatchCommand failed: internal", { outcome: "ambiguous", answered: true });
  let calls = 0;
  const client = {
    ...f.client,
    dispatch: async (cmd, opts = {}) => {
      f.state.dispatched.push(cmd);
      f.state.dispatchTimeouts.push(opts.timeoutMs);
      calls++;
      // The original's failure answer arrives after 29.5 s; the replay hangs until its timeout.
      f.clock.t += calls === 1 ? 29_500 : opts.timeoutMs;
      throw answeredFailure();
    },
  };
  const start = f.clock.t;
  const r = await sendNow({ ...d, client, readTimeoutMs: 30_000, rpcTimeoutMs: 30_000 }, { threadId: "t-1", queuedRunId: "q1" });
  assert.equal(r.outcome, "unknown");
  assert.equal(calls, 2, "the original and one replay; no second replay after the deadline");
  assert.ok(f.state.dispatchTimeouts[1] <= 500, `replay timeout ${f.state.dispatchTimeouts[1]}`);
  assert.ok(f.clock.t - start <= 30_000, "nothing ran past the send deadline");
  assert.equal(d.journal.open().length, 1);
});

test("deadline: if the journal claim uses up the time, nothing is sent and the claim is released", async (t) => {
  const f = thread();
  class SlowJournal extends DeliveryJournal {
    claim(input) {
      f.clock.t += 31_000;
      return super.claim(input);
    }
  }
  const journal = new SlowJournal(tempDir(t));
  const r = await sendNow({ ...f.deps(journal), readTimeoutMs: 30_000 }, { threadId: "t-1", queuedRunId: "q1" });
  assert.equal(r.outcome, "deferred");
  assert.equal(r.reason, "deadline_reached");
  assert.deepEqual(types(f.state), []);
  assert.equal(journal.open().length, 0);
});

for (const ms of [100, 500, 999]) {
  test(`a configured HTTP timeout of ${ms} ms still allows reads and delivery, even after time has passed`, async (t) => {
    const f = thread();
    const d = f.deps(journalIn(t));
    // Time passes before the first read (the journal check, a slow event loop).
    const now = d.now;
    let first = true;
    const r = await sendNow({ ...d, readTimeoutMs: ms, now: () => (first ? ((first = false), now()) : now() + 1) }, { threadId: "t-1", queuedRunId: "q1" });
    assert.equal(r.outcome, "delivered", r.reason);
    assert.ok(f.state.reads.length > 0);
    assert.ok(f.state.reads.every((x) => x.timeoutMs <= ms));
  });
}

test("reconcile_send verifies within verifySeconds after a replay, whatever the read timeout", async (t) => {
  const f = thread();
  f.state.behaviours.push("drop", "drop");
  const journal = journalIn(t);
  await sendNow(f.deps(journal), { threadId: "t-1", queuedRunId: "q1" });
  f.state.behaviours.push("apply_no_start");
  let replayedAt;
  const client = { ...f.client, dispatch: async (cmd, o) => { const r = await f.client.dispatch(cmd, o); replayedAt = f.clock.t; return r; } };
  f.state.onRead = (s) => { if (replayedAt !== undefined) f.clock.t += s.reads.at(-1).timeoutMs; };
  const rec = await reconcileQueuedRun({ ...f.deps(journal), client, readTimeoutMs: 65_000 }, journal.get("t-1", "q1"), { allowReplay: true, verifySeconds: 1 });
  assert.equal(rec.outcome, "unknown");
  assert.ok(f.clock.t - replayedAt <= 1_000, `verification took ${f.clock.t - replayedAt} ms`);
  assert.equal(journal.open().length, 1);
});

test("deadline: a connection that opens after the send deadline sends nothing (not a late send)", async (t) => {
  const f = thread();
  f.state.openMs = 1_200;
  const journal = journalIn(t);
  const r = await sendNow({ ...f.deps(journal), readTimeoutMs: 30_000 }, { threadId: "t-1", queuedRunId: "q1", waitSeconds: 1 });
  assert.equal(r.outcome, "deferred");
  assert.equal(r.reason, "deadline_reached");
  assert.equal(f.state.notSentLate, 1);
  assert.deepEqual(types(f.state), []);
  assert.equal(f.state.runs.find((x) => x.id === "q1").status, "queued");
  assert.equal(journal.open().length, 0);
});
