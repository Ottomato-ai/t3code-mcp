// Keyset pagination over one shell snapshot per page.
//
// Rows are ordered by a numeric rank tuple (each part descending) and then by id (ascending),
// a total order. The cursor names the last row returned, so a page never repeats or skips a
// row whose sort key is unchanged since the first page. A row whose key changes between pages
// can move behind the cursor (for "updated" order: any thread updated after the first page);
// every such row is listed in `changedSinceFirstPage`, so pages plus that list always cover every
// thread that existed when paging began, plus any created since. Nothing is silently dropped.
import { createHash } from "node:crypto";

export class CursorError extends Error {}

interface CursorState {
  v: 1;
  /** Hash of the query the cursor belongs to (filters, order, search words). */
  q: string;
  /** Sort key of the last row returned. */
  k: number[];
  id: string;
  /** Newest updatedAt (ms) in the first page's snapshot: later updates are "changed". */
  w: number;
  /**
   * Ids whose updatedAt was exactly `w` on the first page. Another thread updated within that same
   * millisecond also counts as changed. null: too many ties to carry; every row at `w` counts.
   */
  t: string[] | null;
  /** snapshotSequence of the first page. */
  s: number;
  /** Rows returned so far. */
  n: number;
}

export interface PageRow<T> {
  row: T;
  /** Descending rank parts, compared left to right. */
  rank: number[];
  id: string;
  /** updatedAt in ms; detects rows that changed after the first page. */
  updatedMs: number;
}

export interface PageResult<T> {
  rows: T[];
  total: number;
  returnedSoFar: number;
  hasMore: boolean;
  nextCursor: string | null;
  snapshotSequence: number;
  firstSnapshotSequence: number;
  /** True when the workspace did not change since the first page (same snapshot sequence). */
  consistentSinceFirstPage: boolean;
  /** Matching rows updated after the first page that later pages will not return. */
  changedSinceFirstPage: string[];
}

export function queryHash(query: unknown): string {
  return createHash("sha256").update(JSON.stringify(query)).digest("hex").slice(0, 16);
}

function encode(c: CursorState): string {
  return Buffer.from(JSON.stringify(c), "utf8").toString("base64url");
}

export function decodeCursor(cursor: string, expectedQuery: string): CursorState {
  let c: unknown;
  try {
    c = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    throw new CursorError("cursor is not valid: pass nextCursor exactly as returned, or start again without a cursor.");
  }
  const o = c as Partial<CursorState> | null;
  if (
    !o ||
    o.v !== 1 ||
    typeof o.q !== "string" ||
    !Array.isArray(o.k) ||
    !o.k.every((x) => typeof x === "number" && Number.isFinite(x)) ||
    typeof o.id !== "string" ||
    typeof o.w !== "number" ||
    !(o.t === null || (Array.isArray(o.t) && o.t.every((x) => typeof x === "string"))) ||
    typeof o.s !== "number" ||
    typeof o.n !== "number"
  ) {
    throw new CursorError("cursor is not valid: pass nextCursor exactly as returned, or start again without a cursor.");
  }
  if (o.q !== expectedQuery) {
    throw new CursorError("cursor belongs to a different query (filters, order or search changed): start again without a cursor.");
  }
  return o as CursorState;
}

/** Negative when a sorts before b. */
export function compareKeys(a: { rank: number[]; id: string }, b: { rank: number[]; id: string }): number {
  const len = Math.max(a.rank.length, b.rank.length);
  for (let i = 0; i < len; i++) {
    const d = (b.rank[i] ?? 0) - (a.rank[i] ?? 0);
    if (d !== 0) return d;
  }
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** Most ids carried in a cursor for threads tied at the watermark. */
const MAX_TIES = 50;

/**
 * One page of `rows` (all matching rows of the current snapshot, in any order).
 * `allUpdated` is every thread in the snapshot's scope (not only matches): the newest updatedAt
 * on the first page is the change watermark.
 */
export function paginate<T>(
  rows: PageRow<T>[],
  opts: {
    limit: number;
    cursor?: string;
    query: string;
    snapshotSequence: number;
    allUpdated: Array<{ id: string; updatedMs: number }>;
  },
): PageResult<T> {
  const sorted = [...rows].sort(compareKeys);
  const state = opts.cursor ? decodeCursor(opts.cursor, opts.query) : undefined;
  const watermark = state?.w ?? opts.allUpdated.reduce((m, x) => (x.updatedMs > m ? x.updatedMs : m), 0);
  let ties: string[] | null;
  if (state) ties = state.t;
  else {
    const atMark = opts.allUpdated.filter((x) => x.updatedMs === watermark).map((x) => x.id);
    ties = atMark.length > MAX_TIES ? null : atMark;
  }
  const tieSet = ties ? new Set(ties) : null;
  const changed = (r: PageRow<T>) => r.updatedMs > watermark || (r.updatedMs === watermark && (tieSet === null || !tieSet.has(r.id)));
  const firstSeq = state?.s ?? opts.snapshotSequence;
  const after = state ? sorted.filter((r) => compareKeys(r, { rank: state.k, id: state.id }) > 0) : sorted;
  const page = after.slice(0, opts.limit);
  const returnedSoFar = (state?.n ?? 0) + page.length;
  const hasMore = after.length > page.length;
  const last = page.at(-1);
  const nextCursor =
    hasMore && last
      ? encode({ v: 1, q: opts.query, k: last.rank, id: last.id, w: watermark, t: ties, s: firstSeq, n: returnedSoFar })
      : null;
  // An unchanged snapshot sequence means nothing changed at all since the first page.
  const changedSinceFirstPage =
    state && opts.snapshotSequence !== firstSeq
      ? sorted.filter((r) => changed(r) && compareKeys(r, { rank: state.k, id: state.id }) <= 0).map((r) => r.id)
      : [];
  return {
    rows: page.map((r) => r.row),
    total: sorted.length,
    returnedSoFar,
    hasMore,
    nextCursor,
    snapshotSequence: opts.snapshotSequence,
    firstSnapshotSequence: firstSeq,
    consistentSinceFirstPage: opts.snapshotSequence === firstSeq,
    changedSinceFirstPage,
  };
}

/** Milliseconds of an ISO time; 0 for an absent or invalid value (sorts last, never dropped). */
export function ms(iso: string | null | undefined): number {
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(t) ? t : 0;
}
