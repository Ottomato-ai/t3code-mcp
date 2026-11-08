import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { T3Client } from "../client.js";
import { errorResult, jsonResult } from "../format.js";
import { queueView } from "../queue.js";
import { describeRecord, type DeliveryJournal } from "../delivery/journal.js";
import {
  MAX_VERIFY_SECONDS,
  MAX_WAIT_SECONDS,
  MIN_DELIVERY_AGE_SECONDS,
  reconcileMessage,
  reconcileQueuedRun,
  sendNow,
  type DeliveryDeps,
} from "../delivery/deliver.js";

export interface DeliveryContext {
  journal: DeliveryJournal;
  parked: ReadonlySet<string>;
}

const STARVATION_NOTE =
  "T3 (0.1.6, QueuedRunOrder.ts) starts every queued automatic completion before any other queued message, " +
  "with no aging. While automatic completions keep arriving, user messages behind them do not start on their " +
  "own; send_now can start one only at a moment the thread is stopped.";

function queueCursor(offset: number, seq: number): string {
  return Buffer.from(JSON.stringify({ v: 1, o: offset, s: seq })).toString("base64url");
}

function readQueueCursor(cursor: string): { o: number; s: number } {
  try {
    const c = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as { v?: number; o?: unknown; s?: unknown };
    if (c.v === 1 && Number.isInteger(c.o) && (c.o as number) >= 0 && typeof c.s === "number") return { o: c.o as number, s: c.s };
  } catch {
    // fall through
  }
  throw new Error("cursor is not valid: pass nextCursor exactly as returned, or start again without a cursor.");
}

export function registerQueueTools(
  server: McpServer,
  getClient: () => T3Client,
  getDelivery: () => DeliveryContext,
) {
  const deps = (): DeliveryDeps => {
    const d = getDelivery();
    const client = getClient();
    return { client, journal: d.journal, parked: d.parked, readTimeoutMs: client.timeouts?.httpMs, rpcTimeoutMs: client.timeouts?.rpcMs };
  };

  server.registerTool(
    "queue_status",
    {
      title: "Read a thread's message queue",
      description:
        "One thread's queued messages in T3's delivery order, with run state (stopped, preparing, starting, " +
        "running, waiting), held flags, message kind (user, automatic completion, notification), age, text " +
        "and a SHA-256 of each text. Reads T3's bounded thread snapshot (every queued and active run, not the " +
        "whole history). A failed or malformed read is an error, never an empty queue. Paged by position: if a " +
        "later page says consistentSinceFirstPage false, the queue changed; read again from the start for an exact list.",
      inputSchema: {
        threadId: z.string().min(1),
        includeText: z.boolean().optional().describe("Include message text (default true)"),
        maxTextChars: z.number().int().min(0).max(4000).optional().describe("Text per entry (default 300)"),
        limit: z.number().int().min(1).max(500).optional().describe("Entries per page (default 100)"),
        cursor: z.string().optional().describe("nextCursor from the previous page"),
      },
    },
    async (args) => {
      try {
        const start = args.cursor ? readQueueCursor(args.cursor) : { o: 0, s: -1 };
        const read = await getClient().projection(args.threadId, { bounded: true });
        const view = queueView(read.snapshot, {
          maxTextChars: args.includeText === false ? 0 : (args.maxTextChars ?? 300),
        });
        const limit = args.limit ?? 100;
        const page = view.entries.slice(start.o, start.o + limit).map((e) => ({
          ...e,
          ...(args.includeText === false ? { text: undefined } : {}),
        }));
        const next = start.o + page.length;
        const hasMore = next < view.entries.length;
        return jsonResult({
          threadId: view.threadId,
          title: view.title,
          archived: view.archived,
          source: read.source,
          snapshotSequence: view.snapshotSequence,
          ...(args.cursor ? { consistentSinceFirstPage: start.s === view.snapshotSequence } : {}),
          runState: view.runState,
          counts: view.counts,
          queueHeld: view.queueHeld,
          nextToRun: view.nextToRun,
          orderUncertain: view.orderUncertain,
          starvation: view.starvation ? { ...view.starvation, note: STARVATION_NOTE } : null,
          total: view.entries.length,
          shown: page.length,
          hasMore,
          nextCursor: hasMore ? queueCursor(next, args.cursor ? start.s : view.snapshotSequence) : null,
          entries: page,
        });
      } catch (e) {
        return errorResult(e);
      }
    },
  );

  server.registerTool(
    "send_now",
    {
      title: "Start a queued message now (transition-safe)",
      description:
        "Start one queued user message when, and only when, the thread is stopped (T3 refuses while any run is " +
        "preparing, starting, running or waiting). Never interrupts, steers or cancels anything. Each attempt " +
        "re-reads the thread first. Optional bounded wait for the thread to stop. Messages must have waited at " +
        `least ${MIN_DELIVERY_AGE_SECONDS}s. Result outcome: delivered (the run left the queue), deferred ` +
        "(nothing changed; safe to retry later) or unknown (quarantined: run reconcile_send, do not resend).",
      inputSchema: {
        threadId: z.string().min(1),
        queuedRunId: z.string().min(1).optional().describe("Queued run to start (from queue_status); default: the oldest eligible user message"),
        minAgeSeconds: z.number().int().min(MIN_DELIVERY_AGE_SECONDS).max(7 * 86_400).optional().describe(`Minimum queued age (default and floor ${MIN_DELIVERY_AGE_SECONDS})`),
        waitSeconds: z.number().int().min(0).max(MAX_WAIT_SECONDS).optional().describe("Wait up to this long for the thread to stop; nothing is sent after it (default 0: one read)"),
        pollSeconds: z.number().int().min(1).max(30).optional().describe("Seconds between reads while waiting (default 3)"),
        releaseHold: z.boolean().optional().describe("Allow starting from a held queue (T3 then releases every hold on it). Default false"),
        verifySeconds: z.number().int().min(1).max(MAX_VERIFY_SECONDS).optional().describe("Watch this long for the run to start after T3 accepts (default 10); reads stop at the end of it"),
      },
    },
    async (args) => {
      try {
        return jsonResult(await sendNow(deps(), args));
      } catch (e) {
        return errorResult(e);
      }
    },
  );

  server.registerTool(
    "reconcile_send",
    {
      title: "Prove the outcome of an uncertain send",
      description:
        "Settle a send that delivery_journal lists as unknown (quarantined). Reads the thread and resolves the " +
        "record only on proof: the run left the queue, or the message is present. With allowReplay it then " +
        "replays the recorded command with the same commandId; T3 answers from its receipt (applied or rejected " +
        "before) or applies it once now, never twice. The record is never cleared because its owner process " +
        "exited or because the message is still queued.",
      inputSchema: {
        threadId: z.string().min(1),
        queuedRunId: z.string().min(1).optional().describe("For a send_now record"),
        messageId: z.string().min(1).optional().describe("For a send_message record"),
        allowReplay: z.boolean().optional().describe("Replay the same command (same commandId) if state alone does not prove the outcome. Default false"),
      },
    },
    async (args) => {
      try {
        const subject = args.queuedRunId ?? args.messageId;
        if (!subject || (args.queuedRunId && args.messageId)) {
          return errorResult(new Error("Pass exactly one of queuedRunId or messageId."));
        }
        const d = deps();
        const record = d.journal.get(args.threadId, subject);
        if (!record) {
          return jsonResult({ found: false, note: "No open journal record for this send: nothing to reconcile." });
        }
        if (record.subject.kind === "queued-run") {
          return jsonResult(await reconcileQueuedRun(d, record, { allowReplay: args.allowReplay === true }));
        }
        return jsonResult(await reconcileMessage(d, record, { allowReplay: args.allowReplay === true }));
      } catch (e) {
        return errorResult(e);
      }
    },
  );

  server.registerTool(
    "delivery_journal",
    {
      title: "Uncertain and in-flight sends",
      description:
        "Read-only: every send this connector could not prove (unknown, quarantined) or is sending now, from the " +
        "delivery journal on this machine. Resolve unknown records with reconcile_send.",
      inputSchema: {},
    },
    async () => {
      try {
        const { journal, parked } = getDelivery();
        const open = journal.open();
        return jsonResult({
          journalDir: journal.dir,
          open: open.length,
          records: open.map((r) => describeRecord(journal, r)),
          parkedThreads: [...parked],
        });
      } catch (e) {
        return errorResult(e);
      }
    },
  );
}
