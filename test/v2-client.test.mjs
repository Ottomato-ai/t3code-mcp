// T3 client on orchestration protocol 2: header on every HTTP call, V2 snapshots mapped,
// dispatch and archived snapshot over the WebSocket RPC.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { T3Client, T3Error } from "../dist/client.js";
import { attachWs, v2Shell, v2Thread, v2Detail, v2Message, iso, MIN } from "./v2-fixtures.mjs";

const listen = (server) => new Promise((r) => server.listen(0, "127.0.0.1", () => r(server.address().port)));
const close = (server) => new Promise((r) => { server.closeAllConnections?.(); server.close(() => r()); });

/** Fake T3: HTTP shell/detail that demand the protocol header, plus an RPC socket. */
async function fakeT3(t, opts = {}) {
  const seen = { http: [], rpc: [] };
  const server = createServer((req, res) => {
    seen.http.push({ url: req.url, protocol: req.headers["x-t3-orchestration-protocol"], auth: req.headers.authorization });
    if (req.headers["x-t3-orchestration-protocol"] !== "2") return res.writeHead(400).end();
    if (req.url === "/api/orchestration/shell") return res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(opts.shell ?? v2Shell([v2Thread()])));
    if (req.url.startsWith("/api/orchestration/threads/")) return res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(opts.detail ?? v2Detail()));
    res.writeHead(404).end();
  });
  attachWs(server, (msg, send, req) => {
    seen.rpc.push({ msg, url: req.url, auth: req.headers.authorization });
    if (opts.onRpc) return opts.onRpc(msg, send);
    if (msg._tag !== "Request") return;
    if (msg.tag === "orchestration.getArchivedShellSnapshot") {
      return send({ _tag: "Exit", requestId: msg.id, exit: { _tag: "Success", value: { schemaVersion: 2, snapshotSequence: 1, projects: [], threads: opts.archived ?? [] } } });
    }
    send({ _tag: "Exit", requestId: msg.id, exit: { _tag: "Success", value: { sequence: 99 } } });
  });
  const port = await listen(server);
  t.after(() => close(server));
  return { client: new T3Client(`http://127.0.0.1:${port}`, "tok"), seen };
}

test("shell sends the protocol 2 header and maps the V2 snapshot", async (t) => {
  const { client, seen } = await fakeT3(t);
  const shell = await client.shell();
  assert.equal(seen.http[0].protocol, "2");
  assert.equal(seen.http[0].auth, "Bearer tok");
  assert.equal(shell.threads[0].id, "t-1");
  assert.equal(shell.threads[0].session, null);
  assert.equal(seen.rpc.length, 0, "no archived fetch unless asked");
});

test("shell with includeArchived adds the RPC archived snapshot", async (t) => {
  const { client, seen } = await fakeT3(t, { archived: [v2Thread({ id: "arch", archivedAt: iso(MIN) })] });
  const shell = await client.shell({ includeArchived: true });
  assert.deepEqual(shell.threads.map((x) => x.id), ["t-1", "arch"]);
  assert.equal(seen.rpc[0].msg.tag, "orchestration.getArchivedShellSnapshot");
  assert.match(seen.rpc[0].url, /^\/ws\?orchestrationProtocol=2$/);
  assert.equal(seen.rpc[0].auth, "Bearer tok");
});

test("thread sends the header, no query string, and applies turnLimit client-side", async (t) => {
  const detail = v2Detail({
    messages: [
      v2Message({ id: "u1", role: "user", createdAt: iso(5 * MIN) }),
      v2Message({ id: "u2", role: "user", createdAt: iso(4 * MIN) }),
    ],
  });
  const { client, seen } = await fakeT3(t, { detail });
  const snap = await client.thread("t 1", { turnLimit: 1 });
  assert.equal(seen.http[0].url, "/api/orchestration/threads/t%201");
  assert.equal(seen.http[0].protocol, "2");
  assert.deepEqual(snap.thread.messages.map((m) => m.id), ["u2"]);
});

test("dispatch sends one Effect RPC request frame and returns the sequence", async (t) => {
  const { client, seen } = await fakeT3(t);
  const r = await client.dispatch({ type: "thread.archive", commandId: "c1", threadId: "t-1" });
  assert.equal(r.sequence, 99);
  const { msg } = seen.rpc[0];
  assert.equal(msg._tag, "Request");
  assert.equal(msg.tag, "orchestration.dispatchCommand");
  assert.deepEqual(msg.payload, { type: "thread.archive", commandId: "c1", threadId: "t-1" });
  assert.deepEqual(msg.headers, []);
  assert.equal(typeof msg.id, "string");
});

test("an RPC failure exit becomes a T3Error that says what T3 rejected", async (t) => {
  const { client } = await fakeT3(t, {
    onRpc: (msg, send) => send({ _tag: "Exit", requestId: msg.id, exit: { _tag: "Failure", cause: [{ _tag: "Fail", error: { _tag: "OrchestratorDispatchError", message: "Thread t-1 does not exist." } }] } }),
  });
  await assert.rejects(client.dispatch({ type: "thread.archive", commandId: "c", threadId: "t-1" }), (e) =>
    e instanceof T3Error && e.notSent === false && /does not exist/.test(e.message) && /orchestration\.dispatchCommand/.test(e.message));
});

test("an RPC defect (schema rejection) becomes a T3Error", async (t) => {
  const { client } = await fakeT3(t, {
    onRpc: (msg, send) => send({ _tag: "Exit", requestId: msg.id, exit: { _tag: "Failure", cause: [{ _tag: "Die", defect: "Expected \"thread.create\" | ... at [\"type\"]" }] } }),
  });
  await assert.rejects(client.dispatch({ type: "nope" }), (e) => e instanceof T3Error && /Expected/.test(e.message));
});

test("frames for other requests and pings are ignored until our Exit arrives", async (t) => {
  const { client } = await fakeT3(t, {
    onRpc: (msg, send) => {
      send({ _tag: "Pong" });
      send({ _tag: "Exit", requestId: "other", exit: { _tag: "Success", value: { sequence: 1 } } });
      send([{ _tag: "Exit", requestId: msg.id, exit: { _tag: "Success", value: { sequence: 5 } } }]);
    },
  });
  assert.equal((await client.dispatch({ type: "x" })).sequence, 5);
});

test("the RPC times out with a T3Error when no Exit comes", async (t) => {
  const { client } = await fakeT3(t, { onRpc: () => {} });
  await assert.rejects(client.rpc("orchestration.dispatchCommand", { type: "x" }, { timeoutMs: 200 }), (e) =>
    e instanceof T3Error && e.notSent === false && /timed out/i.test(e.message));
});
