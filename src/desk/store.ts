// Launch desk queue state: pure queue rules plus the shared desk.json file.
// Several t3code-mcp processes (one per MCP client) share one file, so every
// change runs under a lock file and the file is always written whole
// (temp file, fsync, rename).
import {
  appendFileSync,
  closeSync,
  copyFileSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

export type Priority = "ned" | "normal";
export type EntryState = "waiting" | "granted" | "launched" | "expired" | "cancelled";

export interface DeskEntry {
  id: string;
  lane: string;
  project: string;
  task: string;
  priority: Priority;
  state: EntryState;
  created_at: string;
  granted_at: string | null;
  grant_expires_at: string | null;
  thread_id: string | null;
  /** When the entry last changed state (history trimming uses it). */
  updated_at: string;
  /** Order inside its priority class: created time in ms, changed only by moveBefore. */
  sort_key: number;
  launched_at?: string | null;
}

export interface DeskState {
  version: 1;
  entries: DeskEntry[];
}

export interface SlotContext {
  runningThreadIds: string[];
  cap: number;
  /** Host commit percent; null when host-guard status is unreadable (does not block). */
  commitPercent: number | null;
  nowMs: number;
  grantWindowMs?: number;
}

export const GRANT_WINDOW_MS = 10 * 60_000;
export const WAITING_TTL_MS = 24 * 60 * 60_000;
export const HISTORY_LIMIT = 200;
export const MEMORY_BLOCK_PERCENT = 90;
/** A launch holds its slot this long even before T3 shows its session. */
export const RECENT_LAUNCH_MS = 2 * 60_000;

const iso = (ms: number) => new Date(ms).toISOString();
const isActive = (e: DeskEntry) => e.state === "waiting" || e.state === "granted";

export function emptyState(): DeskState {
  return { version: 1, entries: [] };
}

export function enqueue(
  state: DeskState,
  req: { lane: string; project: string; task: string; priority: Priority; nowMs: number },
): DeskEntry {
  const entry: DeskEntry = {
    id: randomUUID(),
    lane: req.lane,
    project: req.project,
    task: req.task,
    priority: req.priority,
    state: "waiting",
    created_at: iso(req.nowMs),
    granted_at: null,
    grant_expires_at: null,
    thread_id: null,
    updated_at: iso(req.nowMs),
    sort_key: req.nowMs,
  };
  state.entries.push(entry);
  return entry;
}

/** Waiting entries in grant order: Ned first, then by sort key (created time), then insertion order. */
export function orderedWaiting(state: DeskState): DeskEntry[] {
  return state.entries
    .filter((e) => e.state === "waiting")
    .sort((a, b) => {
      if (a.priority !== b.priority) return a.priority === "ned" ? -1 : 1;
      return a.sort_key - b.sort_key; // stable sort: equal keys keep insertion order
    });
}

/** 1-based dense position among waiting entries; null when not waiting. */
export function positionOf(state: DeskState, id: string): number | null {
  const i = orderedWaiting(state).findIndex((e) => e.id === id);
  return i < 0 ? null : i + 1;
}

/** Slots in use: running T3 threads + live grants + launches T3 does not show yet. */
export function slotsUsed(state: DeskState, ctx: SlotContext): number {
  const running = new Set(ctx.runningThreadIds);
  let used = running.size;
  for (const e of state.entries) {
    if (e.state === "granted") used++;
    else if (
      e.state === "launched" &&
      e.launched_at &&
      ctx.nowMs - Date.parse(e.launched_at) < RECENT_LAUNCH_MS &&
      !(e.thread_id && running.has(e.thread_id))
    )
      used++;
  }
  return used;
}

export function memoryAllowsGrant(commitPercent: number | null): boolean {
  return commitPercent === null || commitPercent < MEMORY_BLOCK_PERCENT;
}

/** Expire grants past their window and waiting entries older than 24 h. */
export function expireEntries(state: DeskState, nowMs: number): DeskEntry[] {
  const expired: DeskEntry[] = [];
  for (const e of state.entries) {
    const grantOver = e.state === "granted" && e.grant_expires_at && nowMs >= Date.parse(e.grant_expires_at);
    const waitOver = e.state === "waiting" && nowMs - Date.parse(e.created_at) >= WAITING_TTL_MS;
    if (grantOver || waitOver) {
      e.state = "expired";
      e.updated_at = iso(nowMs);
      expired.push(e);
    }
  }
  return expired;
}

/** Grant the first waiting entries while a slot is free and memory allows. */
export function grantNext(state: DeskState, ctx: SlotContext): DeskEntry[] {
  const granted: DeskEntry[] = [];
  if (!memoryAllowsGrant(ctx.commitPercent)) return granted;
  let used = slotsUsed(state, ctx);
  for (const e of orderedWaiting(state)) {
    if (used >= ctx.cap) break;
    e.state = "granted";
    e.granted_at = iso(ctx.nowMs);
    e.grant_expires_at = iso(ctx.nowMs + (ctx.grantWindowMs ?? GRANT_WINDOW_MS));
    e.updated_at = iso(ctx.nowMs);
    granted.push(e);
    used++;
  }
  return granted;
}

export function recompute(state: DeskState, ctx: SlotContext) {
  const expired = expireEntries(state, ctx.nowMs);
  const granted = grantNext(state, ctx);
  return { expired, granted };
}

export function markLaunched(state: DeskState, id: string, threadId: string, nowMs: number): DeskEntry {
  const e = findEntry(state, id);
  e.state = "launched";
  e.thread_id = threadId;
  e.launched_at = iso(nowMs);
  e.updated_at = iso(nowMs);
  return e;
}

export function findEntry(state: DeskState, id: string): DeskEntry {
  const e = state.entries.find((x) => x.id === id);
  if (!e) throw new Error(`No queue entry ${id}. Use launch_queue to see the queue.`);
  return e;
}

/** Keep at most HISTORY_LIMIT entries; drop the oldest finished ones, never an active one. */
export function trimHistory(state: DeskState, limit = HISTORY_LIMIT): void {
  const excess = state.entries.length - limit;
  if (excess <= 0) return;
  const drop = new Set(
    state.entries
      .filter((e) => !isActive(e))
      .sort((a, b) => Date.parse(a.updated_at) - Date.parse(b.updated_at))
      .slice(0, excess),
  );
  state.entries = state.entries.filter((e) => !drop.has(e));
}

/** Put a waiting entry right before another waiting entry (it takes that entry's priority). */
export function moveBefore(state: DeskState, id: string, beforeId: string): DeskEntry {
  if (id === beforeId) throw new Error("An entry cannot move before itself.");
  const e = findEntry(state, id);
  const target = findEntry(state, beforeId);
  for (const x of [e, target]) {
    if (x.state !== "waiting") throw new Error(`Entry ${x.id} is ${x.state}, not waiting; only waiting entries move.`);
  }
  const others = orderedWaiting(state).filter((x) => x.id !== id);
  const i = others.findIndex((x) => x.id === beforeId);
  const prev = i > 0 ? others[i - 1] : undefined;
  e.priority = target.priority;
  e.sort_key =
    prev && prev.priority === target.priority ? (prev.sort_key + target.sort_key) / 2 : target.sort_key - 1;
  return e;
}

function isDeskState(v: unknown): v is DeskState {
  return (
    !!v &&
    typeof v === "object" &&
    (v as DeskState).version === 1 &&
    Array.isArray((v as DeskState).entries)
  );
}

/** Lock-open errors that mean "someone holds the lock": EEXIST, or EPERM on Windows while the previous lock file is still being deleted. */
export function lockBusy(code: string | undefined): boolean {
  return code === "EEXIST" || code === "EPERM";
}

const sleepSync = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

export interface DeskStoreOptions {
  lockTimeoutMs?: number;
  staleLockMs?: number;
}

/** The shared desk.json under one lock file. Synchronous: each change takes milliseconds. */
export class DeskStore {
  readonly file: string;
  readonly lockFile: string;
  readonly eventsFile: string;
  private readonly lockTimeoutMs: number;
  private readonly staleLockMs: number;
  private loggedCorrupt = false;

  constructor(
    readonly dir: string,
    opts: DeskStoreOptions = {},
  ) {
    this.file = join(dir, "desk.json");
    this.lockFile = join(dir, "desk.lock");
    this.eventsFile = join(dir, "events.jsonl");
    this.lockTimeoutMs = opts.lockTimeoutMs ?? 5_000;
    this.staleLockMs = opts.staleLockMs ?? 15_000;
  }

  /** Create the folder owner-only (current user and SYSTEM, no inherited access). */
  ensureDir(): void {
    if (existsSync(this.dir)) return;
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    if (process.platform === "win32") {
      const user = process.env.USERDOMAIN
        ? `${process.env.USERDOMAIN}\\${process.env.USERNAME}`
        : (process.env.USERNAME ?? "");
      execFileSync(
        "icacls",
        [this.dir, "/inheritance:r", "/grant:r", `${user}:(OI)(CI)F`, "/grant:r", "*S-1-5-18:(OI)(CI)F"],
        { stdio: "ignore", windowsHide: true },
      );
    }
  }

  logEvent(event: Record<string, unknown>): void {
    try {
      this.ensureDir();
      appendFileSync(this.eventsFile, `${JSON.stringify({ at: new Date().toISOString(), ...event })}\n`);
    } catch (e) {
      console.error("launch-desk: could not write event log:", (e as Error).message);
    }
  }

  /** Read without the lock. A missing file is empty; a corrupt one is empty and logged once. */
  read(): DeskState {
    let raw: string;
    try {
      raw = readFileSync(this.file, "utf8");
    } catch {
      return emptyState();
    }
    try {
      const parsed = JSON.parse(raw);
      if (isDeskState(parsed)) return parsed;
      throw new Error("wrong shape");
    } catch (e) {
      if (!this.loggedCorrupt) {
        this.loggedCorrupt = true;
        try {
          copyFileSync(this.file, `${this.file}.corrupt`);
        } catch {
          /* best effort */
        }
        this.logEvent({ type: "corrupt_state", detail: (e as Error).message });
        console.error(`launch-desk: ${this.file} is corrupt (${(e as Error).message}); reading it as empty.`);
      }
      return emptyState();
    }
  }

  private acquire(): void {
    const deadline = Date.now() + this.lockTimeoutMs;
    for (;;) {
      try {
        const fd = openSync(this.lockFile, "wx");
        writeSync(fd, String(process.pid));
        closeSync(fd);
        return;
      } catch (e) {
        if (!lockBusy((e as NodeJS.ErrnoException).code)) throw e;
      }
      try {
        if (Date.now() - statSync(this.lockFile).mtimeMs > this.staleLockMs) {
          rmSync(this.lockFile, { force: true });
          this.logEvent({ type: "stale_lock_broken" });
          continue;
        }
      } catch {
        // lock vanished (or is being deleted) between open and stat: retry after the deadline check
      }
      if (Date.now() >= deadline) {
        throw new Error(`launch-desk: could not take the lock ${this.lockFile} within ${this.lockTimeoutMs} ms.`);
      }
      sleepSync(10 + Math.floor(Math.random() * 20));
    }
  }

  private release(): void {
    try {
      unlinkSync(this.lockFile);
    } catch {
      /* already gone */
    }
  }

  private write(state: DeskState): void {
    const tmp = `${this.file}.${process.pid}.${randomUUID()}.tmp`;
    const fd = openSync(tmp, "w");
    try {
      writeSync(fd, JSON.stringify(state, null, 1));
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    for (let attempt = 0; ; attempt++) {
      try {
        renameSync(tmp, this.file);
        return;
      } catch (e) {
        // Windows: a reader holding the file without delete sharing; retry briefly.
        if (attempt >= 20) {
          rmSync(tmp, { force: true });
          throw e;
        }
        sleepSync(10);
      }
    }
  }

  /** Read, change and write the state under the lock; history is trimmed on every write. */
  update<T>(fn: (state: DeskState) => T): T {
    this.ensureDir();
    this.acquire();
    try {
      const state = this.read();
      const result = fn(state);
      trimHistory(state);
      this.write(state);
      return result;
    } finally {
      this.release();
    }
  }
}
