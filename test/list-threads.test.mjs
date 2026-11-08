// list_threads and search_threads: complete enumeration with stable pagination (defect 1).
import { test } from "node:test";
import assert from "node:assert/strict";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerPhase1 } from "../dist/tools/phase1.js";
import { registerPhase3 } from "../dist/tools/phase3.js";
import { LaunchDesk } from "../dist/desk/desk.js";
import { DeskStore } from "../dist/desk/store.js";
import { parse, tempDir, T0 } from "./helpers.mjs";

const iso = (ms) => new Date(ms).toISOString();

/** Deterministic pseudo-random so failures reproduce. */
function rng(seed) {
  let x = seed >>> 0;
  return () => ((x = (Math.imul(x ^ (x >>> 15), 2246822507) + 0x9e3779b9) >>> 0) / 2 ** 32);
}

/**
 * A fake workspace of n threads over projects p1..p3, with mixed attention states and many
 * equal updatedAt values (ties must still page without loss).
 */
function workspace(n, seed = 1) {
  const r = rng(seed);
  const threads = [];
  for (let i = 0; i < n; i++) {
    const project = `p${1 + (i % 3)}`;
    const kind = i % 5;
    threads.push({
      id: `th-${String(i).padStart(5, "0")}`,
      projectId: project,
      title: `task ${i} ${i % 7 === 0 ? "deploy" : "review"}`,
      branch: i % 11 === 0 ? `fix/b${i}` : null,
      createdAt: iso(T0 - (n - i) * 60_000),
      // Coarse times: many ties.
      updatedAt: iso(T0 - Math.floor(r() * 50) * 60_000),
      archivedAt: i % 13 === 0 ? iso(T0) : null,
      session: kind === 0 ? { threadId: `th-${i}`, status: "running" } : null,
      latestTurn: kind === 0 ? { turnId: "r", state: "running" } : kind === 1 ? { turnId: "r", state: "completed" } : null,
      hasPendingApprovals: kind === 2,
    });
  }
  return { snapshotSequence: 1, updatedAt: iso(T0), projects: [1, 2, 3].map((k) => ({ id: `p${k}`, title: `Project ${k}`, workspaceRoot: `/w/${k}` })), threads };
}

async function setup(t, ws) {
  const state = { ws, shellCalls: 0 };
  const client = {
    async shell(opts = {}) {
      state.shellCalls++;
      const s = structuredClone(state.ws);
      if (!opts.includeArchived) s.threads = s.threads.filter((x) => !x.archivedAt);
      return s;
    },
  };
  const desk = new LaunchDesk({
    store: new DeskStore(tempDir(t)),
    cap: 5,
    readMemory: () => ({ status: "ok", commitPercent: 50, blocks: false, detail: null }),
    now: () => T0,
    pollMs: 20,
    shellIntervalMs: 0,
  });
  const server = new McpServer({ name: "test", version: "0" });
  registerPhase1(server, () => client, () => desk);
  registerPhase3(server, () => client);
  const mcp = new Client({ name: "c", version: "0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), mcp.connect(b)]);
  t.after(() => mcp.close());
  const call = async (name, args) => parse(await mcp.callTool({ name, arguments: args }));
  return { state, call };
}

/** Page through a tool until hasMore is false; returns all rows and the last page. */
async function all(call, tool, args, between) {
  const rows = [];
  let page = await call(tool, args);
  let n = 0;
  for (;;) {
    assert.ok(!page.isError, page.text);
    rows.push(...page.threads);
    if (!page.hasMore) return { rows, last: page, pages: n + 1 };
    n++;
    await between?.(n);
    page = await call(tool, { ...args, cursor: page.nextCursor });
  }
}

const ids = (rows) => rows.map((r) => r.threadId);
const assertNoDupes = (rows) => assert.equal(new Set(ids(rows)).size, rows.length, "no thread listed twice");

test("backward compatible first page: same fields, order and default limit as before", async (t) => {
  const ws = workspace(40);
  const { call } = await setup(t, ws);
  const r = await call("list_threads", {});
  const active = ws.threads.filter((x) => !x.archivedAt);
  assert.equal(r.shown, 25);
  assert.equal(r.matchedOf, active.length, "matchedOf keeps its old meaning");
  assert.equal(r.total, active.length);
  assert.equal(r.hasMore, true);
  assert.equal(typeof r.nextCursor, "string");
  const want = [...active].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt) || (a.id < b.id ? -1 : 1)).slice(0, 25).map((x) => x.id);
  assert.deepEqual(ids(r.threads), want);
  for (const k of ["threadId", "title", "project", "attention", "sessionStatus", "updatedAt"]) assert.ok(k in r.threads[0]);
});

test("limit above 100 is still refused per page (pages, not bigger answers)", async (t) => {
  const { call } = await setup(t, workspace(5));
  const r = await call("list_threads", { limit: 101 });
  assert.equal(r.isError, true);
});

test(">100 threads in one project and one attention state: every one is reachable", async (t) => {
  const ws = workspace(900);
  const { call } = await setup(t, ws);
  const want = ws.threads.filter((x) => !x.archivedAt && x.projectId === "p2" && x.hasPendingApprovals).map((x) => x.id).sort();
  assert.ok(want.length > 50);
  const { rows, last } = await all(call, "list_threads", { projectId: "p2", attention: "needs-approval", limit: 7 });
  assertNoDupes(rows);
  assert.deepEqual(ids(rows).sort(), want);
  assert.equal(last.total, want.length);
  assert.equal(last.returnedSoFar, want.length);
  const big = ws.threads.filter((x) => !x.archivedAt && x.projectId === "p1").length;
  assert.ok(big > 100);
  const p1 = await all(call, "list_threads", { projectId: "p1", limit: 100 });
  assert.equal(p1.rows.length, big);
  assertNoDupes(p1.rows);
});

test(">1,000 threads including archived: complete, no duplicates, in both orders", async (t) => {
  const ws = workspace(2500, 7);
  const { call } = await setup(t, ws);
  for (const order of ["updated", "created"]) {
    const { rows, last, pages } = await all(call, "list_threads", { includeArchived: true, limit: 100, order });
    assert.equal(rows.length, 2500, order);
    assertNoDupes(rows);
    assert.equal(last.total, 2500);
    assert.equal(pages, 25);
    assert.equal(last.consistentSinceFirstPage, true);
    assert.deepEqual(last.changedSinceFirstPage, []);
  }
});

test("updates between pages (updated order): pages + changedSinceFirstPage cover every thread", async (t) => {
  const ws = workspace(1200, 3);
  const { state, call } = await setup(t, ws);
  const before = new Set(ws.threads.filter((x) => !x.archivedAt).map((x) => x.id));
  let bump = 1;
  const { rows, last } = await all(call, "list_threads", { limit: 50 }, (n) => {
    // Every other page, a thread not yet listed moves to the top (it would be skipped).
    if (n % 2) {
      const victim = state.ws.threads.filter((x) => !x.archivedAt).at(-n * 7);
      victim.updatedAt = iso(T0 + bump++ * 60_000);
      state.ws.snapshotSequence++;
    }
  });
  assertNoDupes(rows);
  const covered = new Set([...ids(rows), ...last.changedSinceFirstPage]);
  for (const id of before) assert.ok(covered.has(id), `${id} lost`);
  assert.equal(last.consistentSinceFirstPage, false);
  assert.ok(last.changedSinceFirstPage.length > 0);
});

test("created order is stable under updates; threads created mid-paging are reported", async (t) => {
  const ws = workspace(600, 5);
  const { state, call } = await setup(t, ws);
  const before = ws.threads.filter((x) => !x.archivedAt).map((x) => x.id);
  const { rows, last } = await all(call, "list_threads", { limit: 40, order: "created" }, (n) => {
    for (const x of state.ws.threads.slice(n * 10, n * 10 + 5)) x.updatedAt = iso(T0 + n * 1000);
    if (n === 3) {
      state.ws.threads.push({ ...state.ws.threads[1], id: "th-new", createdAt: iso(T0 + 5 * 60_000), updatedAt: iso(T0 + 5 * 60_000), archivedAt: null });
    }
    state.ws.snapshotSequence++;
  });
  assertNoDupes(rows);
  assert.deepEqual(ids(rows).filter((id) => id !== "th-new").sort(), [...before].sort(), "every original thread exactly once");
  assert.ok(last.changedSinceFirstPage.includes("th-new"), "the new thread is reported");
});

test("a thread deleted between pages does not break or shift paging", async (t) => {
  const ws = workspace(300, 9);
  const { state, call } = await setup(t, ws);
  const activeBefore = ws.threads.filter((x) => !x.archivedAt).length;
  const first = await call("list_threads", { limit: 30, order: "created" });
  const gone = state.ws.threads.find((x) => !x.archivedAt && !ids(first.threads).includes(x.id));
  state.ws.threads = state.ws.threads.filter((x) => x !== gone);
  const rest = await all(call, "list_threads", { limit: 30, order: "created", cursor: first.nextCursor });
  const got = [...ids(first.threads), ...ids(rest.rows)];
  assert.equal(new Set(got).size, got.length);
  assert.equal(got.length, activeBefore - 1);
  assert.ok(!got.includes(gone.id));
});

test("a cursor is bound to its filters and order; a corrupt cursor is an error, never an empty page", async (t) => {
  const { call } = await setup(t, workspace(80));
  const p = await call("list_threads", { projectId: "p1", limit: 5 });
  const other = await call("list_threads", { projectId: "p2", limit: 5, cursor: p.nextCursor });
  assert.equal(other.isError, true);
  assert.match(other.text, /different query/);
  const order = await call("list_threads", { projectId: "p1", limit: 5, order: "created", cursor: p.nextCursor });
  assert.equal(order.isError, true);
  const bad = await call("list_threads", { cursor: "not-a-cursor" });
  assert.equal(bad.isError, true);
  assert.match(bad.text, /cursor is not valid/);
});

test("search_threads pages past the old 50-row cap", async (t) => {
  const ws = workspace(1100, 11);
  const { call } = await setup(t, ws);
  const want = ws.threads.filter((x) => x.title.includes("review")).map((x) => x.id).sort();
  assert.ok(want.length > 500);
  const { rows, last } = await all(call, "search_threads", { query: "review", limit: 50 });
  assertNoDupes(rows);
  assert.deepEqual(ids(rows).sort(), want);
  assert.equal(last.total, want.length);
  const first = await call("search_threads", { query: "review" });
  assert.equal(first.matches, 10, "default page size unchanged");
  const wrong = await call("search_threads", { query: "deploy", cursor: first.nextCursor });
  assert.equal(wrong.isError, true);
});
