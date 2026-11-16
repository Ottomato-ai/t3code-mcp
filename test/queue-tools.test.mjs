// list_queued_messages, cancel_queued_message, edit_queued_message: in-memory MCP client, fake T3.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerQueue } from "../dist/tools/queue.js";
import { LaunchDesk } from "../dist/desk/desk.js";
import { DeskStore } from "../dist/desk/store.js";
import { T3Error } from "../dist/client.js";
import { fakeClient, parse, tempDir, T0 } from "./helpers.mjs";
import { v2Detail, v2QueueDetail, LONG_TEXT } from "./v2-fixtures.mjs";

async function setup(t, opts = {}) {
  const t3 = fakeClient(opts);
  const store = new DeskStore(tempDir(t));
  const desk = new LaunchDesk({
    store,
    cap: 5,
    readMemory: () => ({ status: "ok", commitPercent: 50, blocks: false, detail: null }),
    now: () => T0,
    pollMs: 20,
    shellIntervalMs: 0,
  });
  const server = new McpServer({ name: "test", version: "0" });
  registerQueue(server, () => t3, () => desk);
  const client = new Client({ name: "test-client", version: "0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  t.after(() => client.close());
  const call = async (name, args) => parse(await client.callTool({ name, arguments: args }));
  const events = () =>
    existsSync(store.eventsFile)
      ? readFileSync(store.eventsFile, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l))
      : [];
  return { t3, call, events };
}

const busy = () => ({ running: ["t-q"], details: { "t-q": v2QueueDetail() } });
const OPEN = "<untrusted-data>";
const CLOSE = "</untrusted-data>";
const inner = (s) => {
  assert.ok(s.startsWith(OPEN) && s.endsWith(CLOSE), `wrapped as untrusted: ${s}`);
  return s.slice(OPEN.length, -CLOSE.length);
};

// ---------- list ----------

test("list with threadId: rows in send order, human fields first, ids last", async (t) => {
  const { call } = await setup(t, busy());
  const r = await call("list_queued_messages", { threadId: "t-q" });
  assert.equal(r.count, 3);
  assert.deepEqual(r.messages.map((m) => m.runId), ["run-q8", "run-q6", "run-q7"]);
  const first = r.messages[0];
  assert.deepEqual(Object.keys(first).slice(0, 6), ["thread", "project", "position", "age", "queuedAt", "sender"]);
  assert.deepEqual(Object.keys(first).slice(-2), ["threadId", "runId"]);
  assert.equal(first.thread, "busy thread");
  assert.equal(first.project, "Scratch");
  assert.equal(first.position, 1);
  assert.equal(first.sender, "user via web");
  assert.equal(r.messages[1].sender, "user via mcp");
  assert.equal(typeof first.age, "string");
  assert.match(r.spoken, /3 queued messages/);
  assert.match(r.note, /untrusted-data/);
});

test("list wraps message text as untrusted data and truncates at 300 characters", async (t) => {
  const { call } = await setup(t, busy());
  const r = await call("list_queued_messages", { threadId: "t-q" });
  const [web, , long] = r.messages;
  assert.equal(inner(web.text), "from the web &lt;b&gt;ui&lt;/b&gt;");
  assert.equal(web.truncated, undefined);
  assert.equal(long.truncated, true);
  assert.equal(inner(long.text), `${LONG_TEXT.slice(0, 300)}…`);
});

test("list respects limit but counts every queued message", async (t) => {
  const { call } = await setup(t, busy());
  const r = await call("list_queued_messages", { threadId: "t-q", limit: 1 });
  assert.equal(r.count, 3);
  assert.equal(r.messages.length, 1);
  assert.equal(r.messages[0].position, 1);
});

test("list with threadId and an empty queue says so", async (t) => {
  const { call } = await setup(t, { running: ["t-1"], details: { "t-1": v2Detail() } });
  const r = await call("list_queued_messages", { threadId: "t-1" });
  assert.equal(r.count, 0);
  assert.deepEqual(r.messages, []);
  assert.match(r.spoken, /no queued messages/i);
});

test("list without threadId checks every thread with an active run, one by one", async (t) => {
  const { t3, call } = await setup(t, {
    running: ["t-q", "t-1"],
    details: { "t-q": v2QueueDetail(), "t-1": v2Detail() },
  });
  const r = await call("list_queued_messages", {});
  assert.deepEqual([...t3.state.queueReads].sort(), ["t-1", "t-q"]);
  assert.equal(r.count, 3);
  assert.equal(r.threadsChecked, 2);
  assert.equal(r.capped, undefined);
  assert.match(r.spoken, /3 queued messages on 1 thread/);
});

test("list without threadId stops at 25 threads and says it was capped", async (t) => {
  const ids = Array.from({ length: 30 }, (_, i) => `t-${i}`);
  const { t3, call } = await setup(t, { running: ids, details: Object.fromEntries(ids.map((id) => [id, v2Detail()])) });
  const r = await call("list_queued_messages", {});
  assert.equal(t3.state.queueReads.length, 25);
  assert.equal(r.threadsChecked, 25);
  assert.equal(r.capped, true);
  assert.match(r.note, /25 of 30/);
});

test("list without threadId reports a thread that could not be read and keeps going", async (t) => {
  const { call } = await setup(t, { running: ["t-q", "gone"], details: { "t-q": v2QueueDetail() } });
  const r = await call("list_queued_messages", {});
  assert.equal(r.count, 3);
  assert.equal(r.unreadable.length, 1);
  assert.equal(r.unreadable[0].threadId, "gone");
  assert.match(r.unreadable[0].error, /No thread gone/);
});

test("list with an unknown threadId fails with how to find one", async (t) => {
  const { call } = await setup(t, busy());
  const r = await call("list_queued_messages", { threadId: "nope" });
  assert.equal(r.isError, true);
  assert.match(r.text, /No thread nope/);
});

// ---------- cancel ----------

test("cancel removes a queued message, re-reads the queue and logs it", async (t) => {
  const { t3, call, events } = await setup(t, busy());
  const r = await call("cancel_queued_message", { threadId: "t-q", runId: "run-q6", lane: "Lane A" });
  assert.equal(r.cancelled, true);
  assert.equal(inner(r.removed), "RESUME now");
  assert.equal(r.remaining, 2);
  assert.equal(r.thread, "busy thread");
  assert.deepEqual(t3.state.dispatched.map((d) => [d.type, d.threadId, d.runId]), [["queued-run.cancel", "t-q", "run-q6"]]);
  assert.equal(t3.state.queueReads.length, 2, "checked before, re-read after");
  const ev = events().filter((e) => e.type === "queue_cancel");
  assert.equal(ev.length, 1);
  assert.equal(ev[0].thread_id, "t-q");
  assert.equal(ev[0].run_id, "run-q6");
  assert.equal(ev[0].lane, "Lane A");
  assert.equal(ev[0].preview, "RESUME now");
  assert.equal(typeof ev[0].at, "string");
});

test("cancel of a running run sends nothing and points to interrupt_thread", async (t) => {
  const { t3, call } = await setup(t, busy());
  const r = await call("cancel_queued_message", { threadId: "t-q", runId: "run-5", lane: "Lane A" });
  assert.equal(r.isError, true);
  assert.match(r.text, /run-5 is running, not queued/);
  assert.match(r.text, /interrupt_thread/);
  assert.deepEqual(t3.state.dispatched, []);
});

test("cancel of a cancelled run sends nothing and says there is nothing to do", async (t) => {
  const { t3, call } = await setup(t, busy());
  const r = await call("cancel_queued_message", { threadId: "t-q", runId: "run-4", lane: "Lane A" });
  assert.equal(r.isError, true);
  assert.match(r.text, /run-4 is cancelled, not queued/);
  assert.match(r.text, /nothing to do/i);
  assert.deepEqual(t3.state.dispatched, []);
});

test("cancel of an unknown run sends nothing and points to list_queued_messages", async (t) => {
  const { t3, call } = await setup(t, busy());
  const r = await call("cancel_queued_message", { threadId: "t-q", runId: "run-x", lane: "Lane A" });
  assert.equal(r.isError, true);
  assert.match(r.text, /No run run-x on thread t-q/);
  assert.match(r.text, /list_queued_messages/);
  assert.deepEqual(t3.state.dispatched, []);
});

test("cancel on an unknown thread fails with how to find one", async (t) => {
  const { call } = await setup(t, busy());
  const r = await call("cancel_queued_message", { threadId: "nope", runId: "run-q6", lane: "Lane A" });
  assert.equal(r.isError, true);
  assert.match(r.text, /No thread nope/);
});

test("cancel that never reached T3 says it was not sent, does not retry, logs the failure", async (t) => {
  const err = new T3Error("Could not open the T3 Code RPC socket.", { notSent: true });
  const { t3, call, events } = await setup(t, { ...busy(), dispatchError: err });
  const r = await call("cancel_queued_message", { threadId: "t-q", runId: "run-q6", lane: "Lane A" });
  assert.equal(r.isError, true);
  assert.match(r.text, /not sent/i);
  assert.match(r.text, /still queued/i);
  assert.deepEqual(t3.state.dispatched, []);
  const ev = events().filter((e) => e.type === "queue_cancel_failed");
  assert.equal(ev.length, 1);
  assert.equal(ev[0].sent, false);
});

test("cancel rejected by T3 after sending surfaces T3's reason", async (t) => {
  const err = new T3Error("T3 RPC orchestration.dispatchCommand failed: Run run-q6 is not queued.");
  const { call, events } = await setup(t, { ...busy(), dispatchError: err });
  const r = await call("cancel_queued_message", { threadId: "t-q", runId: "run-q6", lane: "Lane A" });
  assert.equal(r.isError, true);
  assert.match(r.text, /is not queued/);
  assert.doesNotMatch(r.text, /not sent/i);
  assert.equal(events().filter((e) => e.type === "queue_cancel_failed")[0].sent, true);
});

test("cancel needs a lane", async (t) => {
  const { t3, call } = await setup(t, busy());
  const r = await call("cancel_queued_message", { threadId: "t-q", runId: "run-q6" });
  assert.equal(r.isError, true);
  assert.deepEqual(t3.state.dispatched, []);
});

// ---------- edit ----------

test("edit replaces the text, re-reads it and logs old and new previews", async (t) => {
  const { t3, call, events } = await setup(t, busy());
  const r = await call("edit_queued_message", { threadId: "t-q", runId: "run-q6", message: "RESUME, updated", lane: "Lane A" });
  assert.equal(r.edited, true);
  assert.equal(inner(r.old), "RESUME now");
  assert.equal(inner(r.new), "RESUME, updated");
  assert.equal(r.position, 2);
  assert.deepEqual(t3.state.dispatched.map((d) => [d.type, d.runId, d.text]), [["queued-run.edit", "run-q6", "RESUME, updated"]]);
  const ev = events().filter((e) => e.type === "queue_edit");
  assert.equal(ev.length, 1);
  assert.equal(ev[0].lane, "Lane A");
  assert.equal(ev[0].preview, "RESUME now");
  assert.equal(ev[0].new_preview, "RESUME, updated");
});

test("edit to an empty or blank message is refused and points to cancel_queued_message", async (t) => {
  const { t3, call } = await setup(t, busy());
  for (const message of ["", "   \n"]) {
    const r = await call("edit_queued_message", { threadId: "t-q", runId: "run-q6", message, lane: "Lane A" });
    assert.equal(r.isError, true, JSON.stringify(message));
  }
  const blank = await call("edit_queued_message", { threadId: "t-q", runId: "run-q6", message: "  ", lane: "Lane A" });
  assert.match(blank.text, /cancel_queued_message/);
  assert.deepEqual(t3.state.dispatched, []);
});

test("edit of a run that is not queued sends nothing and names the state", async (t) => {
  const { t3, call } = await setup(t, busy());
  const r = await call("edit_queued_message", { threadId: "t-q", runId: "run-5", message: "x", lane: "Lane A" });
  assert.equal(r.isError, true);
  assert.match(r.text, /run-5 is running, not queued/);
  assert.deepEqual(t3.state.dispatched, []);
});

test("edit that never reached T3 says it was not sent", async (t) => {
  const err = new T3Error("refused", { notSent: true });
  const { call } = await setup(t, { ...busy(), dispatchError: err });
  const r = await call("edit_queued_message", { threadId: "t-q", runId: "run-q6", message: "x", lane: "Lane A" });
  assert.equal(r.isError, true);
  assert.match(r.text, /not sent/i);
  assert.match(r.text, /unchanged/i);
});
