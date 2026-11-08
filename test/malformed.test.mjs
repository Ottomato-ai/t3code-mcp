// Malformed or failed answers from T3 surface as errors, never as an empty workspace or queue.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { T3Client, T3Error } from "../dist/client.js";
import { registerPhase1 } from "../dist/tools/phase1.js";
import { registerPhase3 } from "../dist/tools/phase3.js";
import { registerQueueTools } from "../dist/tools/queue.js";
import { DeliveryJournal } from "../dist/delivery/journal.js";
import { attachWs, v2Shell, v2Thread, v2Detail } from "./v2-fixtures.mjs";
import { parse, tempDir } from "./helpers.mjs";

const listen = (server) => new Promise((r) => server.listen(0, "127.0.0.1", () => r(server.address().port)));

/** Fake T3 whose answers are set per route: { status, body (string or object) }. */
async function fakeT3(t, routes = {}, onRpc) {
  const server = createServer((req, res) => {
    const path = req.url.split("?")[0];
    const key = Object.keys(routes).find((k) => (k.endsWith("*") ? path.startsWith(k.slice(0, -1)) : k === path));
    const r = key ? routes[key] : { status: 404, body: "not found" };
    res.writeHead(r.status ?? 200, { "content-type": "application/json" }).end(typeof r.body === "string" ? r.body : JSON.stringify(r.body));
  });
  attachWs(server, (msg, send) => {
    if (msg._tag !== "Request") return;
    if (onRpc) return onRpc(msg, send);
    send({ _tag: "Exit", requestId: msg.id, exit: { _tag: "Success", value: { sequence: 1 } } });
  });
  const port = await listen(server);
  t.after(() => new Promise((r) => { server.closeAllConnections?.(); server.close(() => r()); }));
  return new T3Client(`http://127.0.0.1:${port}`, "tok", { httpMs: 2000, rpcMs: 2000, probeMs: 2000 });
}

const SHELL = "/api/orchestration/shell";

const badShells = {
  "empty object": {},
  "threads null": { schemaVersion: 2, snapshotSequence: 1, threads: null, projects: [] },
  "no projects": { schemaVersion: 2, snapshotSequence: 1, threads: [] },
  "thread without id": { schemaVersion: 2, snapshotSequence: 1, projects: [], threads: [{ ...v2Thread(), id: undefined }] },
  "thread with bad updatedAt": { schemaVersion: 2, snapshotSequence: 1, projects: [], threads: [v2Thread({ updatedAt: "yesterday" })] },
  "array": [],
};

for (const [name, body] of Object.entries(badShells)) {
  test(`shell: ${name} is an error`, async (t) => {
    const client = await fakeT3(t, { [SHELL]: { body } });
    await assert.rejects(client.shell(), (e) => e instanceof T3Error && e.code === "malformed_response" && /malformed shell snapshot/.test(e.message));
  });
}

test("shell: a body that is not JSON (an HTML error page) is an error", async (t) => {
  const client = await fakeT3(t, { [SHELL]: { body: "<html>502 Bad Gateway</html>" } });
  await assert.rejects(client.shell(), (e) => e instanceof T3Error && /not JSON/.test(e.message));
});

test("shell: HTTP 500 is an error", async (t) => {
  const client = await fakeT3(t, { [SHELL]: { status: 500, body: "boom" } });
  await assert.rejects(client.shell(), (e) => e instanceof T3Error && /HTTP 500/.test(e.message));
});

test("archived snapshot without a threads list is an error, not 'no archived threads'", async (t) => {
  const client = await fakeT3(t, { [SHELL]: { body: v2Shell([v2Thread()]) } }, (msg, send) =>
    send({ _tag: "Exit", requestId: msg.id, exit: { _tag: "Success", value: { schemaVersion: 2, snapshotSequence: 1 } } }),
  );
  await assert.rejects(client.shell({ includeArchived: true }), (e) => e instanceof T3Error && /archived shell snapshot/.test(e.message));
});

test("thread snapshots: a projection without a thread, or runs that are not a list, are errors", async (t) => {
  const client = await fakeT3(t, {
    "/api/orchestration/threads/a/bounded": { body: { snapshotSequence: 1, projection: { runs: [] } } },
    "/api/orchestration/threads/b/bounded": { body: { snapshotSequence: 1, projection: { thread: { id: "b" }, runs: {} } } },
    "/api/orchestration/threads/c/bounded": { body: { snapshotSequence: 1, projection: { thread: { id: "c" }, runs: [{ id: "r" }] } } },
  });
  for (const id of ["a", "b", "c"]) {
    await assert.rejects(client.projection(id, { bounded: true }), (e) => e instanceof T3Error && e.code === "malformed_response", id);
  }
});

test("a command answer without a sequence is ambiguous (T3 answered, but whether it ran is unknown)", async (t) => {
  const client = await fakeT3(t, {}, (msg, send) => send({ _tag: "Exit", requestId: msg.id, exit: { _tag: "Success", value: null } }));
  await assert.rejects(client.dispatch({ type: "x", commandId: "c" }), (e) => e instanceof T3Error && e.outcome === "ambiguous");
});

test("RPC outcomes: only auth refusals and 'previously rejected' receipts prove nothing was applied", async (t) => {
  const failExit = (error) => (msg, send) => send({ _tag: "Exit", requestId: msg.id, exit: { _tag: "Failure", cause: [{ _tag: "Fail", error }] } });
  const generic = await fakeT3(t, {}, failExit({ _tag: "OrchestrationV2DispatchCommandError", message: "A queued user message can only be sent now while the thread is stopped." }));
  await assert.rejects(generic.dispatch({ type: "queued-run.start", commandId: "c" }), (e) =>
    e.outcome === "ambiguous" && e.answered === true && e.code === "OrchestrationV2DispatchCommandError" && /only be sent now while the thread is stopped/.test(e.message));
  const receipt = await fakeT3(t, {}, failExit({ _tag: "OrchestrationV2DispatchCommandError", message: "Command c was previously rejected: Failed to dispatch orchestration command queued-run.start (c)." }));
  await assert.rejects(receipt.dispatch({ type: "queued-run.start", commandId: "c" }), (e) => e.outcome === "rejected");
  const auth = await fakeT3(t, {}, failExit({ _tag: "EnvironmentAuthorizationError", message: "The authenticated token is missing required scope: orchestration:operate.", requiredScope: "orchestration:operate" }));
  await assert.rejects(auth.dispatch({ type: "x", commandId: "c" }), (e) => e.outcome === "rejected");
  const defect = await fakeT3(t, {}, (msg, send) => send({ _tag: "Defect", defect: "schema" }));
  await assert.rejects(defect.dispatch({ type: "x", commandId: "c" }), (e) => e.outcome === "ambiguous" && e.answered === true);
  const interrupted = await fakeT3(t, {}, (msg, send) => send({ _tag: "Exit", requestId: msg.id, exit: { _tag: "Failure", cause: [{ _tag: "Interrupt" }] } }));
  await assert.rejects(interrupted.dispatch({ type: "x", commandId: "c" }), (e) => e.outcome === "ambiguous");
});

test("thread snapshots without runs or messages lists, or without a sequence, are errors (not an empty queue)", async (t) => {
  const client = await fakeT3(t, {
    "/api/orchestration/threads/a/bounded": { body: { snapshotSequence: 1, projection: { thread: { id: "a" } } } },
    "/api/orchestration/threads/b/bounded": { body: { snapshotSequence: 1, projection: { thread: { id: "b" }, runs: [] } } },
    "/api/orchestration/threads/c/bounded": { body: { projection: { thread: { id: "c" }, runs: [], messages: [] } } },
  });
  for (const id of ["a", "b", "c"]) {
    await assert.rejects(client.projection(id, { bounded: true }), (e) => e instanceof T3Error && e.code === "malformed_response", id);
  }
  const call = await tools(t, client);
  const r = await call("queue_status", { threadId: "a" });
  assert.equal(r.isError, true);
});

async function tools(t, client) {
  const server = new McpServer({ name: "test", version: "0" });
  registerPhase1(server, () => client, () => { throw new Error("no desk"); });
  registerPhase3(server, () => client);
  registerQueueTools(server, () => client, () => ({ journal: new DeliveryJournal(tempDir(t)), parked: new Set() }));
  const mcp = new Client({ name: "c", version: "0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), mcp.connect(b)]);
  t.after(() => mcp.close());
  return async (name, args) => parse(await mcp.callTool({ name, arguments: args }));
}

test("list_threads, search_threads and queue_status report malformed answers as errors", async (t) => {
  const client = await fakeT3(t, {
    [SHELL]: { body: { schemaVersion: 2, snapshotSequence: 1, projects: [] } },
    "/api/orchestration/threads/t-1/bounded": { body: { snapshotSequence: 1 } },
  });
  const call = await tools(t, client);
  for (const [name, args] of [["list_threads", {}], ["search_threads", { query: "x" }], ["queue_status", { threadId: "t-1" }]]) {
    const r = await call(name, args);
    assert.equal(r.isError, true, name);
    assert.match(r.text, /malformed/, name);
  }
});

test("a well-formed but empty workspace is a real empty answer (total 0)", async (t) => {
  const client = await fakeT3(t, { [SHELL]: { body: v2Shell([]) } });
  const call = await tools(t, client);
  const r = await call("list_threads", {});
  assert.deepEqual([r.total, r.shown, r.hasMore], [0, 0, false]);
});

test("queue_status falls back to the full projection when the server has no bounded route", async (t) => {
  const detail = v2Detail();
  const client = await fakeT3(t, { "/api/orchestration/threads/t-1": { body: detail } });
  const call = await tools(t, client);
  const r = await call("queue_status", { threadId: "t-1" });
  assert.equal(r.source, "full");
  assert.equal(r.total, 0);
  const again = await client.projection("t-1", { bounded: true });
  assert.equal(again.source, "full", "remembered: no second bounded attempt");
});

test("a missing thread (404 on both routes) is an error and does not switch bounded reads off", async (t) => {
  const client = await fakeT3(t, { "/api/orchestration/threads/t-1/bounded": { body: { ...v2Detail(), hasMoreHistory: true } } });
  await assert.rejects(client.projection("gone", { bounded: true }), (e) => e instanceof T3Error && e.status === 404);
  const r = await client.projection("t-1", { bounded: true });
  assert.equal(r.source, "bounded");
  assert.equal(r.hasMoreHistory, true);
  const d = await client.thread("t-1", { window: "bounded", turnLimit: 1 });
  assert.equal(d.page.hasMore, true, "older history beyond the window is signalled");
});

test("the bounded-route fallback keeps the read's deadline instead of starting a new timeout", async (t) => {
  const server = createServer((req, res) => setTimeout(() => {
    if (req.url.endsWith("/bounded")) return res.writeHead(404).end("no route");
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(v2Detail()));
  }, 300));
  const port = await listen(server);
  t.after(() => new Promise((r) => { server.closeAllConnections?.(); server.close(() => r()); }));
  const client = new T3Client(`http://127.0.0.1:${port}`, "tok", { httpMs: 5000 });
  const started = Date.now();
  await assert.rejects(client.projection("t-1", { bounded: true, timeoutMs: 450 }), (e) => e instanceof T3Error && e.code === "timeout");
  assert.ok(Date.now() - started < 1000, "one deadline for the bounded read and its fallback");
});

test("RPC: a socket that opens after sendBy sends no request frame (not_sent)", async (t) => {
  const frames = [];
  const server = createServer((req, res) => res.writeHead(404).end());
  // Delay the WebSocket upgrade, as a slow connection would.
  const inner = (msg, send) => { frames.push(msg); send({ _tag: "Exit", requestId: msg.id, exit: { _tag: "Success", value: { sequence: 1 } } }); };
  attachWs(server, inner);
  const upgrade = server.listeners("upgrade")[0];
  server.removeAllListeners("upgrade");
  server.on("upgrade", (req, socket, head) => setTimeout(() => upgrade(req, socket, head), 300));
  const port = await listen(server);
  t.after(() => new Promise((r) => { server.closeAllConnections?.(); server.close(() => r()); }));
  const client = new T3Client(`http://127.0.0.1:${port}`, "tok", { rpcMs: 2000 });
  await assert.rejects(client.dispatch({ type: "queued-run.start", commandId: "c" }, { sendBy: Date.now() + 100 }), (e) =>
    e instanceof T3Error && e.outcome === "not_sent" && e.code === "deadline");
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(frames.length, 0, "no request reached T3");
  const ok = await client.dispatch({ type: "queued-run.start", commandId: "d" }, { sendBy: Date.now() + 1500 });
  assert.equal(ok.sequence, 1);
});
