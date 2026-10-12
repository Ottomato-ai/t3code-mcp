// Launch desk: at most `cap` live T3 threads across all lanes; when full, lanes queue.
// Design: Infra/docs/superpowers/specs/2026-10-12-t3-launch-queue-design.md
import { homedir } from "node:os";
import { join } from "node:path";
import type { ShellSnapshot } from "../model.js";
import { readHostGuardMemory, type MemoryReading } from "./memory.js";
import { runningThreadIds } from "./running.js";
import { untrusted } from "./untrusted.js";
import { decideCap, defaultHeadroomFile, readHeadroom, type CapDecision, type HeadroomReading } from "./headroom.js";
import {
  DeskStore,
  GRANT_WINDOW_MS,
  claim,
  enqueue,
  expireEntries,
  findEntry,
  markLaunched,
  moveBefore,
  orderedWaiting,
  positionOf,
  recompute,
  releaseClaim,
  slotsUsed,
  type DeskEntry,
  type DeskState,
  type EntryKind,
  type SlotContext,
} from "./store.js";

/** The OttoContext lead's lane after its status tag, e.g. "(Resume) ** OttoContext". */
export const LEAD_LANE_NAME = "** OttoContext";
export const DEFAULT_CAP = 15;
export const TICK_MS = 30_000;
/** launch_wait and the tick fetch the T3 shell at most this often per process. */
export const SHELL_INTERVAL_MS = 30_000;

/**
 * The lead may reorder the queue. With an override (T3_LAUNCH_LEAD_LANE) the lane must match
 * it exactly; otherwise the lane, minus one leading status tag such as "(Resume)", must be
 * "** OttoContext", so a status rename keeps working.
 */
export function isLeadLane(lane: string, override?: string): boolean {
  if (override) return lane === override;
  return lane.trim().replace(/^\([^()]*\)\s*/, "") === LEAD_LANE_NAME;
}

export interface LaunchDeskOptions {
  store: DeskStore;
  cap: number;
  grantWindowMs?: number;
  readMemory?: () => MemoryReading;
  now?: () => number;
  /** launch_wait poll interval for desk.json. */
  pollMs?: number;
  shellIntervalMs?: number;
  /** Exact lead lane (T3_LAUNCH_LEAD_LANE); default: match "** OttoContext" after the status tag. */
  leadLane?: string;
  /** Phase 2: Host Guard headroom (extra slots). Without it the cap is `cap` (reason config). */
  readHeadroom?: () => HeadroomReading;
  /** The headroom file read by readHeadroom (shown for diagnostics). */
  headroomFile?: string;
}

export type Admission =
  | { kind: "launch"; entry: DeskEntry; claim: string }
  | { kind: "queued"; entry: DeskEntry; position: number; running: number; cap: number; memory: MemoryReading };

export interface AdmitRequest {
  lane: string;
  projectId: string;
  project: string;
  task: string;
  ned: boolean;
  queueEntry?: string;
  /** resume: send_message to this stopped thread; create: create_thread. */
  kind?: EntryKind;
  targetThreadId?: string;
}

type ShellSource = { shell(): Promise<Pick<ShellSnapshot, "threads">> };

const holdsQueue = (e: DeskEntry) => e.state === "waiting" || e.state === "granted" || e.state === "launching";

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
  readonly shellIntervalMs: number;
  readonly leadLane: string | undefined;
  readonly headroomFile: string | undefined;
  private readonly readHeadroom: (() => HeadroomReading) | undefined;
  private readonly readMemory: () => MemoryReading;
  private readonly now: () => number;
  private lastMemoryStatus: MemoryReading["status"] = "ok";
  private lastShellAt = Number.NEGATIVE_INFINITY;
  private ticker: NodeJS.Timeout | undefined;
  private tickErrorLogged = false;

  constructor(opts: LaunchDeskOptions) {
    this.store = opts.store;
    this.cap = opts.cap;
    this.grantWindowMs = opts.grantWindowMs ?? GRANT_WINDOW_MS;
    this.readMemory = opts.readMemory ?? (() => readHostGuardMemory());
    this.now = opts.now ?? Date.now;
    this.pollMs = opts.pollMs ?? 3_000;
    this.shellIntervalMs = opts.shellIntervalMs ?? SHELL_INTERVAL_MS;
    this.leadLane = opts.leadLane || undefined;
    this.readHeadroom = opts.readHeadroom;
    this.headroomFile = opts.headroomFile;
  }

  /** T3_LAUNCH_CAP (15), T3_LAUNCH_GRANT_MINUTES (10), T3_LAUNCH_DESK_DIR, T3_LAUNCH_LEAD_LANE. */
  static fromEnv(env: NodeJS.ProcessEnv = process.env): LaunchDesk {
    const headroomFile = defaultHeadroomFile(env);
    return new LaunchDesk({
      headroomFile,
      readHeadroom: () => readHeadroom({ file: headroomFile }),
      store: new DeskStore(defaultDeskDir(env)),
      cap: envInt(env.T3_LAUNCH_CAP, DEFAULT_CAP),
      grantWindowMs: envInt(env.T3_LAUNCH_GRANT_MINUTES, GRANT_WINDOW_MS / 60_000) * 60_000,
      leadLane: env.T3_LAUNCH_LEAD_LANE,
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

  /** The effective cap for this state: the configured cap, or phase 2 from Host Guard headroom. */
  private capDecision(state: DeskState, reading: HeadroomReading | null): CapDecision {
    if (!reading) return { effective: this.cap, base: this.cap, extra: 0, reason: "config", extraGrants: 0 };
    const last = state.last_extra_at ? Date.parse(state.last_extra_at) : null;
    return decideCap({ floor: this.cap, reading, lastExtraAt: last });
  }

  /** Inside the lock: put the decision into ctx; returns it when the effective cap changed. */
  private applyCap(state: DeskState, ctx: SlotContext, reading: HeadroomReading | null): { decision: CapDecision; changed: boolean } {
    const decision = this.capDecision(state, reading);
    ctx.cap = decision.effective;
    if (reading) {
      ctx.baseCap = decision.base;
      ctx.extraGrants = decision.extraGrants;
    }
    const changed = state.cap_effective !== decision.effective;
    state.cap_effective = decision.effective;
    return { decision, changed };
  }

  private logCap(cap: { decision: CapDecision; changed: boolean }): void {
    if (!cap.changed) return;
    const d = cap.decision;
    this.store.logEvent({ type: "cap", effective: d.effective, base: d.base, extra: d.extra, reason: d.reason });
  }

  /**
   * Decide a launch. Returns launch (the entry is claimed for this one call; finish with
   * markLaunched or launchFailed) or queued. Throws with an instruction for refusals.
   */
  admit(req: AdmitRequest, runningIds: string[]): Admission {
    const memory = this.memory();
    const ctx = this.ctx(runningIds, memory);
    const reading = this.readHeadroom?.() ?? null;
    let cap = { decision: this.capDecision({ version: 1, seq: 0, entries: [] }, reading), changed: false };
    const kind = req.kind ?? "create";
    const target = req.targetThreadId ?? null;
    const queued = (state: DeskState, e: DeskEntry): Admission => ({
      kind: "queued",
      entry: { ...e },
      position: positionOf(state, e.id) ?? 0,
      running: runningIds.length,
      cap: cap.decision.effective,
      memory,
    });
    const launch = (state: DeskState, e: DeskEntry): Admission => {
      const token = claim(state, e.id, ctx.nowMs);
      return { kind: "launch", entry: { ...e }, claim: token };
    };
    const result = this.store.update((state): Admission => {
      cap = this.applyCap(state, ctx, reading);
      if (req.queueEntry) {
        const e = findEntry(state, req.queueEntry);
        if (e.lane !== req.lane) {
          throw new Error(
            `Queue entry ${e.id} belongs to lane ${untrusted(e.lane)}, not ${untrusted(req.lane)}. A grant launches only for its own lane.`,
          );
        }
        if (e.project_id !== req.projectId) {
          throw new Error(`Queue entry ${e.id} was granted for project ${untrusted(e.project)}; it cannot launch in another project.`);
        }
        if (e.target_thread_id !== target) { // create entries have no target; resume entries always do
          throw new Error(
            e.kind === "resume"
              ? `Queue entry ${e.id} is for send_message to thread ${e.target_thread_id}; use it only for that thread.`
              : `Queue entry ${e.id} is for create_thread; it cannot restart another thread.`,
          );
        }
        recompute(state, ctx);
        if (e.state === "granted") return launch(state, e);
        if (e.state === "waiting") return queued(state, e);
        if (e.state === "launching") claim(state, e.id, ctx.nowMs); // throws: in progress
        throw new Error(
          e.state === "launched"
            ? `Queue entry ${e.id} already launched thread ${e.thread_id}.`
            : e.state === "failed"
              ? `Queue entry ${e.id} failed after the launch was sent (thread ${e.thread_id}); check that thread before trying again. Call without queue_entry to queue a new launch.`
              : `Queue entry ${e.id} is ${e.state}. Call without queue_entry to join the queue again at the back.`,
        );
      }
      const e = enqueue(state, {
        lane: req.lane,
        project: req.project,
        project_id: req.projectId,
        task: req.task,
        priority: req.ned ? "ned" : "normal",
        nowMs: ctx.nowMs,
        kind,
        target_thread_id: target,
      });
      recompute(state, ctx);
      return e.state === "granted" ? launch(state, e) : queued(state, e);
    });
    this.logCap(cap);
    if (req.ned && !req.queueEntry) {
      this.store.logEvent({ type: "ned_entry", id: result.entry.id, lane: req.lane, project: req.project, kind });
      console.error(`launch-desk: ned_requested entry ${result.entry.id} from lane ${JSON.stringify(req.lane)}.`);
    }
    return result;
  }

  /** Record the launch, then log it for Host Guard, which measures each launch's memory cost. */
  markLaunched(id: string, token: string, threadId: string): void {
    const e = this.store.update((state) => ({ ...markLaunched(state, id, threadId, this.now(), token) }));
    this.store.logEvent({
      type: "launched",
      id: e.id,
      lane: e.lane,
      project: e.project,
      thread_id: e.thread_id,
      kind: e.kind,
      launched_at: e.launched_at,
    });
  }

  /** A claimed launch did not finish. The grant comes back only when nothing was sent to T3. */
  launchFailed(id: string, token: string, out: { createSent: boolean; threadId: string }): void {
    this.store.update((state) => releaseClaim(state, id, token, { ...out, nowMs: this.now() }));
  }

  /** Expire and grant with a running count taken from T3 now. */
  tick(runningIds: string[]) {
    const ctx = this.ctx(runningIds, this.memory());
    const reading = this.readHeadroom?.() ?? null;
    let cap: { decision: CapDecision; changed: boolean } | undefined;
    const out = this.store.update((state) => {
      cap = this.applyCap(state, ctx, reading);
      return recompute(state, ctx);
    });
    if (cap) this.logCap(cap);
    return out;
  }

  /** The 30-second tick: only calls T3 when an entry is waiting, granted or launching. */
  async tickOnce(client: ShellSource): Promise<void> {
    if (!this.store.read().entries.some(holdsQueue)) return;
    this.lastShellAt = Date.now();
    const shell = await client.shell();
    this.tick(runningThreadIds(shell));
  }

  /** tickOnce, but at most once per shellIntervalMs in this process. */
  async maybeTick(client: ShellSource): Promise<void> {
    if (Date.now() - this.lastShellAt < this.shellIntervalMs) return;
    await this.tickOnce(client);
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
      if (e.lane !== lane) {
        throw new Error(`Queue entry ${id} belongs to lane ${untrusted(e.lane)}; a lane cancels only its own entry.`);
      }
      if (e.state !== "waiting" && e.state !== "granted") {
        throw new Error(`Queue entry ${id} is ${e.state}; only waiting or granted entries can be cancelled.`);
      }
      e.state = "cancelled";
      e.updated_at = new Date(this.now()).toISOString();
      return { ...e };
    });
    this.store.logEvent({ type: "cancel", id, lane });
    return e;
  }

  move(id: string, before: string, lane: string): { entry: DeskEntry; position: number | null } {
    if (!isLeadLane(lane, this.leadLane)) {
      throw new Error(
        `Only the OttoContext lead (${this.leadLane ? untrusted(this.leadLane) : `"(status) ${LEAD_LANE_NAME}"`}) may reorder the launch queue.`,
      );
    }
    const out = this.store.update((state) => {
      const e = moveBefore(state, id, before, this.now());
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
    const reading = this.readHeadroom?.() ?? null;
    const decision = this.capDecision(state, reading);
    const used = slotsUsed(state, { runningThreadIds: runningIds, cap: decision.effective, commitPercent: null, nowMs });
    return {
      running: runningIds.length,
      cap: decision.effective,
      capDecision: decision,
      headroom: reading,
      free: Math.max(0, decision.effective - used),
      memory,
      grants: state.entries.filter((e) => e.state === "granted" || e.state === "launching"),
      waiting: orderedWaiting(state).map((e, i) => ({ entry: e, position: i + 1 })),
      nowMs,
    };
  }
}
