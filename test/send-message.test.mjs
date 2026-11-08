// send_message: idempotent, journaled message dispatch (duplicate prevention, timeout ambiguity).
import { test } from "node:test";
import assert from "node:assert/strict";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerPhase1 } from "../dist/tools/phase1.js";
import { registerQueueTools } from "../dist/tools/queue.js";
import { LaunchDesk } from "../dist/desk/desk.js";
import { DeskStore } from "../dist/desk/store.js";
import { DeliveryJournal } from "../dist/delivery/journal.js";
import { fakeThread, run } from "./fake-t3.mjs";
import { parse, tempDir, T0 } from "./helpers.mjs";

/** A running thread (so no launch gate) backed by the stateful fake. */
async function setup(t) {
  const f = fakeThread({ runs: [run("active", { status: "running", ordinal: 1 })] });
  // send_message reads the legacy detail: a live session keeps the launch desk out of the way.
  f.client.thread = async (id) => ({
    snapshotSequence: 1,
    thread: { id, projectId: "p1", title: "t", runtimeMode: "full-access", interactionMode: "default", createdAt: "", updatedAt: "", session: { threadId: id, status: "running", activeTurnId: "active" }, messages: [], activities: [] },
  });
  const journal = new DeliveryJournal(tempDir(t));
  const desk = new LaunchDesk({ store: new DeskStore(tempDir(t)), cap: 5, readMemory: () => ({ status: "ok", commitPercent: 1, blocks: false, detail: null }), now: () => T0, pollMs: 20, shellIntervalMs: 0 });
  const server = new McpServer({ name: "test", version: "0" });
  const delivery = () => ({ journal, parked: new Set() });
  registerPhase1(server, () => f.client, () => desk, delivery);
  registerQueueTools(server, () => f.client, delivery);
  const mcp = new Client({ name: "c", version: "0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), mcp.connect(b)]);
  t.after(() => mcp.close());
  const call = async (name, args) => parse(await mcp.callTool({ name, arguments: args }));
  const sends = () => f.state.dispatched.filter((d) => d.type === "message.dispatch");
  const userMessages = () => f.state.messages.filter((m) => m.role === "user");
  return { f, journal, call, sends, userMessages };
}

test("without a key: as before, a fresh command and message id per call", async (t) => {
  const { call, sends } = await setup(t);
  const a = await call("send_message", { threadId: "t-1", message: "one" });
  const b = await call("send_message", { threadId: "t-1", message: "two" });
  assert.equal(a.sent, true);
  assert.equal(a.outcome, "delivered");
  assert.notEqual(sends()[0].commandId, sends()[1].commandId);
  assert.match(a.note, /queued the message behind the active run/);
});

test("with an idempotencyKey a retried call is answered from T3's receipt: one message", async (t) => {
  const { call, sends, userMessages } = await setup(t);
  const a = await call("send_message", { threadId: "t-1", message: "deploy at 01:00", idempotencyKey: "cp6-go-0100-a" });
  const b = await call("send_message", { threadId: "t-1", message: "deploy at 01:00", idempotencyKey: "cp6-go-0100-a" });
  assert.equal(a.sent, true);
  assert.equal(b.sent, true);
  assert.equal(sends()[0].commandId, sends()[1].commandId);
  assert.equal(sends()[0].messageId, sends()[1].messageId);
  assert.equal(userMessages().length, 1, "T3 holds one copy");
  assert.equal(a.messageId, b.messageId);
});

test("timeout after send, applied: the message is found in the thread; nothing is sent again", async (t) => {
  const { f, call, sends, userMessages, journal } = await setup(t);
  f.state.behaviours.push("apply_then_timeout");
  const r = await call("send_message", { threadId: "t-1", message: "hello", idempotencyKey: "k-apply-timeout" });
  assert.equal(r.sent, true);
  assert.equal(r.reason, "reconciled_present");
  assert.equal(sends().length, 1);
  assert.equal(userMessages().length, 1);
  assert.equal(journal.open().length, 0);
});

test("timeout after send, not applied: replayed with the same ids, delivered once", async (t) => {
  const { f, call, sends, userMessages } = await setup(t);
  f.state.behaviours.push("drop");
  const r = await call("send_message", { threadId: "t-1", message: "hello" });
  assert.equal(r.sent, true);
  assert.equal(r.reason, "replay_accepted");
  assert.equal(sends().length, 2);
  assert.deepEqual(sends()[0], sends()[1]);
  assert.equal(userMessages().length, 1);
});

test("timeout twice: an error that says not to resend, a quarantined record, and a safe retry with the same key", async (t) => {
  const { f, call, sends, userMessages, journal } = await setup(t);
  f.state.behaviours.push("drop", "drop");
  const r = await call("send_message", { threadId: "t-1", message: "hello", idempotencyKey: "key-twice-0001" });
  assert.equal(r.isError, true);
  assert.match(r.text, /outcome unknown/);
  assert.match(r.text, /Do NOT send this message again/);
  assert.equal(journal.open().length, 1);
  // The same key and text: the retry is the idempotent replay and settles it.
  const again = await call("send_message", { threadId: "t-1", message: "hello", idempotencyKey: "key-twice-0001" });
  assert.equal(again.sent, true);
  assert.equal(new Set(sends().map((s) => s.commandId)).size, 1);
  assert.equal(userMessages().length, 1);
  assert.equal(journal.open().length, 0);
});

test("the same key with different text while unresolved is refused, nothing sent", async (t) => {
  const { f, call, sends } = await setup(t);
  f.state.behaviours.push("drop", "drop");
  await call("send_message", { threadId: "t-1", message: "first text", idempotencyKey: "key-diff-0001" });
  const n = sends().length;
  const r = await call("send_message", { threadId: "t-1", message: "other text", idempotencyKey: "key-diff-0001" });
  assert.equal(r.isError, true);
  assert.match(r.text, /different text/);
  assert.equal(sends().length, n);
});

test("reconcile_send settles a quarantined message only on proof; delivery_journal lists it until then", async (t) => {
  const { f, call, journal } = await setup(t);
  f.state.behaviours.push("drop", "drop");
  const failed = await call("send_message", { threadId: "t-1", message: "hello" });
  const messageId = JSON.parse(failed.text.slice(failed.text.indexOf("{"))).messageId;
  const listed = await call("delivery_journal", {});
  assert.equal(listed.open, 1);
  assert.equal(listed.records[0].status, "unknown");
  const noReplay = await call("reconcile_send", { threadId: "t-1", messageId });
  assert.equal(noReplay.outcome, "unknown");
  assert.equal(journal.open().length, 1);
  const proven = await call("reconcile_send", { threadId: "t-1", messageId, allowReplay: true });
  assert.equal(proven.outcome, "delivered");
  assert.equal(journal.open().length, 0);
});

test("a rejected send is an error and nothing stays quarantined", async (t) => {
  const { f, call, journal } = await setup(t);
  f.state.behaviours.push("reject");
  const r = await call("send_message", { threadId: "t-1", message: "hello" });
  assert.equal(r.isError, true);
  assert.match(r.text, /rejected by test/);
  assert.equal(journal.open().length, 0);
});

test("a retry of an unproven send that is refused (connection or authorization) keeps it unproven", async (t) => {
  const { f, call, journal, userMessages } = await setup(t);
  f.state.behaviours.push("drop", "drop");
  const first = await call("send_message", { threadId: "t-1", message: "hello", idempotencyKey: "key-retry-refused" });
  assert.equal(first.isError, true);
  for (const behaviour of ["not_sent", "auth"]) {
    f.state.behaviours.push(behaviour);
    const r = await call("send_message", { threadId: "t-1", message: "hello", idempotencyKey: "key-retry-refused" });
    assert.equal(r.isError, true, behaviour);
    assert.match(r.text, /retry_not_applied/, behaviour);
    assert.equal(journal.open().length, 1, behaviour);
    assert.equal(journal.open()[0].status, "unknown", behaviour);
  }
  const ok = await call("send_message", { threadId: "t-1", message: "hello", idempotencyKey: "key-retry-refused" });
  assert.equal(ok.sent, true);
  assert.equal(userMessages().length, 1);
});
