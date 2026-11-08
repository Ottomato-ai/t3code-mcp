// Response validation. A malformed or partial answer from T3 must surface as an error: read as
// "no threads" or "empty queue" it hides work (fleet checks) and invites duplicate sends.

export class MalformedResponseError extends Error {
  constructor(
    readonly what: string,
    readonly reason: string,
  ) {
    super(`T3 returned a malformed ${what}: ${reason}. Nothing was inferred from it.`);
  }
}

type Raw = Record<string, unknown>;

const isObject = (v: unknown): v is Raw => typeof v === "object" && v !== null && !Array.isArray(v);
const isNonEmptyString = (v: unknown): v is string => typeof v === "string" && v.length > 0;

function fail(what: string, reason: string): never {
  throw new MalformedResponseError(what, reason);
}

/** Each thread shell needs the keys every tool sorts, filters or reports on. */
export function assertThreadShells(list: unknown, what: string): asserts list is Raw[] {
  if (!Array.isArray(list)) fail(what, "threads is not an array");
  list.forEach((t, i) => {
    if (!isObject(t)) fail(what, `thread #${i} is not an object`);
    if (!isNonEmptyString(t.id)) fail(what, `thread #${i} has no id`);
    if (!isNonEmptyString(t.projectId)) fail(what, `thread ${t.id} has no projectId`);
    if (typeof t.createdAt !== "string" || !Number.isFinite(Date.parse(t.createdAt))) {
      fail(what, `thread ${t.id} has no valid createdAt`);
    }
    if (typeof t.updatedAt !== "string" || !Number.isFinite(Date.parse(t.updatedAt))) {
      fail(what, `thread ${t.id} has no valid updatedAt`);
    }
  });
}

/** Shell snapshot, protocol 2 or the legacy shape: projects and threads must both be present. */
export function assertShellSnapshot(raw: unknown): void {
  const what = "shell snapshot";
  if (!isObject(raw)) fail(what, "the body is not a JSON object");
  if (!Array.isArray(raw.projects)) fail(what, "projects is missing or not an array");
  assertThreadShells(raw.threads, what);
  if ("archivedThreads" in raw && raw.archivedThreads !== undefined && raw.archivedThreads !== null) {
    assertThreadShells(raw.archivedThreads, `${what} (archivedThreads)`);
  }
  if (typeof raw.snapshotSequence !== "number") fail(what, "snapshotSequence is missing");
}

/** The RPC archived snapshot: `threads` must be an array (an absent list is not "no archive"). */
export function assertArchivedSnapshot(raw: unknown): asserts raw is { threads: Raw[] } {
  const what = "archived shell snapshot";
  if (!isObject(raw)) fail(what, "the result is not an object");
  assertThreadShells(raw.threads, what);
}

/** A thread detail or bounded snapshot: a projection with a thread and array record lists. */
export function assertThreadDetail(raw: unknown, what = "thread snapshot"): void {
  if (!isObject(raw)) fail(what, "the body is not a JSON object");
  const p = raw.projection;
  if (!isObject(p)) {
    // Legacy (pre-protocol-2) detail: { thread: { messages, activities } }.
    if (isObject(raw.thread) && isNonEmptyString(raw.thread.id)) return;
    fail(what, "projection is missing");
  }
  if (!isObject(p.thread) || !isNonEmptyString(p.thread.id)) fail(what, "projection.thread is missing");
  if (typeof raw.snapshotSequence !== "number") fail(what, "snapshotSequence is missing");
  // Protocol 2 always sends these lists; a missing one would read as "no runs" or "no queue".
  for (const key of ["runs", "messages"] as const) {
    if (!Array.isArray(p[key])) fail(what, `projection.${key} is missing or not an array`);
  }
  for (const [i, run] of ((p.runs as unknown[] | undefined) ?? []).entries()) {
    if (!isObject(run) || !isNonEmptyString(run.id) || !isNonEmptyString(run.status)) {
      fail(what, `run #${i} has no id or status`);
    }
  }
  for (const [i, m] of ((p.messages as unknown[] | undefined) ?? []).entries()) {
    if (!isObject(m) || !isNonEmptyString(m.id)) fail(what, `message #${i} has no id`);
  }
}

/** A command result: `{ sequence: number }`. */
export function assertDispatchResult(raw: unknown): asserts raw is { sequence: number } {
  if (!isObject(raw) || typeof raw.sequence !== "number") fail("command result", "sequence is missing");
}
