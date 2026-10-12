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
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

export type Priority = "ned" | "normal";
export type EntryState = "waiting" | "granted" | "launching" | "launched" | "failed" | "expired" | "cancelled";
/** create: create_thread; resume: send_message to a stopped thread (restarts its session). */
export type EntryKind = "create" | "resume";

const PRIORITIES: readonly string[] = ["ned", "normal"];
const STATES: readonly string[] = ["waiting", "granted", "launching", "launched", "failed", "expired", "cancelled"];
const KINDS: readonly string[] = ["create", "resume"];

export interface DeskEntry {
  id: string;
  lane: string;
  project: string;
  project_id: string;
  task: string;
  kind: EntryKind;
  /** For resume entries: the thread the grant may restart. */
  target_thread_id: string | null;
  priority: Priority;
  state: EntryState;
  created_at: string;
  granted_at: string | null;
  grant_expires_at: string | null;
  thread_id: string | null;
  /** When the entry last changed (history trimming uses it). */
  updated_at: string;
  /** Order inside its priority class: from the desk counter, changed only by moveBefore. */
  sort_key: number;
  /** Launch time (launched) or attempt time (failed); such entries hold a slot for 2 minutes. */
  launched_at?: string | null;
  /** Token of the launch in progress (state launching). */
  claim?: string | null;
  claimed_at?: string | null;
}

export interface DeskState {
  version: 1;
  /** Counter for sort keys; only goes up. */
  seq: number;
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
/** A launch (or failed attempt) holds its slot this long even before T3 shows its session. */
export const RECENT_LAUNCH_MS = 2 * 60_000;
/** A launch in progress longer than this is failed: the process that claimed it died. */
export const CLAIM_TTL_MS = 5 * 60_000;
/** Leftover temp and stale-lock files older than this are swept at start. */
export const SWEEP_AGE_MS = 60_000;

const iso = (ms: number) => new Date(ms).toISOString();
/** Entries that are never trimmed and that block a slot or the queue. */
const isActive = (e: DeskEntry) => e.state === "waiting" || e.state === "granted" || e.state === "launching";

export function emptyState(): DeskState {
  return { version: 1, seq: 0, entries: [] };
}

export function enqueue(
  state: DeskState,
  req: {
    lane: string;
    project: string;
    project_id: string;
    task: string;
    priority: Priority;
    nowMs: number;
    kind?: EntryKind;
    target_thread_id?: string | null;
  },
): DeskEntry {
  state.seq = (state.seq ?? 0) + 1;
  const entry: DeskEntry = {
    id: randomUUID(),
    lane: req.lane,
    project: req.project,
    project_id: req.project_id,
    task: req.task,
    kind: req.kind ?? "create",
    target_thread_id: req.target_thread_id ?? null,
    priority: req.priority,
    state: "waiting",
    created_at: iso(req.nowMs),
    granted_at: null,
    grant_expires_at: null,
    thread_id: null,
    updated_at: iso(req.nowMs),
    sort_key: state.seq,
  };
  state.entries.push(entry);
  return entry;
}

/** Waiting entries in grant order: Ned first, then by sort key; equal keys keep array order. */
export function orderedWaiting(state: DeskState): DeskEntry[] {
  return state.entries
    .filter((e) => e.state === "waiting")
    .sort((a, b) => {
      if (a.priority !== b.priority) return a.priority === "ned" ? -1 : 1;
      return a.sort_key - b.sort_key;
    });
}

/** 1-based dense position among waiting entries; null when not waiting. */
export function positionOf(state: DeskState, id: string): number | null {
  const i = orderedWaiting(state).findIndex((e) => e.id === id);
  return i < 0 ? null : i + 1;
}

/** Slots in use: running T3 threads + grants + launches in progress + recent launches T3 does not show yet. */
export function slotsUsed(state: DeskState, ctx: SlotContext): number {
  const running = new Set(ctx.runningThreadIds);
  let used = running.size;
  for (const e of state.entries) {
    if (e.state === "granted" || e.state === "launching") used++;
    else if (
      (e.state === "launched" || e.state === "failed") &&
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

/** Expire grants past their window, waiting entries older than 24 h; fail launches stuck over 5 min. */
export function expireEntries(state: DeskState, nowMs: number): DeskEntry[] {
  const expired: DeskEntry[] = [];
  for (const e of state.entries) {
    const grantOver = e.state === "granted" && e.grant_expires_at && nowMs >= Date.parse(e.grant_expires_at);
    const waitOver = e.state === "waiting" && nowMs - Date.parse(e.created_at) >= WAITING_TTL_MS;
    const claimOver = e.state === "launching" && e.claimed_at && nowMs - Date.parse(e.claimed_at) >= CLAIM_TTL_MS;
    if (grantOver || waitOver) {
      e.state = "expired";
    } else if (claimOver) {
      e.state = "failed";
      e.launched_at = e.claimed_at;
      e.claim = null;
    } else continue;
    e.updated_at = iso(nowMs);
    expired.push(e);
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

export function findEntry(state: DeskState, id: string): DeskEntry {
  const e = state.entries.find((x) => x.id === id);
  if (!e) throw new Error(`No queue entry ${id}. Use launch_queue to see the queue.`);
  return e;
}

/** Take a granted entry for one launch. Returns the claim token; a second claim is refused. */
export function claim(state: DeskState, id: string, nowMs: number): string {
  const e = findEntry(state, id);
  if (e.state === "launching") {
    throw new Error(`Queue entry ${id}: a launch is already in progress for this grant. Do not launch it again.`);
  }
  if (e.state !== "granted") throw new Error(`Queue entry ${id} is ${e.state}, not granted.`);
  const token = randomUUID();
  e.state = "launching";
  e.claim = token;
  e.claimed_at = iso(nowMs);
  e.updated_at = iso(nowMs);
  return token;
}

export function markLaunched(state: DeskState, id: string, threadId: string, nowMs: number, token: string): DeskEntry {
  const e = findEntry(state, id);
  if (e.state !== "launching" || e.claim !== token) {
    throw new Error(`Queue entry ${id}: the launch claim does not match (state ${e.state}).`);
  }
  e.state = "launched";
  e.thread_id = threadId;
  e.launched_at = iso(nowMs);
  e.updated_at = iso(nowMs);
  e.claim = null;
  return e;
}

/**
 * A launch did not finish. Before any thread.create (or turn start) was sent, the grant
 * comes back. After, the outcome is unknown: the entry is failed and holds its slot for
 * 2 minutes, and the grant cannot launch again.
 */
export function releaseClaim(
  state: DeskState,
  id: string,
  token: string,
  out: { createSent: boolean; threadId: string; nowMs: number },
): void {
  const e = findEntry(state, id);
  if (e.state !== "launching" || e.claim !== token) return;
  e.claim = null;
  e.updated_at = iso(out.nowMs);
  if (!out.createSent) {
    e.state = "granted";
    return;
  }
  e.state = "failed";
  e.thread_id = out.threadId;
  e.launched_at = e.claimed_at ?? iso(out.nowMs);
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

/**
 * Put a waiting entry right before another waiting entry. It takes that entry's priority.
 * All waiting entries are renumbered from the counter, so equal keys cannot block a move.
 */
export function moveBefore(state: DeskState, id: string, beforeId: string, nowMs: number): DeskEntry {
  if (id === beforeId) throw new Error("An entry cannot move before itself.");
  const e = findEntry(state, id);
  const target = findEntry(state, beforeId);
  for (const x of [e, target]) {
    if (x.state !== "waiting") throw new Error(`Entry ${x.id} is ${x.state}, not waiting; only waiting entries move.`);
  }
  const order = orderedWaiting(state).filter((x) => x.id !== id);
  order.splice(order.indexOf(target), 0, e);
  e.priority = target.priority;
  e.updated_at = iso(nowMs);
  for (const x of order) x.sort_key = ++state.seq;
  return e;
}

const isStr = (v: unknown): v is string => typeof v === "string";
const isTime = (v: unknown) => isStr(v) && Number.isFinite(Date.parse(v));
const strOrNull = (v: unknown) => v === null || v === undefined || isStr(v);

function validEntry(e: unknown): boolean {
  if (!e || typeof e !== "object") return false;
  const x = e as Record<string, unknown>;
  return (
    isStr(x.id) &&
    isStr(x.lane) &&
    isStr(x.project) &&
    isStr(x.project_id) &&
    isStr(x.task) &&
    KINDS.includes(x.kind as string) &&
    strOrNull(x.target_thread_id) &&
    PRIORITIES.includes(x.priority as string) &&
    STATES.includes(x.state as string) &&
    isTime(x.created_at) &&
    isTime(x.updated_at) &&
    strOrNull(x.granted_at) &&
    strOrNull(x.grant_expires_at) &&
    strOrNull(x.thread_id) &&
    Number.isFinite(x.sort_key)
  );
}

/** Shape check for desk.json, entry by entry. */
export function validState(v: unknown): v is DeskState {
  if (!v || typeof v !== "object") return false;
  const s = v as Record<string, unknown>;
  return (
    s.version === 1 &&
    (s.seq === undefined || (typeof s.seq === "number" && Number.isFinite(s.seq))) &&
    Array.isArray(s.entries) &&
    s.entries.every(validEntry)
  );
}

/** Lock-open errors that mean "someone holds the lock": EEXIST, or EPERM on Windows while the previous lock file is still being deleted. */
export function lockBusy(code: string | undefined): boolean {
  return code === "EEXIST" || code === "EPERM";
}

/**
 * True when icacls output for `dir` lists only `user` and SYSTEM, with nothing inherited.
 * Lines look like `<dir> NT AUTHORITY\SYSTEM:(OI)(CI)(F)` then indented `DOMAIN\user:(...)`.
 */
export function aclIsOwnerOnly(output: string, dir: string, user: string): boolean {
  const allowed = new Set([user.toLowerCase(), "nt authority\\system"]);
  let aces = 0;
  for (const raw of output.split(/\r?\n/)) {
    let line = raw.startsWith(dir) ? raw.slice(dir.length) : raw;
    line = line.trim();
    const i = line.indexOf(":(");
    if (i < 0) continue;
    aces++;
    const principal = line.slice(0, i).trim().toLowerCase();
    const flags = line.slice(i + 1);
    if (flags.includes("(I)") || !allowed.has(principal)) return false;
  }
  return aces > 0;
}

/** Principals named in icacls output other than `user` and SYSTEM. */
function otherPrincipals(output: string, dir: string, user: string): string[] {
  const keep = new Set([user.toLowerCase(), "nt authority\\system"]);
  const out: string[] = [];
  for (const raw of output.split(/\r?\n/)) {
    const line = (raw.startsWith(dir) ? raw.slice(dir.length) : raw).trim();
    const i = line.indexOf(":(");
    if (i < 0) continue;
    const p = line.slice(0, i).trim();
    if (!keep.has(p.toLowerCase()) && !out.includes(p)) out.push(p);
  }
  return out;
}

const sleepSync = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

function readText(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

/** Folders already made owner-only and swept by this process. */
const prepared = new Set<string>();

export interface DeskStoreOptions {
  lockTimeoutMs?: number;
  staleLockMs?: number;
  /** Platform for the ACL step (tests). */
  platform?: NodeJS.Platform;
  /** icacls runner (tests); returns stdout. */
  icacls?: (args: string[]) => string;
  /** Owner principal as icacls prints it (default %USERDOMAIN%\%USERNAME%). */
  user?: string;
  /** Tests only: called inside stale-lock breaking ("guard": guard taken; "rename": before the rename). */
  testHook?: (stage: "guard" | "rename") => void;
}

/** The shared desk.json under one lock file. Synchronous: each change takes milliseconds. */
export class DeskStore {
  readonly file: string;
  readonly lockFile: string;
  readonly eventsFile: string;
  private readonly lockTimeoutMs: number;
  private readonly staleLockMs: number;
  private readonly platform: NodeJS.Platform;
  private readonly icacls: (args: string[]) => string;
  private readonly user: string;
  private readonly testHook: (stage: "guard" | "rename") => void;
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
    this.platform = opts.platform ?? process.platform;
    this.testHook = opts.testHook ?? (() => {});
    this.icacls =
      opts.icacls ?? ((args) => execFileSync("icacls", args, { encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }));
    this.user =
      opts.user ??
      (process.env.USERDOMAIN ? `${process.env.USERDOMAIN}\\${process.env.USERNAME}` : (process.env.USERNAME ?? ""));
  }

  /**
   * Create the folder and, once per process, make sure it is owner-only (current user and
   * SYSTEM, nothing inherited) and sweep leftovers. Throws when owner-only cannot be set.
   */
  ensureDir(): void {
    if (!existsSync(this.dir)) mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    if (prepared.has(this.dir)) return;
    if (this.platform === "win32") this.secureAcl();
    this.sweep();
    prepared.add(this.dir);
  }

  private secureAcl(): void {
    const refuse = (detail: string) =>
      new Error(`launch-desk: refusing ${this.dir}: owner-only access could not be set (${detail}).`);
    const check = () => this.icacls([this.dir]);
    try {
      let out = check();
      if (aclIsOwnerOnly(out, this.dir, this.user)) return;
      this.icacls([this.dir, "/inheritance:r", "/grant:r", `${this.user}:(OI)(CI)F`, "/grant:r", "*S-1-5-18:(OI)(CI)F"]);
      out = check();
      for (const p of otherPrincipals(out, this.dir, this.user)) {
        this.icacls([this.dir, "/remove", /^S-1-/i.test(p) ? `*${p}` : p]); // raw SIDs need the * prefix
      }
      out = check();
      if (!aclIsOwnerOnly(out, this.dir, this.user)) throw refuse("access other than the owner remains");
      this.logEvent({ type: "acl_applied" });
    } catch (e) {
      if ((e as Error).message.startsWith("launch-desk: refusing")) throw e;
      throw refuse((e as Error).message);
    }
  }

  /** Remove temp files and stale-lock leftovers that a crashed process left behind. */
  private sweep(): void {
    let names: string[];
    try {
      names = readdirSync(this.dir);
    } catch {
      return;
    }
    for (const n of names) {
      if (!(n.startsWith("desk.json.") && n.endsWith(".tmp")) && !n.startsWith("desk.lock.stale.")) continue;
      const p = join(this.dir, n);
      try {
        if (Date.now() - statSync(p).mtimeMs > SWEEP_AGE_MS) rmSync(p, { force: true });
      } catch {
        /* gone already */
      }
    }
  }

  logEvent(event: Record<string, unknown>): void {
    try {
      if (!existsSync(this.dir)) mkdirSync(this.dir, { recursive: true, mode: 0o700 });
      appendFileSync(this.eventsFile, `${JSON.stringify({ at: new Date().toISOString(), ...event })}\n`);
    } catch (e) {
      console.error("launch-desk: could not write event log:", (e as Error).message);
    }
  }

  /** Read without the lock. Missing: empty. Corrupt: empty, a timestamped copy, logged once until a good read. */
  read(): DeskState {
    const raw = readText(this.file);
    if (raw === null) return emptyState();
    let detail: string;
    try {
      const parsed = JSON.parse(raw);
      if (validState(parsed)) {
        this.loggedCorrupt = false;
        parsed.seq ??= 0;
        return parsed;
      }
      detail = "invalid shape or entry";
    } catch (e) {
      detail = (e as Error).message;
    }
    if (!this.loggedCorrupt) {
      this.loggedCorrupt = true;
      const copy = `${this.file}.corrupt-${Date.now()}`;
      try {
        copyFileSync(this.file, copy);
      } catch {
        /* best effort */
      }
      this.logEvent({ type: "corrupt_state", detail, copy });
      console.error(`launch-desk: ${this.file} is corrupt (${detail}); reading it as empty. Copy: ${copy}`);
    }
    return emptyState();
  }

  /** Take the lock; returns this holder's token (pid:uuid), written into the lock file. */
  private acquire(): string {
    const token = `${process.pid}:${randomUUID()}`;
    const deadline = Date.now() + this.lockTimeoutMs;
    for (;;) {
      try {
        const fd = openSync(this.lockFile, "wx");
        try {
          writeSync(fd, token);
        } finally {
          closeSync(fd);
        }
        return token;
      } catch (e) {
        if (!lockBusy((e as NodeJS.ErrnoException).code)) throw e;
      }
      if (this.breakIfStale()) continue;
      if (Date.now() >= deadline) {
        throw new Error(`launch-desk: could not take the lock ${this.lockFile} within ${this.lockTimeoutMs} ms.`);
      }
      sleepSync(10 + Math.floor(Math.random() * 20));
    }
  }

  /** True when the file exists and is older than staleLockMs. */
  private isStale(path: string): boolean {
    try {
      return Date.now() - statSync(path).mtimeMs > this.staleLockMs;
    } catch {
      return false; // gone or being deleted
    }
  }

  /**
   * Break a lock older than staleLockMs. One breaker at a time holds `desk.lock.break`
   * (a breaker that died leaves it stale, and it is cleared). Inside the guard the lock is
   * checked again and renamed to a unique name, so only one process wins the rename. If
   * what was renamed is not the stale lock that was seen (a fresh lock took its place), it
   * is put back. Returns true when this process broke the lock.
   */
  private breakIfStale(): boolean {
    if (!this.isStale(this.lockFile)) return false;
    const guard = `${this.lockFile}.break`;
    try {
      closeSync(openSync(guard, "wx"));
    } catch {
      if (this.isStale(guard)) rmSync(guard, { force: true }); // left by a breaker that died
      return false; // another process is breaking it
    }
    try {
      this.testHook("guard");
      if (!this.isStale(this.lockFile)) return false; // already broken and taken again
      const seen = readText(this.lockFile);
      if (seen === null) return false;
      const aside = `${this.lockFile}.stale.${randomUUID()}`;
      this.testHook("rename");
      try {
        renameSync(this.lockFile, aside);
      } catch {
        return false;
      }
      const got = readText(aside);
      if (got !== seen) {
        try {
          linkSync(aside, this.lockFile); // a fresh lock was renamed: put it back unless the name is taken
        } catch {
          /* someone already holds a new lock */
        }
        rmSync(aside, { force: true });
        return false;
      }
      rmSync(aside, { force: true });
      this.logEvent({ type: "stale_lock_broken", holder: seen });
      return true;
    } finally {
      rmSync(guard, { force: true });
    }
  }

  /** Delete the lock only while it still holds this holder's token. */
  private release(token: string): void {
    if (readText(this.lockFile) !== token) return;
    rmSync(this.lockFile, { force: true });
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
    const token = this.acquire();
    try {
      const state = this.read();
      const result = fn(state);
      trimHistory(state);
      this.write(state);
      return result;
    } finally {
      this.release(token);
    }
  }
}
