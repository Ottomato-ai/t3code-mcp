// MCP tools send orchestration protocol 2 commands. In-memory MCP client, fake T3 client.
import { test } from "node:test";
import assert from "node:assert/strict";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerPhase1 } from "../dist/tools/phase1.js";
import { registerPhase2 } from "../dist/tools/phase2.js";
import { registerPhase3 } from "../dist/tools/phase3.js";
import { LaunchDesk } from "../dist/desk/desk.js";
import { DeskStore } from "../dist/desk/store.js";
import { fakeClient, parse, tempDir, T0 } from "./helpers.mjs";

async function setup(t, opts = {}) {
  const t3 = fakeClient(opts);
  const desk = new LaunchDesk({
    store: new DeskStore(tempDir(t)),
    cap: 5,
    readMemory: () => ({ status: "ok", commitPercent: 50, blocks: false, detail: null }),
    now: () => T0,
    pollMs: 20,
    shellIntervalMs: 0,
  });
  const server = new McpServer({ name: "test", version: "0" });
  registerPhase1(server, () => t3, () => desk);
  registerPhase2(server, () => t3, () => desk);
  registerPhase3(server, () => t3);
  const client = new Client({ name: "test-client", version: "0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  t.after(() => client.close());
  const call = async (name, args) => parse(await client.callTool({ name, arguments: args }));
  return { t3, call };
}

const types = (t3) => t3.state.dispatched.map((d) => d.type);

test("send_message dispatches message.dispatch with the text, starting immediately", async (t) => {
  const { t3, call } = await setup(t, { running: ["th1"] });
  const r = await call("send_message", { threadId: "th1", message: "go on" });
  assert.equal(r.sent, true);
  assert.deepEqual(types(t3), ["message.dispatch"]);
  const c = t3.state.dispatched[0];
  assert.equal(c.threadId, "th1");
  assert.equal(c.text, "go on");
  assert.deepEqual(c.dispatchMode, { type: "start_immediately" });
  assert.equal(c.creationSource, "mcp");
});

test("send_message sets runtime and interaction mode first only when they change", async (t) => {
  const { t3, call } = await setup(t, { running: ["th1"] });
  await call("send_message", { threadId: "th1", message: "x", runtimeMode: "full-access", interactionMode: "default" });
  assert.deepEqual(types(t3), ["message.dispatch"], "same as current: no mode commands");
  t3.state.dispatched.length = 0;
  await call("send_message", { threadId: "th1", message: "x", runtimeMode: "approval-required", interactionMode: "plan" });
  assert.deepEqual(types(t3), ["thread.runtime-mode.set", "thread.interaction-mode.set", "message.dispatch"]);
  assert.equal(t3.state.dispatched[0].runtimeMode, "approval-required");
  assert.equal(t3.state.dispatched[1].interactionMode, "plan");
});

test("create_thread sends thread.create with creation fields, then message.dispatch", async (t) => {
  const { t3, call } = await setup(t);
  const r = await call("create_thread", { projectId: "p1", message: "build it", lane: "Lane A" });
  assert.equal(r.created, true);
  assert.deepEqual(types(t3), ["thread.create", "message.dispatch"]);
  const [create, start] = t3.state.dispatched;
  assert.equal(create.createdBy, "user");
  assert.equal(create.creationSource, "mcp");
  assert.equal("createdAt" in create, false);
  assert.equal(start.threadId, create.threadId);
  assert.equal(start.text, "build it");
});

test("respond_to_approval and respond_to_user_input use runtime-request.respond", async (t) => {
  const { t3, call } = await setup(t);
  await call("respond_to_approval", { threadId: "th1", requestId: "rr-1", decision: "accept" });
  await call("respond_to_user_input", { threadId: "th1", requestId: "rr-2", answers: { q1: "a" } });
  assert.deepEqual(types(t3), ["runtime-request.respond", "runtime-request.respond"]);
  assert.equal(t3.state.dispatched[0].decision, "accept");
  assert.equal(t3.state.dispatched[0].requestId, "rr-1");
  assert.deepEqual(t3.state.dispatched[1].answers, { q1: "a" });
});

test("interrupt_thread interrupts the active run", async (t) => {
  const { t3, call } = await setup(t, { running: ["th1"], activeRunIds: { th1: "run-7" } });
  const r = await call("interrupt_thread", { threadId: "th1" });
  assert.equal(r.interrupted, true);
  assert.deepEqual(types(t3), ["run.interrupt"]);
  assert.equal(t3.state.dispatched[0].runId, "run-7");
});

test("interrupt_thread with no active run says so and sends nothing", async (t) => {
  const { t3, call } = await setup(t, { running: ["th1"] });
  const r = await call("interrupt_thread", { threadId: "th1" });
  assert.equal(r.isError, true);
  assert.match(r.text, /no active run/i);
  assert.deepEqual(types(t3), []);
});

test("stop_thread detaches every provider session", async (t) => {
  const { t3, call } = await setup(t, { running: ["th1"], sessionIds: { th1: ["ps-1", "ps-2"] } });
  const r = await call("stop_thread", { threadId: "th1" });
  assert.equal(r.stopped, true);
  assert.deepEqual(types(t3), ["provider-session.detach", "provider-session.detach"]);
  assert.deepEqual(t3.state.dispatched.map((d) => d.providerSessionId), ["ps-1", "ps-2"]);
});

test("stop_thread with no provider session sends nothing and says it was not running", async (t) => {
  const { t3, call } = await setup(t);
  const r = await call("stop_thread", { threadId: "th9" });
  assert.equal(r.stopped, false);
  assert.match(r.note, /no live provider session/i);
  assert.deepEqual(types(t3), []);
});

test("set_thread_title uses thread.metadata.update; archive keeps thread.archive", async (t) => {
  const { t3, call } = await setup(t);
  await call("set_thread_title", { threadId: "th1", title: "New name" });
  await call("archive_thread", { threadId: "th1" });
  await call("unarchive_thread", { threadId: "th1" });
  assert.deepEqual(types(t3), ["thread.metadata.update", "thread.archive", "thread.unarchive"]);
  assert.equal(t3.state.dispatched[0].title, "New name");
});

test("list_threads asks for archived threads only with includeArchived; search_threads always does", async (t) => {
  const { t3, call } = await setup(t, { running: ["th1"] });
  await call("list_threads", {});
  await call("list_threads", { includeArchived: true });
  await call("search_threads", { query: "thread" });
  assert.deepEqual(t3.state.shellOpts.map((o) => o.includeArchived === true), [false, true, true]);
});
