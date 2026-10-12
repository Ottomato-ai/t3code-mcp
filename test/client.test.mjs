// T3 client: a request that never reached the server is marked notSent (L2: the grant comes back).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { T3Client, T3Error, wasNotSent } from "../dist/client.js";

const listen = (server) => new Promise((r) => server.listen(0, "127.0.0.1", () => r(server.address().port)));
const close = (server) => new Promise((r) => server.close(() => r()));

test("connection refused: T3Error with notSent true", async () => {
  const server = createServer();
  const port = await listen(server);
  await close(server); // nothing listens on this port now
  const client = new T3Client(`http://127.0.0.1:${port}`, "tok");
  await assert.rejects(client.dispatch({ type: "x" }), (e) => e instanceof T3Error && e.notSent === true);
});

test("the server took the request and dropped the connection: notSent false", async (t) => {
  const server = createServer((req) => req.socket.destroy());
  const port = await listen(server);
  t.after(() => close(server));
  const client = new T3Client(`http://127.0.0.1:${port}`, "tok");
  await assert.rejects(client.dispatch({ type: "x" }), (e) => e instanceof T3Error && e.notSent === false);
});

test("an HTTP error answer is not notSent", async (t) => {
  const server = createServer((req, res) => res.writeHead(500).end("boom"));
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
