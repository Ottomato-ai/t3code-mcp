// Launch desk: at most `cap` live T3 threads across all lanes; when full, lanes queue.
// Design: Infra/docs/superpowers/specs/2026-10-12-t3-launch-queue-design.md
import { homedir } from "node:os";
import { join } from "node:path";
import type { ShellSnapshot } from "../model.js";
import { readHostGuardMemory, type MemoryReading } from "./memory.js";
import { runningThreadIds } from "./running.js";
import {
  DeskStore,
  GRANT_WINDOW_MS,
  enqueue,
  expireEntries,
  findEntry,
  markLaunched,
  moveBefore,
  orderedWaiting,
  positionOf,
  recompute,
  type DeskEntry,
  type DeskState,
  type SlotContext,
} from "./store.js";

/** The OttoContext lead owns the queue; only this lane may reorder it. */
export const LEAD_LANE = "(Resume) ** OttoContext";
export const DEFAULT_CAP = 15;
export const TICK_MS = 30_000;

export interface LaunchDeskOptions {
  store: DeskStore;
  cap: number;
  grantWindowMs?: number;
  readMemory?: () => MemoryReading;
  now?: () => number;
  /** launch_wait poll interval. */
  pollMs?: number;
}

export type Admission =
  | { kind: "launch"; entry: DeskEntry }
  | { kind: "queued"; entry: DeskEntry; position: number; running: number; cap: number; memory: MemoryReading };

export interface AdmitRequest {
  lane: string;
  project: string;
  task: string;
  ned: boolean;
  queueEntry?: string;
}

type ShellSource = { shell(): Promise<Pick<ShellSnapshot, "threads">> };

const isActive = (e: DeskEntry) => e.state === "waiting" || e.state === "granted";

function envInt(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return value !== undefined && value !== "" && Number.isInteger(n) && n >= 0 ? n : fallback;
}

export function defaultDeskDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.T3_LAUNCH_DESK_DIR) return env.T3_LAUNCH_DESK_DIR;
  const local = env.LOCALAPPDATA || join(homedir(), "AppData", "Local");
  return join(local, "OttoSystems", "launch-desk");
}

export class LaunchDesk {
  readonly store: DeskStore;
  readonly cap: number;
  readonly grantWindowMs: number;
  readonly pollMs: number;
  private readonly readMemory: () => MemoryReading;
  private readonly now: () => number;
  private lastMemoryStatus: MemoryReading["status"] = "ok";
  private ticker: NodeJS.Timeout | undefined;
  private tickErrorLogged = false;

  constructor(opts: LaunchDeskOptions) {
    this.store = opts.store;
    this.cap = opts.cap;
    this.grantWindowMs = opts.grantWindowMs ?? GRANT_WINDOW_MS;
    this.readMemory = opts.readMemory ?? (() => readHostGuardMemory());
    this.now = opts.now ?? Date.now;
    this.pollMs = opts.pollMs ?? 3_000;
  }

  /** T3_LAUNCH_CAP (default 15), T3_LAUNCH_GRANT_MINUTES (default 10), T3_LAUNCH_DESK_DIR. */
  static fromEnv(env: NodeJS.ProcessEnv = process.env): LaunchDesk {
    return new LaunchDesk({
      store: new DeskStore(defaultDeskDir(env)),
      cap: envInt(env.T3_LAUNCH_CAP, DEFAULT_CAP),
      grantWindowMs: envInt(env.T3_LAUNCH_GRANT_MINUTES, GRANT_WINDOW_MS / 60_000) * 60_000,
    });
  }

  /** Read host-guard; log once each time it turns unreadable or stale (it never blocks then). */
  memory(): MemoryReading {
    const m = this.readMemory();
    if (m.status !== "ok" && this.lastMemoryStatus === "ok") {
      this.store.logEvent({ type: "memory_unreadable", status: m.status, detail: m.detail });
      console.error(`launch-desk: host-guard status ${m.status} (${m.detail}); not blocking launches.`);
    }
    this.lastMemoryStatus = m.status;
    return m;
  }

  private ctx(runningIds: string[], memory: MemoryReading): SlotContext {
    return {
      runningThreadIds: runningIds,
      cap: this.cap,
      commitPercent: memory.blocks ? memory.commitPercent : null,
      nowMs: this.now(),
      grantWindowMs: this.grantWindowMs,
    };
  }

  /**
   * Decide a create_thread call. Returns launch (the entry is granted and reserved)
   * or queued. Throws with an instruction for refusals.
   */
  admit(req: AdmitRequest, runningIds: string[]): Admission {
    const memory = this.memory();
    const ctx = this.ctx(runningIds, memory);
    const queued = (state: DeskState, e: DeskEntry): Admission => ({
      kind: "queued",
      entry: { ...e },
      position: positionOf(state, e.id) ?? 0,
      running: runningIds.length,
      cap: this.cap,
      memory,
    });
    const result = this.store.update((state): Admission => {
      if (req.queueEntry) {
        const e = findEntry(state, req.queueEntry);
        if (e.lane !== req.lane) {
          throw new Error(
            `Queue entry ${e.id} belongs to lane "${e.lane}", not "${req.lane}". A grant launches only for its own lane.`,
          );
        }
        recompute(state, ctx);
        if (e.state === "granted") return { kind: "launch", entry: { ...e } };
        if (e.state === "waiting") return queued(state, e);
        throw new Error(
          e.state === "launched"
            ? `Queue entry ${e.id} already launched thread ${e.thread_id}.`
            : `Queue entry ${e.id} is ${e.state}. Call create_thread without queue_entry to join the queue again at the back.`,
        );
      }
      const e = enqueue(state, {
        lane: req.lane,
        project: req.project,
        task: req.task,
        priority: req.ned ? "ned" : "normal",
        nowMs: ctx.nowMs,
      });
      recompute(state, ctx);
      return e.state === "granted" ? { kind: "launch", entry: { ...e } } : queued(state, e);
    });
    if (req.ned && !req.queueEntry) {
      this.store.logEvent({ type: "ned_entry", id: result.entry.id, lane: req.lane, project: req.project });
      console.error(`launch-desk: ned_requested entry ${result.entry.id} from lane "${req.lane}".`);
    }
    return result;
  }

  markLaunched(id: string, threadId: string): void {
    this.store.update((state) => markLaunched(state, id, threadId, this.now()));
  }

  /** A launch failed: a grant from the queue stays for a retry; an immediate launch frees its slot. */
  launchFailed(id: string, keepGrant: boolean): void {
    if (keepGrant) return;
    this.store.update((state) => {
      const e = findEntry(state, id);
      if (e.state === "granted") {
        e.state = "cancelled";
        e.updated_at = new Date(this.now()).toISOString();
      }
    });
  }

  /** Expire and grant with a running count taken from T3 now. */
  tick(runningIds: string[]) {
    const ctx = this.ctx(runningIds, this.memory());
    return this.store.update((state) => recompute(state, ctx));
  }

  /** The 30-second tick: only calls T3 when an entry is waiting or granted. */
  async tickOnce(client: ShellSource): Promise<void> {
    if (!this.store.read().entries.some(isActive)) return;
    const shell = await client.shell();
    this.tick(runningThreadIds(shell));
  }

  startTicker(getClient: () => ShellSource, intervalMs = TICK_MS): void {
    if (this.ticker) return;
    this.ticker = setInterval(() => {
      Promise.resolve()
        .then(() => this.tickOnce(getClient()))
        .then(() => {
          this.tickErrorLogged = false;
        })
        .catch((e) => {
          if (!this.tickErrorLogged) console.error("launch-desk tick failed:", (e as Error).message);
          this.tickErrorLogged = true;
        });
    }, intervalMs);
    this.ticker.unref();
  }

  status(id: string): { entry: DeskEntry; position: number | null } {
    const state = this.store.read();
    return { entry: findEntry(state, id), position: positionOf(state, id) };
  }

  cancel(id: string, lane: string): DeskEntry {
    const e = this.store.update((state) => {
      const e = findEntry(state, id);
      if (e.lane !== lane) throw new Error(`Queue entry ${id} belongs to lane "${e.lane}"; a lane cancels only its own entry.`);
      if (!isActive(e)) throw new Error(`Queue entry ${id} is ${e.state}; only waiting or granted entries can be cancelled.`);
      e.state = "cancelled";
      e.updated_at = new Date(this.now()).toISOString();
      return { ...e };
    });
    this.store.logEvent({ type: "cancel", id, lane });
    return e;
  }

  move(id: string, before: string, lane: string): { entry: DeskEntry; position: number | null } {
    if (lane !== LEAD_LANE) {
      throw new Error(`Only the OttoContext lead ("${LEAD_LANE}") may reorder the launch queue.`);
    }
    const out = this.store.update((state) => {
      const e = moveBefore(state, id, before);
      return { entry: { ...e }, position: positionOf(state, id) };
    });
    this.store.logEvent({ type: "queue_move", id, before, lane });
    return out;
  }

  /** Read-only snapshot: expiry is applied to a copy for display, nothing is written. */
  view(runningIds: string[]) {
    const state = structuredClone(this.store.read());
    const nowMs = this.now();
    expireEntries(state, nowMs);
    const memory = this.memory();
    return {
      running: runningIds.length,
      cap: this.cap,
      memory,
      grants: state.entries.filter((e) => e.state === "granted"),
      waiting: orderedWaiting(state).map((e, i) => ({ entry: e, position: i + 1 })),
      nowMs,
    };
  }
}
