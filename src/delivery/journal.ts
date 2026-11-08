// Delivery journal: one file per send attempt that changes T3 (queued-run.start for send_now,
// message.dispatch for send_message), written before the command is sent.
//
// - Every change to a record happens under a short per-record lock file and is fenced by the
//   record's claim token: a writer holding an older version (another process resolved it, and a
//   new send claimed the slot) cannot overwrite or archive the newer record. Writes are whole-file
//   (temp, rename), so a reader never sees half a record.
// - `in_flight` while the owner waits for T3; `unknown` once the outcome could not be proven.
//   Both block another send of the same message.
// - Only proof clears a record (T3's answer, the run's state, or an idempotent replay with the
//   same commandId). The owner process exiting does not, and neither does the message still
//   being queued (an accepted queued-run.start can leave its run queued).
// - Resolved records move to resolved/ and are kept for audit.
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { deliveryStateDir } from "../config.js";

export const JOURNAL_SCHEMA = "t3code-mcp.delivery/v1";

export type JournalStatus = "in_flight" | "unknown" | "resolved";
export type Resolution =
  | "delivered"
  | "accepted_not_started"
  | "rejected"
  | "not_sent"
  | "not_queued";

export interface JournalEvent {
  at: string;
  event: string;
  detail?: string;
}

export interface JournalRecord {
  schema: typeof JOURNAL_SCHEMA;
  key: string;
  /** Unique per claim: fences every later change to this record. */
  claimToken: string;
  threadId: string;
  /** What the command acts on: a queued run (send_now) or a new message (send_message). */
  subject: { kind: "queued-run"; runId: string } | { kind: "message"; messageId: string };
  messageId: string | null;
  textSha256: string | null;
  commandId: string;
  commandType: string;
  /** The exact command sent, so a reconcile replays it unchanged. */
  command: Record<string, unknown>;
  releaseHold: boolean;
  status: JournalStatus;
  resolution: Resolution | null;
  owner: { pid: number; host: string; instance: string };
  createdAt: string;
  updatedAt: string;
  events: JournalEvent[];
}

export type ClaimResult = { ok: true; record: JournalRecord } | { ok: false; existing: JournalRecord };

/** The record changed under us (resolved elsewhere, or replaced by a newer claim). */
export class JournalConflictError extends Error {}

/** A lock file older than this belongs to a crashed writer (critical sections take milliseconds). */
const STALE_LOCK_MS = 10_000;
const LOCK_WAIT_MS = 5_000;
const sleepSync = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/** An in-flight record older than this (no update) is no longer considered owned by a live call. */
export const STALE_IN_FLIGHT_MS = 30 * 60_000;

/** One id per process, so a reused pid on the same host is not mistaken for the owner. */
const INSTANCE = randomUUID();

export function journalKey(threadId: string, subjectId: string): string {
  return createHash("sha256").update(`${threadId}\n${subjectId}`).digest("hex").slice(0, 40);
}

const subjectIdOf = (s: JournalRecord["subject"]) => (s.kind === "queued-run" ? s.runId : s.messageId);

export class DeliveryJournal {
  private readonly openDir: string;
  private readonly resolvedDir: string;

  constructor(
    readonly dir: string,
    private readonly opts: { now?: () => number; pid?: number; host?: string; instance?: string } = {},
  ) {
    this.openDir = join(dir, "open");
    this.resolvedDir = join(dir, "resolved");
  }

  static fromEnv(): DeliveryJournal {
    return new DeliveryJournal(deliveryStateDir());
  }

  private now(): string {
    return new Date(this.opts.now?.() ?? Date.now()).toISOString();
  }

  private ensure(): void {
    mkdirSync(this.openDir, { recursive: true, mode: 0o700 });
    mkdirSync(this.resolvedDir, { recursive: true, mode: 0o700 });
  }

  private path(key: string): string {
    return join(this.openDir, `${key}.json`);
  }

  get owner(): JournalRecord["owner"] {
    return {
      pid: this.opts.pid ?? process.pid,
      host: this.opts.host ?? hostname(),
      instance: this.opts.instance ?? INSTANCE,
    };
  }

  /** The open record for this send, if any. An unreadable record counts as unknown. */
  get(threadId: string, subjectId: string): JournalRecord | null {
    return this.readPath(this.path(journalKey(threadId, subjectId)), threadId, subjectId);
  }

  private readPath(path: string, threadId?: string, subjectId?: string): JournalRecord | null {
    let text: string;
    try {
      text = readFileSync(path, "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw e;
    }
    try {
      const r = JSON.parse(text) as JournalRecord;
      if (r.schema !== JOURNAL_SCHEMA || typeof r.threadId !== "string" || !r.subject) throw new Error("schema");
      return r;
    } catch {
      // A record nobody can read still means a send may have happened: quarantine it.
      const key = path.split(/[\\/]/).pop()!.replace(/\.json$/, "");
      return {
        schema: JOURNAL_SCHEMA,
        key,
        claimToken: "(unreadable)",
        threadId: threadId ?? "(unreadable)",
        subject: { kind: "queued-run", runId: subjectId ?? "(unreadable)" },
        messageId: null,
        textSha256: null,
        commandId: "(unreadable)",
        commandType: "(unreadable)",
        command: {},
        releaseHold: false,
        status: "unknown",
        resolution: null,
        owner: { pid: 0, host: "(unreadable)", instance: "(unreadable)" },
        createdAt: this.now(),
        updatedAt: this.now(),
        events: [{ at: this.now(), event: "unreadable", detail: `journal file ${path} could not be parsed` }],
      };
    }
  }

  /** Every record that is not resolved (in flight or unknown). */
  open(): JournalRecord[] {
    if (!existsSync(this.openDir)) return [];
    return readdirSync(this.openDir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => this.readPath(join(this.openDir, f)))
      .filter((r): r is JournalRecord => r !== null && r.status !== "resolved");
  }

  /** Write the record whole, atomically replacing the previous version. Call under the lock. */
  private write(record: JournalRecord): void {
    this.ensure();
    const tmp = join(this.openDir, `.${record.key}.${process.pid}.${randomUUID()}.tmp`);
    writeFileSync(tmp, JSON.stringify(record, null, 1), { mode: 0o600 });
    renameSync(tmp, this.path(record.key));
  }

  /** Run fn while holding the record's lock file (exclusive create; a crashed holder's lock expires). */
  private withLock<T>(key: string, fn: () => T): T {
    this.ensure();
    const lock = join(this.openDir, `${key}.lock`);
    const token = `${process.pid}:${randomUUID()}`;
    const waitUntil = Date.now() + LOCK_WAIT_MS;
    for (;;) {
      try {
        writeFileSync(lock, token, { flag: "wx", mode: 0o600 });
        break;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
        try {
          if (Date.now() - statSync(lock).mtimeMs > STALE_LOCK_MS) unlinkSync(lock);
        } catch {
          // released or broken meanwhile
        }
        if (Date.now() > waitUntil) throw new Error(`delivery journal record ${key} is locked by another process`);
        sleepSync(10);
      }
    }
    try {
      return fn();
    } finally {
      try {
        if (readFileSync(lock, "utf8") === token) unlinkSync(lock);
      } catch {
        // already gone
      }
    }
  }

  /**
   * Claim a send before its command goes out. Fails (returning the existing record) while
   * another record for the same message is open. A resolved leftover is moved aside first.
   */
  claim(input: {
    threadId: string;
    subject: JournalRecord["subject"];
    messageId: string | null;
    textSha256: string | null;
    command: Record<string, unknown> & { commandId: string; type: string };
    releaseHold?: boolean;
  }): ClaimResult {
    const subjectId = subjectIdOf(input.subject);
    const key = journalKey(input.threadId, subjectId);
    return this.withLock(key, (): ClaimResult => {
      const existing = this.readPath(this.path(key), input.threadId, subjectId);
      if (existing && existing.status !== "resolved") return { ok: false, existing };
      if (existing) this.archiveUnlocked(existing);
      const at = this.now();
      const record: JournalRecord = {
        schema: JOURNAL_SCHEMA,
        key,
        claimToken: randomUUID(),
        threadId: input.threadId,
        subject: input.subject,
        messageId: input.messageId,
        textSha256: input.textSha256,
        commandId: input.command.commandId,
        commandType: input.command.type,
        command: input.command,
        releaseHold: input.releaseHold === true,
        status: "in_flight",
        resolution: null,
        owner: this.owner,
        createdAt: at,
        updatedAt: at,
        events: [{ at, event: "claimed" }],
      };
      this.write(record);
      return { ok: true, record };
    });
  }

  /** The current version of this very claim, or a conflict error. Call under the lock. */
  private current(record: JournalRecord): JournalRecord {
    const now = this.readPath(this.path(record.key), record.threadId, subjectIdOf(record.subject));
    if (!now || now.claimToken !== record.claimToken || now.status === "resolved") {
      throw new JournalConflictError(
        `delivery journal record for ${record.threadId} ${subjectIdOf(record.subject)} was changed by another call`,
      );
    }
    return now;
  }

  /** Append an event (and optionally change status) on an open record. */
  note(record: JournalRecord, event: string, detail?: string, status?: JournalStatus): JournalRecord {
    return this.withLock(record.key, () => {
      const cur = this.current(record);
      const at = this.now();
      const next: JournalRecord = {
        ...cur,
        status: status ?? cur.status,
        updatedAt: at,
        events: [...cur.events, { at, event, ...(detail ? { detail } : {}) }],
      };
      this.write(next);
      return next;
    });
  }

  /** Mark proven and move to resolved/. */
  resolve(record: JournalRecord, resolution: Resolution, detail?: string): JournalRecord {
    return this.withLock(record.key, () => {
      const cur = this.current(record);
      const at = this.now();
      const next: JournalRecord = {
        ...cur,
        status: "resolved",
        resolution,
        updatedAt: at,
        events: [...cur.events, { at, event: `resolved:${resolution}`, ...(detail ? { detail } : {}) }],
      };
      this.write(next);
      this.archiveUnlocked(next);
      return next;
    });
  }

  /** Move the open file aside. Call under the lock, with the version just read or written. */
  private archiveUnlocked(record: JournalRecord): void {
    this.ensure();
    const target = join(this.resolvedDir, `${record.key}-${Date.parse(record.updatedAt) || Date.now()}-${randomUUID().slice(0, 8)}.json`);
    try {
      renameSync(this.path(record.key), target);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
  }

  /** Whether the record's owner is this very process (same host, pid and process instance). */
  ownedByMe(record: JournalRecord): boolean {
    const me = this.owner;
    return record.owner.host === me.host && record.owner.pid === me.pid && record.owner.instance === me.instance;
  }

  /**
   * An in-flight record whose owner may still be working on it: another call must not touch it.
   * Past STALE_IN_FLIGHT_MS without an update it is no longer treated as live (a reused pid must
   * not block reconciliation forever); it stays quarantined until reconciled.
   */
  isLive(record: JournalRecord): boolean {
    if (record.status !== "in_flight") return false;
    const age = (this.opts.now?.() ?? Date.now()) - Date.parse(record.updatedAt);
    if (!(age < STALE_IN_FLIGHT_MS)) return false;
    return this.ownedByMe(record) || this.ownerAlive(record) !== false;
  }

  /** Best effort: whether the owner process still runs (same host only; otherwise unknown). */
  ownerAlive(record: JournalRecord): boolean | null {
    if (record.owner.host !== this.owner.host) return null;
    try {
      process.kill(record.owner.pid, 0);
      return true;
    } catch (e) {
      return (e as NodeJS.ErrnoException).code === "EPERM" ? true : false;
    }
  }
}

/** Summary for tool output (no command payload text). */
export function describeRecord(j: DeliveryJournal, r: JournalRecord) {
  return {
    threadId: r.threadId,
    subject: r.subject,
    messageId: r.messageId,
    textSha256: r.textSha256,
    commandId: r.commandId,
    commandType: r.commandType,
    status: r.status,
    resolution: r.resolution,
    owner: { ...r.owner, alive: j.ownerAlive(r), thisProcess: j.ownedByMe(r) },
    live: j.isLive(r),
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    lastEvent: r.events.at(-1) ?? null,
  };
}
