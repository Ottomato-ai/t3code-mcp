// Queue and run state of one thread, read from a protocol 2 projection (bounded or full).
//
// Mirrors T3 Code 0.1.6 server rules (apps/server/src/orchestration-v2):
// - CommandPolicy.isActiveRun: preparing, starting, running and waiting all own the thread's
//   provider turn. `queued-run.start` is accepted only when no run is active ("A queued user
//   message can only be sent now while the thread is stopped").
// - QueuedRunOrder.queuedRunsInDeliveryOrder: every automatic completion delivery (a message
//   with delegatedCompletion) runs before every other queued run, then queuePosition (else
//   ordinal), then ordinal. The scheduler starts the first run in that order that is not held.
import { createHash } from "node:crypto";
import type { V2ThreadDetailSnapshot } from "./v2.js";

export type RunPhase = "stopped" | "preparing" | "starting" | "running" | "waiting";
export type QueuedKind = "user" | "automatic" | "notification";

export const ACTIVE_RUN_STATUSES = ["preparing", "starting", "running", "waiting"] as const;
const ACTIVE = new Set<string>(ACTIVE_RUN_STATUSES);
/** When several runs are active the most advanced one names the phase. */
const PHASE_RANK: Record<string, number> = { running: 4, waiting: 3, starting: 2, preparing: 1 };
const STARTED_OR_DONE = new Set(["preparing", "starting", "running", "waiting", "completed"]);

export interface RawRun {
  id: string;
  status: string;
  ordinal?: number;
  userMessageId?: string;
  queuePosition?: number | null;
  queueHeld?: boolean;
  requestedAt?: string | null;
  startedAt?: string | null;
  completedAt?: string | null;
  delegatedCompletion?: unknown;
}

export interface RawMessage {
  id: string;
  role?: string;
  text?: string;
  attachments?: unknown[];
  createdBy?: string;
  creationSource?: string;
  createdAt?: string;
  delegatedCompletion?: unknown;
  notification?: unknown;
}

export interface ActiveRun {
  runId: string;
  status: string;
  ordinal: number | null;
  startedAt: string | null;
}

export interface RunState {
  phase: RunPhase;
  /** T3 accepts queued-run.start only in this state. */
  canStartQueuedRun: boolean;
  activeRuns: ActiveRun[];
}

export function runStateOf(runs: RawRun[]): RunState {
  const active = runs.filter((r) => ACTIVE.has(r.status));
  let phase: RunPhase = "stopped";
  for (const r of active) {
    if (phase === "stopped" || PHASE_RANK[r.status] > PHASE_RANK[phase]) phase = r.status as RunPhase;
  }
  return {
    phase,
    canStartQueuedRun: active.length === 0,
    activeRuns: active.map((r) => ({
      runId: r.id,
      status: r.status,
      ordinal: r.ordinal ?? null,
      startedAt: r.startedAt ?? null,
    })),
  };
}

export function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export interface QueueEntry {
  runId: string;
  ordinal: number | null;
  /** 1-based place in T3's delivery order (held runs included, see `held`). */
  deliveryIndex: number;
  queuePosition: number | null;
  held: boolean;
  kind: QueuedKind;
  messageId: string | null;
  /** The message is not in the projection: kind and order may be wrong. */
  messageMissing: boolean;
  text: string | null;
  textLength: number;
  /** SHA-256 of the full message text: compare before and after delivery. */
  textSha256: string | null;
  attachments: number;
  createdBy: string | null;
  creationSource: string | null;
  requestedAt: string | null;
  ageSeconds: number | null;
  /** Automatic completions ahead of this entry (they always run first). */
  automaticAhead: number;
}

export interface QueueView {
  threadId: string;
  title: string | null;
  archived: boolean;
  snapshotSequence: number;
  runState: RunState;
  entries: QueueEntry[];
  counts: { total: number; held: number; automatic: number; user: number; notification: number };
  /** First run the scheduler will start (first not held in delivery order), or null. */
  nextToRun: string | null;
  /** Any queued run is held (T3 starts nothing until queue.resume or a send-now). */
  queueHeld: boolean;
  /** Entries whose message was missing from the projection: the order shown may be off. */
  orderUncertain: boolean;
  /** User or notification entries waiting behind automatic completions. */
  starvation: { entriesBehindAutomatic: number; oldestWaitingSeconds: number | null } | null;
}

function kindOf(run: RawRun, message: RawMessage | undefined): QueuedKind {
  if (message?.delegatedCompletion !== undefined && message.delegatedCompletion !== null) return "automatic";
  if (!message && run.delegatedCompletion !== undefined && run.delegatedCompletion !== null) return "automatic";
  if (message?.notification !== undefined && message.notification !== null) return "notification";
  return "user";
}

/** T3's delivery order (QueuedRunOrder.queuedRunsInDeliveryOrder). */
export function deliveryOrder<T extends { kind: QueuedKind; queuePosition: number | null; ordinal: number | null }>(
  entries: T[],
): T[] {
  return [...entries].sort(
    (a, b) =>
      Number(b.kind === "automatic") - Number(a.kind === "automatic") ||
      (a.queuePosition ?? a.ordinal ?? 0) - (b.queuePosition ?? b.ordinal ?? 0) ||
      (a.ordinal ?? 0) - (b.ordinal ?? 0),
  );
}

export function queueView(
  snapshot: V2ThreadDetailSnapshot,
  opts: { nowMs?: number; maxTextChars?: number } = {},
): QueueView {
  const nowMs = opts.nowMs ?? Date.now();
  const maxText = opts.maxTextChars ?? 500;
  const p = snapshot.projection;
  const runs = (p.runs ?? []) as unknown as RawRun[];
  const messages = new Map(((p.messages ?? []) as unknown as RawMessage[]).map((m) => [m.id, m]));
  const queued = runs
    .filter((r) => r.status === "queued")
    .map((run) => {
      const message = run.userMessageId ? messages.get(run.userMessageId) : undefined;
      const text = typeof message?.text === "string" ? message.text : null;
      const requestedMs = run.requestedAt ? Date.parse(run.requestedAt) : NaN;
      return {
        runId: run.id,
        ordinal: run.ordinal ?? null,
        deliveryIndex: 0,
        queuePosition: run.queuePosition ?? null,
        held: run.queueHeld === true,
        kind: kindOf(run, message),
        messageId: run.userMessageId ?? null,
        messageMissing: message === undefined,
        text: text === null ? null : text.length > maxText ? `${text.slice(0, maxText)}…` : text,
        textLength: text?.length ?? 0,
        textSha256: text === null ? null : sha256(text),
        attachments: Array.isArray(message?.attachments) ? message.attachments.length : 0,
        createdBy: message?.createdBy ?? null,
        creationSource: message?.creationSource ?? null,
        requestedAt: run.requestedAt ?? null,
        // Whole seconds elapsed (floored: 299.9 s is not yet 300 s).
        ageSeconds: Number.isFinite(requestedMs) ? Math.max(0, Math.floor((nowMs - requestedMs) / 1000)) : null,
        automaticAhead: 0,
      } satisfies QueueEntry;
    });
  const ordered = deliveryOrder(queued);
  let automaticSeen = 0;
  ordered.forEach((e, i) => {
    e.deliveryIndex = i + 1;
    e.automaticAhead = e.kind === "automatic" ? 0 : automaticSeen;
    if (e.kind === "automatic") automaticSeen++;
  });
  const behind = ordered.filter((e) => e.kind !== "automatic" && e.automaticAhead > 0);
  const t = p.thread as unknown as { id: string; title?: string | null; archivedAt?: string | null };
  return {
    threadId: t.id,
    title: t.title ?? null,
    archived: Boolean(t.archivedAt),
    snapshotSequence: snapshot.snapshotSequence,
    runState: runStateOf(runs),
    entries: ordered,
    counts: {
      total: ordered.length,
      held: ordered.filter((e) => e.held).length,
      automatic: ordered.filter((e) => e.kind === "automatic").length,
      user: ordered.filter((e) => e.kind === "user").length,
      notification: ordered.filter((e) => e.kind === "notification").length,
    },
    nextToRun: ordered.find((e) => !e.held)?.runId ?? null,
    queueHeld: ordered.some((e) => e.held),
    orderUncertain: ordered.some((e) => e.messageMissing),
    starvation:
      behind.length === 0
        ? null
        : {
            entriesBehindAutomatic: behind.length,
            oldestWaitingSeconds: behind.reduce<number | null>(
              (m, e) => (e.ageSeconds === null ? m : m === null || e.ageSeconds > m ? e.ageSeconds : m),
              null,
            ),
          },
  };
}

/** A run that left the queue for work or finished: its message was delivered to the agent. */
export function runWasDelivered(status: string): boolean {
  return STARTED_OR_DONE.has(status);
}

export function findRun(snapshot: V2ThreadDetailSnapshot, runId: string): RawRun | undefined {
  return ((snapshot.projection.runs ?? []) as unknown as RawRun[]).find((r) => r.id === runId);
}

export function findMessage(snapshot: V2ThreadDetailSnapshot, messageId: string): RawMessage | undefined {
  return ((snapshot.projection.messages ?? []) as unknown as RawMessage[]).find((m) => m.id === messageId);
}
