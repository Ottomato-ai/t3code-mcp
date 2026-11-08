// Timeouts and delivery settings come from the environment (defect 5: build/deploy drift).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { DEFAULT_TIMEOUTS, TIMEOUT_ENV, loadTimeouts, parseTimeoutMs, loadParkedThreads, deliveryStateDir, ConfigError } from "../dist/config.js";
import { T3Client, T3Error, makeClient } from "../dist/client.js";
import { attachWs } from "./v2-fixtures.mjs";

function withEnv(t, vars) {
  const saved = {};
  for (const [k, v] of Object.entries(vars)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  t.after(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });
}

const clearTimeouts = { T3_HTTP_TIMEOUT_MS: undefined, T3_PROBE_TIMEOUT_MS: undefined, T3_RPC_TIMEOUT_MS: undefined };

test("defaults are unchanged when nothing is set", (t) => {
  withEnv(t, clearTimeouts);
  assert.deepEqual(loadTimeouts(), { httpMs: 30_000, probeMs: 3_000, rpcMs: 30_000 });
  assert.deepEqual(DEFAULT_TIMEOUTS, { httpMs: 30_000, probeMs: 3_000, rpcMs: 30_000 });
});

test("the bot computer's settings (HTTP 120000, probe 15000, RPC 30000) are read from the environment", (t) => {
  withEnv(t, { T3_HTTP_TIMEOUT_MS: "120000", T3_PROBE_TIMEOUT_MS: "15000", T3_RPC_TIMEOUT_MS: "30000" });
  assert.deepEqual(loadTimeouts(), { httpMs: 120_000, probeMs: 15_000, rpcMs: 30_000 });
  withEnv(t, { T3_TOKEN: "tok", T3_ORIGIN: "http://127.0.0.1:1" });
  assert.deepEqual({ ...makeClient().timeouts }, { httpMs: 120_000, probeMs: 15_000, rpcMs: 30_000 });
});

test("a bad value is a configuration error, not a silent default", (t) => {
  for (const bad of ["abc", "12.5", "-1", "0", "50", "600001", "1e5", ""]) {
    if (bad === "") {
      assert.equal(parseTimeoutMs("X", undefined, 7), 7);
      continue;
    }
    assert.throws(() => parseTimeoutMs("T3_HTTP_TIMEOUT_MS", bad, 1), ConfigError, bad);
  }
  withEnv(t, { ...clearTimeouts, T3_RPC_TIMEOUT_MS: "soon" });
  assert.throws(() => loadTimeouts(), /T3_RPC_TIMEOUT_MS/);
});

test("variable names are published for deployments and t3_status", () => {
  assert.deepEqual({ ...TIMEOUT_ENV }, { httpMs: "T3_HTTP_TIMEOUT_MS", probeMs: "T3_PROBE_TIMEOUT_MS", rpcMs: "T3_RPC_TIMEOUT_MS" });
});

test("parked threads and the journal folder come from the environment", (t) => {
  withEnv(t, { T3_PARKED_THREADS: " a1, b2\nc3 ", T3_DELIVERY_STATE_DIR: "/tmp/somewhere" });
  assert.deepEqual([...loadParkedThreads()].sort(), ["a1", "b2", "c3"]);
  assert.equal(deliveryStateDir(), "/tmp/somewhere");
});

const listen = (server) => new Promise((r) => server.listen(0, "127.0.0.1", () => r(server.address().port)));

test("the client uses the configured HTTP, probe and RPC timeouts (not a fixed 30 s)", async (t) => {
  const server = createServer((req, res) => setTimeout(() => res.writeHead(200, { "content-type": "application/json" }).end("{}"), 1500));
  attachWs(server, () => {}); // never answers
  const port = await listen(server);
  t.after(() => new Promise((r) => { server.closeAllConnections?.(); server.close(() => r()); }));
  const client = new T3Client(`http://127.0.0.1:${port}`, "tok", { httpMs: 150, probeMs: 120, rpcMs: 200 });
  await assert.rejects(client.shell(), (e) => e instanceof T3Error && /within 150 ms/.test(e.message) && e.code === "timeout");
  await assert.rejects(client.probe(), (e) => e instanceof T3Error && /probe timeout 120 ms/.test(e.message));
  await assert.rejects(client.dispatch({ type: "x", commandId: "c" }), (e) => e instanceof T3Error && /200 ms/.test(e.message) && e.outcome === "ambiguous");
});

test("the built client has no hardcoded timeout left (the drift found in the deployed dist)", () => {
  const src = readFileSync(new URL("../dist/client.js", import.meta.url), "utf8");
  assert.doesNotMatch(src, /AbortSignal\.timeout\(\s*[\d_]+\s*\)/);
  assert.doesNotMatch(src, /timeoutMs\s*\?\?\s*[\d_]+/);
});
