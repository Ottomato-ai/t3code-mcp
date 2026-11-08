// Keyset pagination unit tests (src/paging.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import { paginate, compareKeys, decodeCursor, queryHash, CursorError, ms } from "../dist/paging.js";

const rows = (n, rank = (i) => [Math.floor(i / 10)]) =>
  Array.from({ length: n }, (_, i) => ({ row: i, rank: rank(i), id: `id-${String(i).padStart(4, "0")}`, updatedMs: 1000 + (i % 7) }));

function pageAll(items, limit, q = "q") {
  const out = [];
  let cursor;
  for (let guard = 0; guard < 10_000; guard++) {
    const p = paginate(items, { limit, cursor, query: q, snapshotSequence: 5, allUpdated: items.map((r) => ({ id: r.id, updatedMs: r.updatedMs })) });
    out.push(...p.rows);
    if (!p.hasMore) return { out, last: p };
    cursor = p.nextCursor;
  }
  throw new Error("did not terminate");
}

test("ties on rank are broken by id: a total order, every row exactly once at any page size", () => {
  const items = rows(1234);
  for (const limit of [1, 7, 100, 1234, 5000]) {
    const { out, last } = pageAll(items, limit);
    assert.equal(out.length, 1234, `limit ${limit}`);
    assert.equal(new Set(out).size, 1234);
    assert.equal(last.total, 1234);
    assert.equal(last.returnedSoFar, 1234);
    assert.equal(last.nextCursor, null);
  }
});

test("compareKeys: descending rank parts, then ascending id", () => {
  assert.ok(compareKeys({ rank: [5], id: "b" }, { rank: [4], id: "a" }) < 0);
  assert.ok(compareKeys({ rank: [5, 1], id: "b" }, { rank: [5, 2], id: "a" }) > 0);
  assert.ok(compareKeys({ rank: [5], id: "a" }, { rank: [5], id: "b" }) < 0);
  assert.equal(compareKeys({ rank: [5], id: "a" }, { rank: [5], id: "a" }), 0);
});

test("an empty result is explicit: total 0, no cursor", () => {
  const p = paginate([], { limit: 10, query: "q", snapshotSequence: 1, allUpdated: [] });
  assert.deepEqual([p.total, p.hasMore, p.nextCursor, p.rows.length], [0, false, null, 0]);
});

test("cursors: other query, garbage, tampered fields are all errors", () => {
  const p = paginate(rows(30), { limit: 10, query: queryHash({ a: 1 }), snapshotSequence: 1, allUpdated: [{ id: "x", updatedMs: 1 }] });
  assert.throws(() => decodeCursor(p.nextCursor, queryHash({ a: 2 })), CursorError);
  assert.throws(() => decodeCursor("%%%", "x"), CursorError);
  const tampered = Buffer.from(JSON.stringify({ v: 1, q: queryHash({ a: 1 }), k: ["x"], id: "a", w: 0, t: [], s: 0, n: 0 })).toString("base64url");
  assert.throws(() => decodeCursor(tampered, queryHash({ a: 1 })), CursorError);
  assert.doesNotThrow(() => decodeCursor(p.nextCursor, queryHash({ a: 1 })));
});

test("ms(): invalid or missing times sort last instead of being dropped", () => {
  assert.equal(ms(null), 0);
  assert.equal(ms("not a date"), 0);
  assert.equal(ms("2026-11-07T00:00:00Z"), Date.parse("2026-11-07T00:00:00Z"));
});

test("a thread updated within the same millisecond as the watermark is still reported (ties)", () => {
  // Page 1 returns z@100; unseen a@90 is then updated to exactly 100 and moves before the cursor.
  const q = "tie";
  const rowsAt = (aMs) => [
    { row: "z", rank: [100], id: "z", updatedMs: 100 },
    { row: "a", rank: [aMs], id: "a", updatedMs: aMs },
    { row: "b", rank: [80], id: "b", updatedMs: 80 },
  ];
  const first = paginate(rowsAt(90), { limit: 1, query: q, snapshotSequence: 1, allUpdated: rowsAt(90).map((r) => ({ id: r.id, updatedMs: r.updatedMs })) });
  assert.deepEqual(first.rows, ["z"]);
  const rest = [];
  let cursor = first.nextCursor;
  let last;
  while (cursor) {
    last = paginate(rowsAt(100), { limit: 1, query: q, cursor, snapshotSequence: 2, allUpdated: [] });
    rest.push(...last.rows);
    cursor = last.nextCursor;
  }
  assert.ok(!rest.includes("a"), "a moved before the cursor, so later pages skip it");
  assert.ok(last.changedSinceFirstPage.includes("a"), "and it is reported instead");
  assert.ok(!last.changedSinceFirstPage.includes("z"), "z was at the watermark on page 1: not a change");
});
