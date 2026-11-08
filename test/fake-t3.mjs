// A stateful fake of one T3 thread for delivery tests. It enforces the T3 0.1.6 server rules
// the connector depends on (apps/server/src/orchestration-v2):
// - queued-run.start is rejected while any run is preparing, starting, running or waiting, for a
//   run that is not queued, and for automatic completions or notifications;
// - a command id has one receipt: a replay is answered from it (applied, or "previously
//   rejected"), so a command is applied at most once;
// - message.dispatch adds the message and a run (queued behind an active run, else starting).
// Each dispatch can be given a behaviour to simulate lost answers.
import { T3Error } from "../dist/client.js";

export const NOW = Date.parse("2026-11-07T20:00:00Z");
export const MIN = 60_000;
export const iso = (ms) => new Date(ms).toISOString();

const ACTIVE = new Set(["preparing", "starting", "running", "waiting"]);

export function run(id, over = {}) {
  return {
    id,
    threadId: "t-1",
    ordinal: over.ordinal ?? Number(String(id).replace(/\D/g, "")) ?? 1,
    providerInstanceId: "claudeAgent",
    userMessageId: `m-${id}`,
    status: "queued",
    queuePosition: null,
    requestedAt: iso(NOW - 30 * MIN),
    startedAt: null,
    completedAt: null,
    ...over,
  };
}

export function message(id, over = {}) {
  return {
    id,
    threadId: "t-1",
    runId: null,
    role: "user",
    text: `text of ${id}`,
    attachments: [],
    createdBy: "agent",
    creationSource: "mcp",
    createdAt: iso(NOW - 30 * MIN),
    updatedAt: iso(NOW - 30 * MIN),
    streaming: false,
    ...over,
  };
}

/** A queued user run with its message. */
export function queuedUser(id, over = {}, msgOver = {}) {
  return { run: run(id, over), message: message(`m-${id}`, msgOver) };
}

export function fakeThread(opts = {}) {
  const clock = { t: opts.now ?? NOW };
  const state = {
    threadId: opts.threadId ?? "t-1",
    title: opts.title ?? "CP6 orchestrator (synthetic)",
    archivedAt: null,
    runs: [],
    messages: [],
    receipts: new Map(),
    dispatched: [],
    /** The timeoutMs each dispatch was given (undefined: the client's RPC timeout). */
    dispatchTimeouts: [],
    reads: [],
    /** Behaviours consumed one per dispatch: apply | reject | not_sent | drop | apply_then_timeout | apply_no_start. */
    behaviours: [],
    /** Called before each read: (state, readIndex) => void, to move runs between reads. */
    onRead: null,
    /** Called on sleep: (state, ms) => void. */
    onSleep: null,
    seq: 100,
    failReads: 0,
  };
  for (const item of opts.items ?? []) {
    state.runs.push(item.run);
    if (item.message) state.messages.push(item.message);
  }
  for (const r of opts.runs ?? []) state.runs.push(r);
  for (const m of opts.messages ?? []) state.messages.push(m);

  const snapshot = () => ({
    snapshotSequence: state.seq,
    projection: {
      thread: { id: state.threadId, projectId: "p1", title: state.title, archivedAt: state.archivedAt, createdAt: iso(NOW - 1000 * MIN), updatedAt: iso(clock.t) },
      runs: structuredClone(state.runs),
      messages: structuredClone(state.messages),
      providerSessions: [],
      runtimeRequests: [],
      turnItems: [],
    },
  });

  // T3 records the rejection, but its failure answer alone is not proof (as with the real
  // client): only a replay answered "previously rejected" proves the command was not applied.
  function reject(cmd, why) {
    state.receipts.set(cmd.commandId, { status: "rejected", error: why });
    throw new T3Error(`T3 RPC orchestration.dispatchCommand failed: ${why}`, { outcome: "ambiguous", answered: true, code: "OrchestrationV2DispatchCommandError" });
  }

  function apply(cmd, { start = true } = {}) {
    if (cmd.type === "queued-run.start") {
      const r = state.runs.find((x) => x.id === cmd.runId && x.status === "queued");
      const msg = state.messages.find((m) => m.id === r?.userMessageId);
      if (!r || !msg || msg.delegatedCompletion || msg.notification || state.runs.some((x) => ACTIVE.has(x.status))) {
        reject(cmd, "A queued user message can only be sent now while the thread is stopped.");
      }
      for (const x of state.runs) if (x.status === "queued") x.queueHeld = false;
      if (start) {
        r.status = "starting";
        r.startedAt = iso(clock.t);
      }
    } else if (cmd.type === "message.dispatch") {
      if (state.messages.some((m) => m.id === cmd.messageId)) reject(cmd, `Message ${cmd.messageId} already exists.`);
      const busy = state.runs.some((x) => ACTIVE.has(x.status));
      const id = `run-${state.runs.length + 1000}`;
      state.messages.push(message(cmd.messageId, { text: cmd.text, createdAt: iso(clock.t) }));
      state.runs.push(run(id, { userMessageId: cmd.messageId, status: busy ? "queued" : "starting", requestedAt: iso(clock.t) }));
    } else if (cmd.type === "run.interrupt" || cmd.type === "queued-message.promote-to-steer" || cmd.type === "queued-run.cancel") {
      throw new Error(`the connector must never send ${cmd.type} to deliver a message`);
    }
    state.seq++;
    state.receipts.set(cmd.commandId, { status: "applied", sequence: state.seq });
    return { sequence: state.seq };
  }

  const client = {
    state,
    clock,
    async projection(threadId, o = {}) {
      state.reads.push({ threadId, bounded: o.bounded === true, at: clock.t, timeoutMs: o.timeoutMs });
      state.onRead?.(state, state.reads.length);
      if (state.failReads > 0) {
        state.failReads--;
        throw new T3Error("T3 API read did not answer within 30000 ms (T3_HTTP_TIMEOUT_MS).", { code: "timeout" });
      }
      return { snapshot: snapshot(), source: o.bounded ? "bounded" : "full", hasMoreHistory: false };
    },
    async dispatch(cmd, opts = {}) {
      // A connection that takes openMs to open (set per test); like the client, nothing is sent
      // when it opens after sendBy.
      if (state.openMs) clock.t += state.openMs;
      if (opts.sendBy !== undefined && clock.t > opts.sendBy) {
        state.notSentLate = (state.notSentLate ?? 0) + 1;
        throw new T3Error("T3 RPC orchestration.dispatchCommand was not sent: the socket opened after the send deadline.", { outcome: "not_sent", code: "deadline" });
      }
      state.dispatched.push(structuredClone(cmd));
      state.dispatchTimeouts.push(opts.timeoutMs);
      const behaviour = state.behaviours.shift() ?? "apply";
      const receipt = state.receipts.get(cmd.commandId);
      if (receipt && behaviour !== "drop" && behaviour !== "not_sent" && behaviour !== "auth") {
        if (receipt.status === "rejected") {
          throw new T3Error(`Command ${cmd.commandId} was previously rejected: ${receipt.error}`, { outcome: "rejected", answered: true });
        }
        // T3 replays queued-run.start by trying to start that run again (dispatchWithReceipt).
        if (cmd.type === "queued-run.start" && behaviour !== "apply_no_start") {
          const r = state.runs.find((x) => x.id === cmd.runId && x.status === "queued");
          if (r && !state.runs.some((x) => ACTIVE.has(x.status))) {
            r.status = "starting";
            r.startedAt = iso(clock.t);
          }
        }
        return { sequence: receipt.sequence };
      }
      switch (behaviour) {
        case "not_sent":
          throw new T3Error("Could not open the T3 Code RPC socket.", { notSent: true });
        case "auth":
          throw new T3Error("T3 RPC orchestration.dispatchCommand failed: The authenticated token is missing required scope: orchestration:operate.", { outcome: "rejected", answered: true, code: "EnvironmentAuthorizationError" });
        case "drop":
          throw new T3Error("T3 RPC orchestration.dispatchCommand timed out after 30000 ms; the request was sent and may have run.", { outcome: "ambiguous", code: "timeout" });
        case "apply_then_timeout":
          apply(cmd);
          throw new T3Error("T3 RPC orchestration.dispatchCommand timed out after 30000 ms; the request was sent and may have run.", { outcome: "ambiguous", code: "timeout" });
        case "apply_no_start_then_timeout":
          apply(cmd, { start: false });
          throw new T3Error("T3 RPC orchestration.dispatchCommand: the connection closed before T3 answered; the request may have run.", { outcome: "ambiguous" });
        case "apply_no_start":
          return apply(cmd, { start: false });
        case "reject":
          reject(cmd, "rejected by test");
          break;
        case "reject_then_timeout":
          // T3 rejected the command, but the answer was lost.
          state.receipts.set(cmd.commandId, { status: "rejected", error: "A queued user message can only be sent now while the thread is stopped." });
          throw new T3Error("T3 RPC orchestration.dispatchCommand timed out after 30000 ms; the request was sent and may have run.", { outcome: "ambiguous", code: "timeout" });
        default:
          return apply(cmd);
      }
    },
  };
  const deps = (journal, extra = {}) => ({
    client,
    journal,
    parked: new Set(extra.parked ?? []),
    now: () => clock.t,
    sleep: async (ms) => {
      clock.t += ms;
      state.onSleep?.(state, ms);
    },
    ...extra.deps,
  });
  return { client, state, clock, deps, snapshot };
}

export const types = (state) => state.dispatched.map((d) => d.type);
