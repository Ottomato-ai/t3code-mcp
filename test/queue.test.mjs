// Queue model (src/queue.ts) and the queue_status tool (defect 2: lightweight queue reads).
import { test } from "node:test";
import assert from "node:assert/strict";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { queueView, runStateOf, deliveryOrder, sha256 } from "../dist/queue.js";
import { registerQueueTools } from "../dist/tools/queue.js";
import { DeliveryJournal } from "../dist/delivery/journal.js";
import { fakeThread, queuedUser, run, message, NOW, MIN, iso } from "./fake-t3.mjs";
import { parse, tempDir } from "./helpers.mjs";

const auto = (id, ordinal, over = {}) => ({
  run: run(id, { ordinal, ...over }),
  message: message(`m-${id}`, { createdBy: "agent", creationSource: "server", delegatedCompletion: { parentRunId: "p", generation: 1, taskIds: ["n"] } }),
});
const note = (id, ordinal, over = {}) => ({ run: run(id, { ordinal, ...over }), message: message(`m-${id}`, { notification: { source: { kind: "monitor" } } }) });

test("every run status maps to one phase; only no active run is stopped", () => {
  const cases = {
    stopped: ["completed", "interrupted", "failed", "cancelled", "rolled_back", "queued"],
    preparing: ["preparing"],
    starting: ["starting"],
    running: ["running"],
    waiting: ["waiting"],
  };
  for (const [phase, statuses] of Object.entries(cases)) {
    for (const status of statuses) {
      const s = runStateOf([{ id: "r", status }]);
      assert.equal(s.phase, phase, status);
      assert.equal(s.canStartQueuedRun, phase === "stopped", status);
    }
  }
  assert.equal(runStateOf([]).phase, "stopped");
});

test("delivery order mirrors T3: automatic completions first, then queuePosition (else ordinal), then ordinal", () => {
  const e = (runId, kind, queuePosition, ordinal) => ({ runId, kind, queuePosition, ordinal });
  const ordered = deliveryOrder([
    e("user-old", "user", 820, 3756),
    e("auto-new", "automatic", 1038, 4173),
    e("note", "notification", 120, 2377),
    e("auto-old", "automatic", null, 4100),
    e("user-new", "user", null, 4266),
  ]);
  assert.deepEqual(ordered.map((x) => x.runId), ["auto-new", "auto-old", "note", "user-old", "user-new"]);
});

test("a CP6-shaped backlog: user messages behind automatic completions are flagged with their wait", () => {
  const items = [];
  for (let i = 0; i < 45; i++) items.push(auto(`a${i}`, 4174 + i, { requestedAt: iso(NOW - (60 - i) * MIN) }));
  items.push(queuedUser("u3756", { ordinal: 3756, queuePosition: 820, requestedAt: iso(NOW - 7 * 60 * MIN) }));
  items.push(note("n2377", 2377, { queuePosition: 120 }));
  const f = fakeThread({ items, runs: [run("active", { status: "running", ordinal: 5000 })] });
  const v = queueView(f.snapshot(), { nowMs: NOW });
  assert.equal(v.counts.total, 47);
  assert.deepEqual([v.counts.automatic, v.counts.user, v.counts.notification], [45, 1, 1]);
  assert.equal(v.entries[0].kind, "automatic");
  const user = v.entries.find((x) => x.runId === "u3756");
  assert.equal(user.deliveryIndex, 47);
  assert.equal(user.automaticAhead, 45);
  assert.equal(v.starvation.entriesBehindAutomatic, 2);
  assert.equal(v.starvation.oldestWaitingSeconds, 7 * 3600);
  assert.equal(v.runState.phase, "running");
  assert.equal(v.nextToRun, "a0");
});

test("held runs: nextToRun skips them; queueHeld reports any hold", () => {
  const f = fakeThread({ items: [queuedUser("h1", { ordinal: 1, queueHeld: true }), queuedUser("u2", { ordinal: 2 })] });
  const v = queueView(f.snapshot(), { nowMs: NOW });
  assert.equal(v.queueHeld, true);
  assert.equal(v.nextToRun, "u2");
  assert.equal(v.counts.held, 1);
});

test("text: truncated for display, but the SHA-256 is of the full text (content preservation checks)", () => {
  const long = "x".repeat(5000);
  const f = fakeThread({ items: [queuedUser("u1", {}, { text: long })] });
  const v = queueView(f.snapshot(), { nowMs: NOW, maxTextChars: 100 });
  assert.equal(v.entries[0].text.length, 101);
  assert.equal(v.entries[0].textLength, 5000);
  assert.equal(v.entries[0].textSha256, sha256(long));
});

test("a queued run whose message is missing is flagged, never silently classified", () => {
  const f = fakeThread({ runs: [run("orphan", { ordinal: 3 })] });
  const v = queueView(f.snapshot(), { nowMs: NOW });
  assert.equal(v.entries[0].messageMissing, true);
  assert.equal(v.orderUncertain, true);
});

async function tool(t, f) {
  const server = new McpServer({ name: "test", version: "0" });
  registerQueueTools(server, () => f.client, () => ({ journal: new DeliveryJournal(tempDir(t)), parked: new Set() }));
  const mcp = new Client({ name: "c", version: "0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), mcp.connect(b)]);
  t.after(() => mcp.close());
  return async (name, args) => parse(await mcp.callTool({ name, arguments: args }));
}

test("queue_status: one bounded read, pages the queue, reports the starvation note", async (t) => {
  const items = [];
  for (let i = 0; i < 230; i++) items.push(auto(`a${i}`, 100 + i));
  items.push(queuedUser("u1", { ordinal: 50 }));
  const f = fakeThread({ items });
  const call = await tool(t, f);
  const first = await call("queue_status", { threadId: "t-1", limit: 100, includeText: false });
  assert.equal(f.state.reads.length, 1);
  assert.equal(f.state.reads[0].bounded, true, "bounded snapshot, not the full history");
  assert.equal(first.total, 231);
  assert.equal(first.shown, 100);
  assert.equal(first.hasMore, true);
  assert.equal(first.entries[0].text, undefined);
  assert.match(first.starvation.note, /automatic completion/);
  const seen = [...first.entries];
  let page = first;
  while (page.hasMore) {
    page = await call("queue_status", { threadId: "t-1", limit: 100, cursor: page.nextCursor });
    seen.push(...page.entries);
    assert.equal(page.consistentSinceFirstPage, true);
  }
  assert.equal(seen.length, 231);
  assert.equal(new Set(seen.map((e) => e.runId)).size, 231);
  assert.equal(seen.at(-1).runId, "u1");
});

test("queue_status: a failed read is an error, not an empty queue", async (t) => {
  const f = fakeThread({ items: [queuedUser("u1")] });
  f.state.failReads = 1;
  const call = await tool(t, f);
  const r = await call("queue_status", { threadId: "t-1" });
  assert.equal(r.isError, true);
});
