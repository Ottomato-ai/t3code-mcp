// T3 client: a dispatch that never reached the server is marked notSent (L2: the grant comes back).
// Dispatch runs over the WebSocket RPC: the command frame is sent only after the socket opens,
// so any failure before open means nothing was sent.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { T3Client, T3Error, refused, wasNotSent } from "../dist/client.js";
import { attachWs } from "./v2-fixtures.mjs";

const listen = (server) => new Promise((r) => server.listen(0, "127.0.0.1", () => r(server.address().port)));
const close = (server) => new Promise((r) => { server.closeAllConnections?.(); server.close(() => r()); });

test("connection refused: T3Error with notSent true", async () => {
  const server = createServer();
  const port = await listen(server);
  await close(server); // nothing listens on this port now
  const client = new T3Client(`http://127.0.0.1:${port}`, "tok");
  await assert.rejects(client.dispatch({ type: "x" }), (e) => e instanceof T3Error && e.notSent === true);
});

test("the server refused the upgrade (HTTP error before the socket opened): notSent true", async (t) => {
  const server = createServer((req, res) => res.writeHead(500).end("boom"));
  server.on("upgrade", (req, socket) => socket.end("HTTP/1.1 500 Internal Server Error\r\nContent-Length: 0\r\n\r\n"));
  const port = await listen(server);
  t.after(() => close(server));
  const client = new T3Client(`http://127.0.0.1:${port}`, "tok");
  await assert.rejects(client.dispatch({ type: "x" }), (e) => e instanceof T3Error && e.notSent === true);
});

test("the server took the frame and dropped the connection: notSent false", async (t) => {
  const server = createServer();
  attachWs(server, (msg, send, req) => req.socket.destroy());
  const port = await listen(server);
  t.after(() => close(server));
  const client = new T3Client(`http://127.0.0.1:${port}`, "tok");
  await assert.rejects(client.dispatch({ type: "x" }), (e) => e instanceof T3Error && e.notSent === false);
});

test("connection refused on localhost (IPv6 and IPv4 tried): notSent true", async () => {
  const server = createServer();
  const port = await listen(server);
  await close(server);
  const client = new T3Client(`http://localhost:${port}`, "tok");
  await assert.rejects(client.dispatch({ type: "x" }), (e) => e instanceof T3Error && e.notSent === true);
});

test("wasNotSent: only a T3Error marked notSent", () => {
  assert.equal(wasNotSent(new T3Error("x", { notSent: true })), true);
  assert.equal(wasNotSent(new T3Error("x")), false);
  assert.equal(wasNotSent(Object.assign(new Error("x"), { notSent: true })), false);
  assert.equal(wasNotSent(undefined), false);
});

test("refused: a direct ECONNREFUSED cause, or an AggregateError of only ECONNREFUSED", () => {
  assert.equal(refused({ cause: { code: "ECONNREFUSED" } }), true);
  assert.equal(refused({ cause: { errors: [{ code: "ECONNREFUSED" }, { code: "ECONNREFUSED" }] } }), true);
  assert.equal(refused({ cause: { errors: [{ code: "ECONNREFUSED" }, { code: "ETIMEDOUT" }] } }), false);
  assert.equal(refused({ cause: { errors: [] } }), false);
  assert.equal(refused({ cause: { code: "UND_ERR_SOCKET" } }), false);
  assert.equal(refused(new Error("x")), false);
});
