// Transition-safe delivery of queued messages (send_now) and tracked message sends (send_message).
//
// Rules (T3 Code 0.1.6 server, see ../queue.ts):
// - queued-run.start is accepted only while no run is active: preparing, starting, running and
//   waiting are all active. A thread in any of them is never "stopped" here.
// - Every mutation is preceded by a fresh read of the thread that re-checks every precondition.
// - Nothing here interrupts, steers or cancels a run: delivery never ends work to make room.
// - Time is bounded: no command is sent later than waitSeconds after the call began (one read's
//   timeout when waitSeconds is 0); every read's timeout fits the remaining budget; each call
//   makes at most MAX_READS_PER_CALL reads.
// - Only a refused connection, an authorization refusal or T3's receipt ("previously rejected")
//   proves a command was not applied. Anything else after sending (timeout, drop, a failure
//   answer, which T3 can give after committing the command) is reconciled before anything else:
//   first from the thread's state, then by replaying the same command with the same commandId.
//   T3 keeps a receipt per commandId, so a replay is answered from it (applied, or "previously
//   rejected") or applied once now. A new commandId is never used to retry.
// - The outcome is explicit: delivered, deferred (nothing pending; safe to try later) or unknown
//   (the journal record stays open until reconcile_send proves what happened).
import { T3Error, rejectedByReceipt, type ProjectionRead } from "../client.js";
import { newId } from "../model.js";
import {
  findMessage,
  findRun,
  queueView,
  runWasDelivered,
  type QueueEntry,
  type QueueView,
  type RunPhase,
} from "../queue.js";
import { JournalConflictError, describeRecord, type DeliveryJournal, type JournalRecord } from "./journal.js";

export type Outcome = "delivered" | "deferred" | "unknown";

/** The five-minute floor on how old a queued message must be before the connector sends it now. */
export const MIN_DELIVERY_AGE_SECONDS = 300;
export const MAX_WAIT_SECONDS = 120;
export const MAX_VERIFY_SECONDS = 30;
/** Hard cap on reads in one call, whatever the wait settings. */
export const MAX_READS_PER_CALL = 60;
/** Reads kept back from waiting for the send's verification and reconciliation. */
const POST_SEND_READS = 15;
/** A read is not started with less time than this left before its deadline. */
const MIN_READ_MS = 1_000;
const DEFAULT_READ_TIMEOUT_MS = 30_000;
const DEFAULT_RPC_TIMEOUT_MS = 30_000;

export interface DeliveryClient {
  projection(threadId: string, opts?: { bounded?: boolean; timeoutMs?: number }): Promise<ProjectionRead>;
  /** `sendBy`: absolute deadline (same clock as `now`); a client that cannot send by then sends nothing. */
  dispatch(command: Record<string, unknown>, opts?: { timeoutMs?: number; sendBy?: number }): Promise<{ sequence: number }>;
}

export interface DeliveryDeps {
  client: DeliveryClient;
  journal: DeliveryJournal;
  parked: ReadonlySet<string>;
  /** Longest single read (the client's HTTP timeout). */
  readTimeoutMs?: number;
  /** Longest single command (the client's RPC timeout). */
  rpcTimeoutMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  newCommandId?: () => string;
}

export interface SendNowInput {
  threadId: string;
  /** The queued run to start; when absent, the oldest eligible user message. */
  queuedRunId?: string;
  minAgeSeconds?: number;
  waitSeconds?: number;
  pollSeconds?: number;
  /** queued-run.start releases every hold on the thread's queue; only with this flag. */
  releaseHold?: boolean;
  verifySeconds?: number;
}

export interface DeliveryResult {
  outcome: Outcome;
  reason: string;
  detail?: string;
  threadId: string;
  queuedRunId: string | null;
  messageId: string | null;
  textSha256: string | null;
  commandId: string | null;
  runStatus: string | null;
  phase: RunPhase | null;
  reads: number;
  dispatches: number;
  waitedMs: number;
  journal: ReturnType<typeof describeRecord> | null;
  note: string;
}

const NOTES: Record<Outcome, string> = {
  delivered: "The queued message left the queue and the agent has it. Content and message id are unchanged.",
  deferred: "Nothing is pending from this call (nothing changed, T3 refused, or T3 accepted a start that has not happened). The message stays queued with its content; it is safe to try again later.",
  unknown:
    "The outcome is not proven. The send is quarantined in the delivery journal: do not send it again by other means. " +
    "Run reconcile_send for this thread and run (allowReplay replays the same commandId, which T3 applies at most once).",
};

class Ctx {
  reads = 0;
  dispatches = 0;
  readonly started: number;
  readonly readTimeoutMs: number;
  readonly rpcTimeoutMs: number;
  /** Least time worth sleeping for before another poll read (never more than one whole read). */
  readonly minReadMs: number;
  constructor(
    readonly deps: DeliveryDeps,
    readonly threadId: string,
  ) {
    this.started = this.now();
    this.readTimeoutMs = deps.readTimeoutMs ?? DEFAULT_READ_TIMEOUT_MS;
    this.rpcTimeoutMs = deps.rpcTimeoutMs ?? DEFAULT_RPC_TIMEOUT_MS;
    this.minReadMs = Math.min(MIN_READ_MS, this.readTimeoutMs);
  }
  now(): number {
    return this.deps.now?.() ?? Date.now();
  }
  sleep(ms: number): Promise<void> {
    return this.deps.sleep?.(ms) ?? new Promise((r) => setTimeout(r, ms));
  }
  /**
   * One read whose timeout ends by `deadline`. With no time left, no read is made (a T3Error with
   * code "deadline"), so a read never runs past its deadline.
   */
  async read(bounded = true, deadline?: number): Promise<ProjectionRead> {
    if (this.reads >= MAX_READS_PER_CALL) {
      throw new T3Error(`read budget of ${MAX_READS_PER_CALL} exhausted`, { outcome: "not_sent", code: "budget" });
    }
    const left = deadline === undefined ? this.readTimeoutMs : deadline - this.now();
    if (left <= 0) {
      throw new T3Error("the call's time budget ran out before this read", { outcome: "not_sent", code: "deadline" });
    }
    this.reads++;
    return this.deps.client.projection(this.threadId, { bounded, timeoutMs: Math.min(this.readTimeoutMs, left) });
  }
  result(
    outcome: Outcome,
    reason: string,
    fields: Partial<Omit<DeliveryResult, "outcome" | "reason" | "reads" | "dispatches" | "waitedMs" | "note">> = {},
  ): DeliveryResult {
    return {
      outcome,
      reason,
      threadId: this.threadId,
      queuedRunId: null,
      messageId: null,
      textSha256: null,
      commandId: null,
      runStatus: null,
      phase: null,
      journal: null,
      ...fields,
      reads: this.reads,
      dispatches: this.dispatches,
      waitedMs: Math.max(0, this.now() - this.started),
      note: NOTES[outcome],
    };
  }
}

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const isDeadline = (e: unknown) => e instanceof T3Error && e.code === "deadline";

/** Time limits of one call: reads end by readBy, and no command (send or replay) leaves after sendBy. */
interface Budget {
  readBy: number;
  sendBy: number;
}

type ReplayAnswer = { kind: "applied"; sequence: number } | { kind: "rejected"; error: unknown } | { kind: "unknown"; error: unknown };

/**
 * Replay a recorded command (same commandId) to learn its fate from T3's receipt. Only the receipt
 * ("previously rejected") proves rejection here: a refused connection or an authorization refusal
 * says nothing about the original send. If T3 answers with a failure that is not yet proof (it may
 * have just recorded a rejection), one more replay reads the receipt.
 */
async function replay(ctx: Ctx, record: JournalRecord, sendBy = Infinity): Promise<ReplayAnswer> {
  let last: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    // A replay is a send: none leaves after sendBy, and none may run past it.
    const left = sendBy - ctx.now();
    if (left <= 0) {
      last = attempt === 0 ? new T3Error("no time left to replay before the send deadline", { outcome: "not_sent", code: "deadline" }) : last;
      break;
    }
    try {
      ctx.dispatches++;
      const r = await ctx.deps.client.dispatch(record.command, {
        timeoutMs: Math.min(ctx.rpcTimeoutMs, left),
        ...(Number.isFinite(sendBy) ? { sendBy } : {}),
      });
      return { kind: "applied", sequence: r.sequence };
    } catch (e) {
      last = e;
      if (rejectedByReceipt(e)) return { kind: "rejected", error: e };
      if (!(e instanceof T3Error && e.outcome === "ambiguous" && e.answered)) break;
    }
  }
  return { kind: "unknown", error: last };
}

function entryFields(e: QueueEntry) {
  return { queuedRunId: e.runId, messageId: e.messageId, textSha256: e.textSha256 };
}

/** The oldest user message old enough to send and not already in the journal. */
function pickOldest(view: QueueView, input: { minAgeSeconds: number; releaseHold: boolean }, journal: DeliveryJournal) {
  return view.entries
    .filter((e) => e.kind === "user" && !e.messageMissing && (e.ageSeconds ?? -1) >= input.minAgeSeconds)
    .filter((e) => !e.held || input.releaseHold)
    .filter((e) => journal.get(view.threadId, e.runId) === null)
    .sort((a, b) => (a.requestedAt ?? "").localeCompare(b.requestedAt ?? "") || (a.ordinal ?? 0) - (b.ordinal ?? 0))[0];
}

function quarantined(ctx: Ctx, journal: DeliveryJournal, record: JournalRecord): DeliveryResult {
  const reason = journal.isLive(record) ? "in_flight" : "quarantined";
  return ctx.result("unknown", reason, {
    ...recordFields(record),
    journal: describeRecord(journal, record),
    detail:
      reason === "in_flight"
        ? "Another call is sending this message right now."
        : "An earlier send of this message has no proven outcome (its owner's exit or the message still being queued does not prove it).",
  });
}

function recordFields(record: JournalRecord) {
  return {
    queuedRunId: record.subject.kind === "queued-run" ? record.subject.runId : null,
    messageId: record.messageId,
    textSha256: record.textSha256,
    commandId: record.commandId,
  };
}

/** Look a run up in the bounded window, then (only if absent) in the full projection. */
async function locateRun(ctx: Ctx, read: ProjectionRead, runId: string, deadline?: number) {
  const run = findRun(read.snapshot, runId);
  if (run || read.source === "full") return { run, read };
  const full = await ctx.read(false, deadline);
  return { run: findRun(full.snapshot, runId), read: full };
}

/** A journal record changed by another call while this one worked: report, never overwrite. */
function conflictResult(ctx: Ctx, e: JournalConflictError, queuedRunId: string | null): DeliveryResult {
  return ctx.result("unknown", "journal_conflict", {
    queuedRunId,
    detail: `${e.message}. Read delivery_journal and queue_status before doing anything else.`,
  });
}

export async function sendNow(deps: DeliveryDeps, input: SendNowInput): Promise<DeliveryResult> {
  const ctx = new Ctx(deps, input.threadId);
  try {
    return await sendNowInner(ctx, input);
  } catch (e) {
    if (e instanceof JournalConflictError) return conflictResult(ctx, e, input.queuedRunId ?? null);
    throw e;
  }
}

async function sendNowInner(ctx: Ctx, input: SendNowInput): Promise<DeliveryResult> {
  const { deps } = ctx;
  const minAgeSeconds = Math.max(MIN_DELIVERY_AGE_SECONDS, input.minAgeSeconds ?? MIN_DELIVERY_AGE_SECONDS);
  const waitMs = Math.min(MAX_WAIT_SECONDS, Math.max(0, input.waitSeconds ?? 0)) * 1000;
  const pollMs = Math.max(1, input.pollSeconds ?? 3) * 1000;
  const verifyMs = Math.min(MAX_VERIFY_SECONDS, Math.max(1, input.verifySeconds ?? 10)) * 1000;
  const releaseHold = input.releaseHold === true;
  // Waiting ends at waitUntil, and no command goes out after sendBy (the same instant, or one
  // read's timeout when the caller does not wait at all).
  const waitUntil = ctx.started + waitMs;
  const sendBy = waitMs > 0 ? waitUntil : ctx.started + ctx.readTimeoutMs;

  if (deps.parked.has(input.threadId)) {
    return ctx.result("deferred", "thread_parked", {
      queuedRunId: input.queuedRunId ?? null,
      detail: "This thread is parked (T3_PARKED_THREADS): the connector never starts or releases its queue.",
    });
  }
  if (input.queuedRunId) {
    const open = deps.journal.get(input.threadId, input.queuedRunId);
    if (open && open.status !== "resolved") return quarantined(ctx, deps.journal, open);
  }

  for (;;) {
    let read: ProjectionRead;
    try {
      read = await ctx.read(true, sendBy);
    } catch (e) {
      return ctx.result("deferred", isDeadline(e) ? "deadline_reached" : "read_failed", { queuedRunId: input.queuedRunId ?? null, detail: errText(e) });
    }
    const view = queueView(read.snapshot, { nowMs: ctx.now(), maxTextChars: 0 });
    const phase = view.runState.phase;

    let entry: QueueEntry | undefined;
    if (input.queuedRunId) {
      entry = view.entries.find((e) => e.runId === input.queuedRunId);
      if (!entry) {
        let located;
        try {
          located = await locateRun(ctx, read, input.queuedRunId, sendBy);
        } catch (e) {
          return ctx.result("deferred", "read_failed", { queuedRunId: input.queuedRunId, detail: errText(e) });
        }
        const run = located.run;
        if (!run) return ctx.result("deferred", "run_not_found", { queuedRunId: input.queuedRunId, phase });
        return runWasDelivered(run.status)
          ? ctx.result("delivered", "already_started", { queuedRunId: run.id, messageId: run.userMessageId ?? null, runStatus: run.status, phase, detail: "The run is no longer queued: T3 already started it." })
          : ctx.result("deferred", "run_not_queued", { queuedRunId: run.id, messageId: run.userMessageId ?? null, runStatus: run.status, phase, detail: `The run is ${run.status}; there is nothing to send.` });
      }
    } else {
      entry = pickOldest(view, { minAgeSeconds, releaseHold }, deps.journal);
      if (!entry) {
        return ctx.result("deferred", "no_eligible_message", {
          phase,
          detail:
            `No user message has waited ${minAgeSeconds}s or more` +
            (view.queueHeld && !releaseHold ? " outside a held queue" : "") +
            ` (queued: ${view.counts.user} user, ${view.counts.automatic} automatic, ${view.counts.notification} notification).`,
        });
      }
    }

    const open = deps.journal.get(input.threadId, entry.runId);
    if (open && open.status !== "resolved") return quarantined(ctx, deps.journal, open);
    const fields = { ...entryFields(entry), runStatus: "queued", phase };
    if (entry.kind !== "user") {
      return ctx.result("deferred", "automatic_run", { ...fields, detail: `This is a ${entry.kind} delivery; T3 only lets user messages be sent now.` });
    }
    if (entry.messageMissing) {
      return ctx.result("deferred", "message_missing", { ...fields, detail: "The run's message is not in the snapshot; its content cannot be checked." });
    }
    if ((entry.ageSeconds ?? -1) < minAgeSeconds) {
      return ctx.result("deferred", "too_recent", { ...fields, detail: `Queued ${entry.ageSeconds ?? "?"}s ago; the minimum is ${minAgeSeconds}s.` });
    }
    if (view.archived) return ctx.result("deferred", "thread_archived", fields);
    if (view.queueHeld && !releaseHold) {
      return ctx.result("deferred", "queue_held", {
        ...fields,
        detail: "The thread's queue is held. Sending now releases every hold on it, so it needs releaseHold: true.",
      });
    }
    if (!view.runState.canStartQueuedRun) {
      // Sleep only if a read still fits after it.
      if (ctx.now() + pollMs + ctx.minReadMs <= waitUntil && ctx.reads < MAX_READS_PER_CALL - POST_SEND_READS) {
        await ctx.sleep(pollMs);
        continue;
      }
      return ctx.result("deferred", `thread_${phase}`, {
        ...fields,
        detail:
          `The thread is ${phase} (${view.runState.activeRuns.map((r) => `${r.runId}: ${r.status}`).join(", ")}); ` +
          "T3 starts a queued message only while the thread is stopped" +
          (waitMs > 0 ? `, and it did not stop within ${waitMs / 1000}s.` : "."),
      });
    }
    if (ctx.now() > sendBy) {
      return ctx.result("deferred", "deadline_reached", { ...fields, detail: "The call's time budget ran out before the send; nothing was sent." });
    }

    // This read is fresh and every precondition holds: send.
    const command = {
      type: "queued-run.start",
      commandId: deps.newCommandId?.() ?? newId(),
      threadId: input.threadId,
      runId: entry.runId,
    };
    const claim = deps.journal.claim({
      threadId: input.threadId,
      subject: { kind: "queued-run", runId: entry.runId },
      messageId: entry.messageId,
      textSha256: entry.textSha256,
      command,
      releaseHold,
    });
    if (!claim.ok) return quarantined(ctx, deps.journal, claim.existing);
    return dispatchStart(ctx, claim.record, verifyMs, sendBy);
  }
}

/** Send a claimed queued-run.start and settle its journal record. */
async function dispatchStart(ctx: Ctx, record: JournalRecord, verifyMs: number, sendBy: number): Promise<DeliveryResult> {
  const { journal } = ctx.deps;
  if (ctx.now() > sendBy) {
    // Checked right before the send: the claim itself may have taken the last of the time.
    const r = journal.resolve(record, "not_sent", "the send deadline passed before the command went out");
    return ctx.result("deferred", "deadline_reached", { ...recordFields(record), detail: "The call's time budget ran out before the send; nothing was sent.", journal: describeRecord(journal, r) });
  }
  try {
    ctx.dispatches++;
    // The request frame leaves only if the connection is up by sendBy.
    await ctx.deps.client.dispatch(record.command, { sendBy });
  } catch (e) {
    if (e instanceof T3Error && e.outcome === "not_sent") {
      const r = journal.resolve(record, "not_sent", errText(e));
      return ctx.result("deferred", e.code === "deadline" ? "deadline_reached" : "t3_unreachable", { ...recordFields(record), detail: errText(e), journal: describeRecord(journal, r) });
    }
    if (e instanceof T3Error && e.outcome === "rejected") {
      const r = journal.resolve(record, "rejected", errText(e));
      return ctx.result("deferred", "rejected_by_t3", { ...recordFields(record), detail: errText(e), journal: describeRecord(journal, r) });
    }
    record = journal.note(record, "dispatch_unproven", errText(e), "unknown");
    // Reconcile within the verification window; a replay is a send, so it also respects sendBy.
    return reconcileStartRecord(ctx, record, { allowReplay: true, verifyMs, budget: { readBy: ctx.now() + verifyMs, sendBy }, cause: errText(e) });
  }
  record = journal.note(record, "accepted");
  return verifyStart(ctx, record, verifyMs);
}

/**
 * After T3 accepted (or replayed as applied) a queued-run.start: watch, within verifyMs, for the
 * run to leave the queue. Reads are capped to that window (each at least MIN_READ_MS).
 * - Left the queue: delivered (resolved).
 * - Still queued at the end, or not readable: unknown, and the record stays open. Delivery is not
 *   proven yet; reconcile_send settles it from state, or replays the same commandId (T3 then
 *   retries starting that run once more, never a second copy).
 */
async function verifyStart(ctx: Ctx, record: JournalRecord, verifyMs: number, until = ctx.now() + verifyMs): Promise<DeliveryResult> {
  const { journal } = ctx.deps;
  const runId = (record.subject as { runId: string }).runId;
  let lastPhase: RunPhase | null = null;
  for (;;) {
    let read: ProjectionRead;
    let run;
    try {
      read = await ctx.read(true, until);
      ({ run, read } = await locateRun(ctx, read, runId, until));
    } catch (e) {
      if (isDeadline(e) && lastPhase !== null) {
        const r = journal.note(record, "accepted_not_started", "still queued at the end of verification", "unknown");
        return ctx.result("unknown", "accepted_not_started", { ...recordFields(record), runStatus: "queued", phase: lastPhase, detail: notStartedDetail(verifyMs), journal: describeRecord(journal, r) });
      }
      const r = journal.note(record, "verify_read_failed", errText(e), "unknown");
      return ctx.result("unknown", "accepted_unverified", {
        ...recordFields(record),
        detail: `T3 accepted the send, but the run could not be re-read (${errText(e)}). The record stays open: run reconcile_send.`,
        journal: describeRecord(journal, r),
      });
    }
    const phase = queueView(read.snapshot, { maxTextChars: 0 }).runState.phase;
    lastPhase = phase;
    if (run && run.status !== "queued") {
      if (runWasDelivered(run.status)) {
        const r = journal.resolve(record, "delivered", `run ${run.status}`);
        return ctx.result("delivered", "started", { ...recordFields(record), runStatus: run.status, phase, journal: describeRecord(journal, r) });
      }
      const r = journal.resolve(record, "not_queued", `run ${run.status}`);
      return ctx.result("deferred", `run_${run.status}`, { ...recordFields(record), runStatus: run.status, phase, journal: describeRecord(journal, r) });
    }
    if (!run) {
      const r = journal.note(record, "run_missing", "run not found after accept", "unknown");
      return ctx.result("unknown", "run_missing", { ...recordFields(record), phase, detail: "The run is no longer in the thread's projection.", journal: describeRecord(journal, r) });
    }
    if (ctx.now() + 1000 + ctx.minReadMs <= until && ctx.reads < MAX_READS_PER_CALL) {
      await ctx.sleep(1000);
      continue;
    }
    const r = journal.note(record, "accepted_not_started", "still queued at the end of verification", "unknown");
    return ctx.result("unknown", "accepted_not_started", { ...recordFields(record), runStatus: "queued", phase, detail: notStartedDetail(verifyMs), journal: describeRecord(journal, r) });
  }
}

function notStartedDetail(verifyMs: number): string {
  return (
    `T3 accepted the send but the run had not started within verifySeconds (${verifyMs / 1000}s): ` +
    "either the start is still on its way, or another run took the thread first. The message is still " +
    "queued with its content and holds on the queue are released. The record stays open: run reconcile_send " +
    "(allowReplay retries the start with the same commandId); do not resend."
  );
}

/**
 * Prove what happened to a queued-run.start whose outcome is not proven.
 * 1. Read the run: if it left the queue, the message was delivered (or the run ended otherwise).
 * 2. If it is still queued and allowReplay: replay the recorded command (same commandId), but
 *    only while replaying cannot do anything the original would not have done: the thread is not
 *    parked, the message is unchanged, and a held queue is only released if the original asked.
 */
async function reconcileStartRecord(
  ctx: Ctx,
  record: JournalRecord,
  opts: { allowReplay: boolean; verifyMs: number; budget: Budget; cause?: string },
): Promise<DeliveryResult> {
  const { journal } = ctx.deps;
  const runId = (record.subject as { runId: string }).runId;
  const base = recordFields(record);
  let read: ProjectionRead;
  let run;
  try {
    read = await ctx.read(true, opts.budget.readBy);
    ({ run, read } = await locateRun(ctx, read, runId, opts.budget.readBy));
  } catch (e) {
    const r = journal.note(record, "reconcile_read_failed", errText(e), "unknown");
    return ctx.result("unknown", "reconcile_read_failed", { ...base, detail: `${opts.cause ? `${opts.cause} ` : ""}Re-reading the thread failed: ${errText(e)}`, journal: describeRecord(journal, r) });
  }
  const view = queueView(read.snapshot, { maxTextChars: 0 });
  if (!run) {
    const r = journal.note(record, "run_missing", "run not in the full projection", "unknown");
    return ctx.result("unknown", "run_missing", { ...base, phase: view.runState.phase, detail: "The run is no longer in the thread's projection.", journal: describeRecord(journal, r) });
  }
  if (run.status !== "queued") {
    if (runWasDelivered(run.status)) {
      const r = journal.resolve(record, "delivered", `reconciled: run ${run.status}`);
      return ctx.result("delivered", "started", { ...base, runStatus: run.status, phase: view.runState.phase, detail: "Reconciled: the run left the queue.", journal: describeRecord(journal, r) });
    }
    const r = journal.resolve(record, "not_queued", `reconciled: run ${run.status}`);
    return ctx.result("deferred", `run_${run.status}`, { ...base, runStatus: run.status, phase: view.runState.phase, journal: describeRecord(journal, r) });
  }
  if (!opts.allowReplay) {
    const r = journal.note(record, "still_queued", "run still queued; replay not allowed", "unknown");
    return ctx.result("unknown", "still_queued", {
      ...base,
      runStatus: "queued",
      phase: view.runState.phase,
      detail: `${opts.cause ? `${opts.cause} ` : ""}The run is still queued, which does not prove the send failed (an accepted start can leave a run queued). Reconcile with allowReplay to ask T3 by commandId.`,
      journal: describeRecord(journal, r),
    });
  }
  const entry = view.entries.find((e) => e.runId === runId);
  const unsafe = ctx.deps.parked.has(record.threadId)
    ? "the thread is parked"
    : !entry || entry.messageId !== record.messageId || (record.textSha256 !== null && entry.textSha256 !== record.textSha256)
      ? "the queued message changed since the send"
      : view.queueHeld && !record.releaseHold
        ? "the queue is held and the original send did not release holds"
        : null;
  if (unsafe) {
    const r = journal.note(record, "replay_unsafe", unsafe, "unknown");
    return ctx.result("unknown", "replay_unsafe", { ...base, runStatus: "queued", phase: view.runState.phase, detail: `Not replayed: ${unsafe}.`, journal: describeRecord(journal, r) });
  }
  if (ctx.now() > opts.budget.sendBy) {
    const r = journal.note(record, "replay_deferred", "time budget ran out before the replay", "unknown");
    return ctx.result("unknown", "deadline_reached", {
      ...base,
      runStatus: "queued",
      phase: view.runState.phase,
      detail: `${opts.cause ? `${opts.cause} ` : ""}The run is still queued and there was no time left to ask T3 by commandId. The record stays open: run reconcile_send with allowReplay.`,
      journal: describeRecord(journal, r),
    });
  }
  record = journal.note(record, "replay", `same commandId ${record.commandId}`);
  const answer = await replay(ctx, record, opts.budget.sendBy);
  if (answer.kind === "rejected") {
    const r = journal.resolve(record, "rejected", `replay: ${errText(answer.error)}`);
    return ctx.result("deferred", "rejected_by_t3", { ...base, runStatus: "queued", phase: view.runState.phase, detail: errText(answer.error), journal: describeRecord(journal, r) });
  }
  if (answer.kind === "unknown") {
    const r = journal.note(record, "replay_unproven", errText(answer.error), "unknown");
    return ctx.result("unknown", "replay_failed", { ...base, runStatus: "queued", phase: view.runState.phase, detail: `The replay did not prove the outcome either: ${errText(answer.error)}`, journal: describeRecord(journal, r) });
  }
  record = journal.note(record, "replay_accepted");
  // Verify within verifySeconds, and never past the window this reconciliation runs in (an ended
  // window leaves the record open as unknown).
  return verifyStart(ctx, record, opts.verifyMs, Math.min(opts.budget.readBy, ctx.now() + opts.verifyMs));
}

/** reconcile_send for a queued-run record (allowReplay is the caller's explicit choice). */
export async function reconcileQueuedRun(
  deps: DeliveryDeps,
  record: JournalRecord,
  opts: { allowReplay: boolean; verifySeconds?: number },
): Promise<DeliveryResult> {
  const ctx = new Ctx(deps, record.threadId);
  const verifyMs = Math.min(MAX_VERIFY_SECONDS, Math.max(1, opts.verifySeconds ?? 10)) * 1000;
  if (deps.journal.isLive(record)) return quarantined(ctx, deps.journal, record);
  // One read's time to look at the thread, and to replay; then the verification window.
  const budget = { readBy: ctx.started + ctx.readTimeoutMs, sendBy: ctx.started + ctx.readTimeoutMs };
  try {
    return await reconcileStartRecord(ctx, record, { allowReplay: opts.allowReplay, verifyMs, budget });
  } catch (e) {
    if (e instanceof JournalConflictError) return conflictResult(ctx, e, (record.subject as { runId?: string }).runId ?? null);
    throw e;
  }
}

// ---------- send_message ----------

export interface MessageSendResult {
  outcome: Outcome;
  reason: string;
  sequence: number | null;
  commandId: string;
  messageId: string;
  journal: ReturnType<typeof describeRecord> | null;
  detail?: string;
}

/**
 * Send a message.dispatch with its journal record. Unproven outcomes are reconciled: the
 * message is looked up by its id, then the same command (same commandId and messageId) is
 * replayed, which T3 applies at most once. Proven refusals are rethrown unchanged.
 */
export async function dispatchMessage(
  deps: DeliveryDeps,
  command: Record<string, unknown> & { commandId: string; messageId: string; threadId: string; type: string; text: string },
  textSha256: string,
): Promise<MessageSendResult> {
  const { journal } = deps;
  const ctx = new Ctx(deps, command.threadId);
  const claim = journal.claim({
    threadId: command.threadId,
    subject: { kind: "message", messageId: command.messageId },
    messageId: command.messageId,
    textSha256,
    command,
  });
  let record: JournalRecord;
  // A retry re-sends an earlier, unproven command: only T3's receipt can settle it.
  let retry = false;
  if (claim.ok) {
    record = claim.record;
  } else {
    const existing = claim.existing;
    const live = journal.isLive(existing);
    if (live || existing.commandId !== command.commandId || existing.textSha256 !== textSha256) {
      return {
        outcome: "unknown",
        reason: live ? "in_flight" : "quarantined",
        sequence: null,
        commandId: existing.commandId,
        messageId: command.messageId,
        journal: describeRecord(journal, existing),
        detail:
          existing.textSha256 !== textSha256
            ? "This idempotencyKey was used for a different text; the earlier send is unresolved."
            : "An earlier send of this message is unresolved; run reconcile_send.",
      };
    }
    // Same key, same command: this retry is itself the idempotent replay.
    retry = true;
    try {
      record = journal.note(existing, "retry_same_command");
    } catch (e) {
      if (e instanceof JournalConflictError) return messageConflict(command, e);
      throw e;
    }
  }
  try {
    try {
      ctx.dispatches++;
      const r = await deps.client.dispatch(record.command);
      const done = journal.resolve(record, "delivered", `sequence ${r.sequence}`);
      return { outcome: "delivered", reason: "sent", sequence: r.sequence, commandId: record.commandId, messageId: command.messageId, journal: describeRecord(journal, done) };
    } catch (e) {
      if (e instanceof JournalConflictError) throw e;
      if (retry && !rejectedByReceipt(e) && e instanceof T3Error && (e.outcome === "not_sent" || e.outcome === "rejected")) {
        // This attempt was not applied, but that says nothing about the original send.
        const r = journal.note(record, "retry_not_applied", errText(e), "unknown");
        return {
          outcome: "unknown",
          reason: "retry_not_applied",
          sequence: null,
          commandId: record.commandId,
          messageId: command.messageId,
          journal: describeRecord(journal, r),
          detail: `The retry did not reach T3's command handler (${errText(e)}); the earlier send is still unproven. Retry later with the same key, or reconcile_send.`,
        };
      }
      if (e instanceof T3Error && (e.outcome === "not_sent" || e.outcome === "rejected")) {
        journal.resolve(record, e.outcome === "not_sent" ? "not_sent" : "rejected", errText(e));
        throw e;
      }
      if (!(e instanceof T3Error)) {
        journal.note(record, "dispatch_error", errText(e), "unknown");
        throw e;
      }
      record = journal.note(record, "dispatch_unproven", errText(e), "unknown");
      return await reconcileMessageRecord(ctx, record, { allowReplay: true, cause: errText(e) });
    }
  } catch (e) {
    if (e instanceof JournalConflictError) return messageConflict(command, e);
    throw e;
  }
}

function messageConflict(command: { commandId: string; messageId: string }, e: JournalConflictError): MessageSendResult {
  return {
    outcome: "unknown",
    reason: "journal_conflict",
    sequence: null,
    commandId: command.commandId,
    messageId: command.messageId,
    journal: null,
    detail: `${e.message}. Read delivery_journal before doing anything else.`,
  };
}

async function reconcileMessageRecord(
  ctx: Ctx,
  record: JournalRecord,
  opts: { allowReplay: boolean; cause?: string },
): Promise<MessageSendResult> {
  const { journal } = ctx.deps;
  const messageId = record.messageId!;
  const out = (outcome: Outcome, reason: string, r: JournalRecord, detail?: string, sequence: number | null = null): MessageSendResult => ({
    outcome,
    reason,
    sequence,
    commandId: record.commandId,
    messageId,
    journal: describeRecord(journal, r),
    ...(detail ? { detail } : {}),
  });
  try {
    let read = await ctx.read();
    let found = findMessage(read.snapshot, messageId);
    if (!found && read.source === "bounded" && read.hasMoreHistory) {
      read = await ctx.read(false);
      found = findMessage(read.snapshot, messageId);
    }
    if (found) return out("delivered", "reconciled_present", journal.resolve(record, "delivered", "message present in thread"));
  } catch (e) {
    if (e instanceof JournalConflictError) throw e;
    if (!opts.allowReplay) return out("unknown", "reconcile_read_failed", journal.note(record, "reconcile_read_failed", errText(e), "unknown"), errText(e));
    // Fall through: the replay itself asks T3 by commandId.
  }
  if (!opts.allowReplay) {
    return out("unknown", "not_found", journal.note(record, "not_found", "message not in thread; replay not allowed", "unknown"),
      "The message is not in the thread. That does not prove the send failed while T3 may still be processing it; reconcile with allowReplay.");
  }
  record = journal.note(record, "replay", `same commandId ${record.commandId}`);
  const answer = await replay(ctx, record);
  if (answer.kind === "applied") {
    return out("delivered", "replay_accepted", journal.resolve(record, "delivered", `replay sequence ${answer.sequence}`), undefined, answer.sequence);
  }
  if (answer.kind === "rejected") {
    return out("deferred", "rejected_by_t3", journal.resolve(record, "rejected", `replay: ${errText(answer.error)}`), errText(answer.error));
  }
  return out("unknown", "replay_failed", journal.note(record, "replay_unproven", errText(answer.error), "unknown"),
    `${opts.cause ? `${opts.cause} ` : ""}The replay did not prove the outcome either (${errText(answer.error)}). Do not resend with new text or a new key; reconcile_send later.`);
}

/** reconcile_send for a message record. */
export async function reconcileMessage(
  deps: DeliveryDeps,
  record: JournalRecord,
  opts: { allowReplay: boolean },
): Promise<MessageSendResult> {
  const ctx = new Ctx(deps, record.threadId);
  if (deps.journal.isLive(record)) {
    return {
      outcome: "unknown",
      reason: "in_flight",
      sequence: null,
      commandId: record.commandId,
      messageId: record.messageId!,
      journal: describeRecord(deps.journal, record),
      detail: "Another process is sending this message right now.",
    };
  }
  try {
    return await reconcileMessageRecord(ctx, record, opts);
  } catch (e) {
    if (e instanceof JournalConflictError) return messageConflict(record as unknown as { commandId: string; messageId: string }, e);
    throw e;
  }
}
