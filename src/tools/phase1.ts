import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { wasNotSent, type T3Client } from "../client.js";
import { attentionOf, pendingRequests } from "../model.js";
import { commands } from "../v2.js";
import type { Attention } from "../model.js";
import {
  activityOverview,
  errorResult,
  jsonResult,
  messageRow,
  relTime,
  threadRow,
} from "../format.js";
import type { LaunchDesk } from "../desk/desk.js";
import { LIVE_SESSION_STATES, runningThreadIds } from "../desk/running.js";
import { failLaunch, queuedResult, recordLaunch } from "./desk.js";
import { ms, paginate, queryHash } from "../paging.js";
import { sha256 } from "../queue.js";
import { stableId } from "../model.js";
import { dispatchMessage, type MessageSendResult } from "../delivery/deliver.js";
import { defaultDelivery } from "../delivery/context.js";
import { connectorVersion, readBuildInfo } from "../build-info.js";
import { TIMEOUT_ENV, loadTimeouts } from "../config.js";
import type { DeliveryContext } from "./queue.js";

/** What runs here: build provenance, effective timeouts, open journal records. */
function connectorStatus(client: T3Client | undefined, getDelivery: () => DeliveryContext) {
  const build = readBuildInfo();
  let journal: { dir: string; open: number } | { error: string };
  let parked: number | null = null;
  try {
    const d = getDelivery();
    journal = { dir: d.journal.dir, open: d.journal.open().length };
    parked = d.parked.size;
  } catch (e) {
    journal = { error: e instanceof Error ? e.message : String(e) };
  }
  return {
    version: connectorVersion(),
    build: build
      ? { gitSha: build.gitSha, gitDirty: build.gitDirty, sourceHash: build.sourceHash, builtAt: build.builtAt }
      : "no build-info.json: this dist was not built with scripts/build-info.mjs",
    timeouts: client ? client.timeouts : safeTimeouts(),
    timeoutVariables: TIMEOUT_ENV,
    deliveryJournal: journal,
    parkedThreads: parked,
  };
}

function safeTimeouts() {
  try {
    return loadTimeouts();
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

function safeConnectorStatus(getDelivery: () => DeliveryContext) {
  try {
    return connectorStatus(undefined, getDelivery);
  } catch {
    return undefined;
  }
}

/** A send whose outcome is not "delivered": an error result that says not to resend blindly. */
function uncertainSendResult(threadId: string, sent: MessageSendResult) {
  const advice =
    sent.outcome === "unknown"
      ? "Do NOT send this message again with new text or without the same idempotencyKey: it may already be in the thread. " +
        "Run reconcile_send with this threadId and messageId (allowReplay: true asks T3 by commandId, applying it at most once)."
      : "T3 did not take the message; nothing was sent.";
  return {
    content: [
      {
        type: "text" as const,
        text: `Error: message send outcome ${sent.outcome} (${sent.reason}). ${advice}\n${JSON.stringify({ threadId, ...sent }, null, 1)}`,
      },
    ],
    isError: true,
  };
}

const ATTENTION_VALUES = [
  "needs-approval",
  "needs-input",
  "plan-ready",
  "working",
  "error",
  "done",
  "idle",
] as const;

export function registerPhase1(
  server: McpServer,
  getClient: () => T3Client,
  getDesk: () => LaunchDesk,
  getDelivery: () => DeliveryContext = defaultDelivery,
) {
  server.registerTool(
    "t3_status",
    {
      title: "T3 Code status",
      description:
        "Check the local T3 Code server: is it running, is auth working, and a summary of " +
        "projects/threads (how many are working, how many need attention). Use this first if " +
        "anything else fails.",
      inputSchema: {},
    },
    async () => {
      try {
        const client = getClient();
        const env = await client.probe();
        let auth = false;
        let summary: Record<string, unknown> = {};
        try {
          const shell = await client.shell();
          auth = true;
          const active = shell.threads.filter((t) => !t.archivedAt);
          const byAttention: Record<string, number> = {};
          for (const t of active) {
            const a = attentionOf(t);
            byAttention[a] = (byAttention[a] ?? 0) + 1;
          }
          summary = {
            projects: shell.projects.length,
            threads: { total: shell.threads.length, active: active.length, byAttention },
          };
        } catch (e) {
          summary = { authError: e instanceof Error ? e.message : String(e) };
        }
        return jsonResult({
          running: true,
          origin: client.origin,
          environment: env.label,
          serverVersion: env.serverVersion,
          authOk: auth,
          ...summary,
          connector: connectorStatus(client, getDelivery),
        });
      } catch (e) {
        return errorResult(e, { connector: safeConnectorStatus(getDelivery) });
      }
    },
  );

  server.registerTool(
    "list_projects",
    {
      title: "List T3 projects",
      description:
        "List the projects (workspaces/repos) registered in T3 Code, with per-project counts of " +
        "active and attention-needing threads.",
      inputSchema: {},
    },
    async () => {
      try {
        const shell = await getClient().shell();
        const counts = new Map<string, { active: number; needsAttention: number }>();
        for (const t of shell.threads) {
          if (t.archivedAt) continue;
          const c = counts.get(t.projectId) ?? { active: 0, needsAttention: 0 };
          c.active++;
          const a = attentionOf(t);
          if (a === "needs-approval" || a === "needs-input" || a === "plan-ready" || a === "error")
            c.needsAttention++;
          counts.set(t.projectId, c);
        }
        const projects = shell.projects
          .filter((p) => !p.deletedAt)
          .map((p) => ({
            projectId: p.id,
            title: p.title,
            workspaceRoot: p.workspaceRoot,
            defaultModel: p.defaultModelSelection
              ? `${p.defaultModelSelection.instanceId}/${p.defaultModelSelection.model}`
              : null,
            activeThreads: counts.get(p.id)?.active ?? 0,
            threadsNeedingAttention: counts.get(p.id)?.needsAttention ?? 0,
          }))
          .sort((a, b) => b.activeThreads - a.activeThreads);
        return jsonResult({ projects });
      } catch (e) {
        return errorResult(e);
      }
    },
  );

  server.registerTool(
    "list_threads",
    {
      title: "List T3 threads",
      description:
        "List agent threads in T3 Code, most recently updated first. Filter by project, " +
        "attention state (needs-approval, needs-input, plan-ready, working, error, done, idle), " +
        "or include archived threads. Each row includes the thread's attention state — what, if " +
        "anything, it needs from the human. Paged: when hasMore is true, call again with " +
        "cursor=nextCursor (same filters) until it is false; total is the number of matching " +
        "threads. For a complete fleet check use order \"created\" (stable while threads update) " +
        "and also read changedSinceFirstPage on the last page.",
      inputSchema: {
        projectId: z.string().optional().describe("Only threads in this project"),
        attention: z
          .enum(ATTENTION_VALUES)
          .optional()
          .describe("Only threads in this attention state"),
        includeArchived: z.boolean().optional().describe("Include archived threads (default false)"),
        limit: z.number().int().min(1).max(100).optional().describe("Rows per page (default 25)"),
        cursor: z.string().optional().describe("nextCursor from the previous page (same filters and order)"),
        order: z
          .enum(["updated", "created"])
          .optional()
          .describe("updated: most recently updated first (default). created: newest first by creation time, stable while threads update"),
      },
    },
    async (args) => {
      try {
        const shell = await getClient().shell({ includeArchived: args.includeArchived === true });
        const projectsById = new Map(shell.projects.map((p) => [p.id, p]));
        const order = args.order ?? "updated";
        const inScope = shell.threads.filter((t) => (args.includeArchived ? true : !t.archivedAt));
        const matching = inScope
          .filter((t) => (args.projectId ? t.projectId === args.projectId : true))
          .filter((t) => (args.attention ? attentionOf(t) === (args.attention as Attention) : true));
        const page = paginate(
          matching.map((t) => ({
            row: t,
            rank: [order === "created" ? ms(t.createdAt) : ms(t.updatedAt)],
            id: t.id,
            updatedMs: ms(t.updatedAt),
          })),
          {
            limit: args.limit ?? 25,
            cursor: args.cursor,
            query: queryHash({
              tool: "list_threads",
              projectId: args.projectId ?? null,
              attention: args.attention ?? null,
              includeArchived: args.includeArchived === true,
              order,
            }),
            snapshotSequence: shell.snapshotSequence,
            allUpdated: inScope.map((t) => ({ id: t.id, updatedMs: ms(t.updatedAt) })),
          },
        );
        return jsonResult({
          shown: page.rows.length,
          // Kept for older callers: every thread in scope (archived only with includeArchived), not the matches.
          matchedOf: inScope.length,
          total: page.total,
          returnedSoFar: page.returnedSoFar,
          hasMore: page.hasMore,
          nextCursor: page.nextCursor,
          order,
          snapshotSequence: page.snapshotSequence,
          ...(args.cursor
            ? {
                firstSnapshotSequence: page.firstSnapshotSequence,
                consistentSinceFirstPage: page.consistentSinceFirstPage,
                changedSinceFirstPage: page.changedSinceFirstPage,
              }
            : {}),
          threads: page.rows.map((t) => threadRow(t, projectsById)),
        });
      } catch (e) {
        return errorResult(e);
      }
    },
  );

  server.registerTool(
    "get_thread",
    {
      title: "Read a T3 thread",
      description:
        "Read a thread's recent conversation: messages from the last N turns, session status, " +
        "any pending approval/user-input requests (with requestIds needed to respond), and an " +
        "activity overview. Use beforeCursor from a previous call to page further back.",
      inputSchema: {
        threadId: z.string().describe("Thread id (from list_threads)"),
        turnLimit: z
          .number()
          .int()
          .min(1)
          .max(50)
          .optional()
          .describe("How many recent turns to include (default 5)"),
        beforeCursor: z.string().optional().describe("Pagination cursor from a previous call"),
        includeActivities: z
          .boolean()
          .optional()
          .describe("Include per-activity detail overview (default true)"),
      },
    },
    async (args) => {
      try {
        const snap = await getClient().thread(args.threadId, {
          turnLimit: args.turnLimit ?? 5,
          beforeCursor: args.beforeCursor,
        });
        const t = snap.thread;
        const pending = pendingRequests(t.activities ?? []);
        return jsonResult({
          threadId: t.id,
          title: t.title,
          attention: attentionOf(t),
          session: {
            status: t.session?.status ?? "none",
            provider: t.session?.providerName ?? null,
            lastError: t.session?.lastError ?? null,
          },
          latestTurn: t.latestTurn
            ? { state: t.latestTurn.state, completed: relTime(t.latestTurn.completedAt) }
            : null,
          model: t.modelSelection
            ? `${t.modelSelection.instanceId}/${t.modelSelection.model}`
            : null,
          branch: t.branch ?? null,
          runtimeMode: t.runtimeMode,
          interactionMode: t.interactionMode,
          pendingRequests: pending,
          messages: (t.messages ?? []).map((m) => messageRow(m)),
          ...(args.includeActivities === false
            ? {}
            : { activities: activityOverview(t.activities ?? []) }),
          page: snap.page ?? null,
        });
      } catch (e) {
        return errorResult(e);
      }
    },
  );

  server.registerTool(
    "send_message",
    {
      title: "Send a message to a T3 thread",
      description:
        "Send a user message to an existing thread and start an agent turn. Reuses the thread's " +
        "current model, runtime mode, and interaction mode unless overridden. If the agent is " +
        "mid-turn the message is queued by T3. Returns immediately; use wait_for_turn or " +
        "get_thread to see the reply. A message to a thread whose session is not live (stopped, " +
        "error, none) restarts the agent and goes through the launch desk like create_thread: it " +
        "needs lane and may answer queued (then call launch_wait and send again with queue_entry).",
      inputSchema: {
        threadId: z.string().describe("Thread id (from list_threads)"),
        message: z.string().min(1).describe("The message text to send"),
        runtimeMode: z
          .enum(["approval-required", "auto-accept-edits", "auto", "full-access"])
          .optional()
          .describe("Override permission mode for this turn onward"),
        interactionMode: z.enum(["default", "plan"]).optional(),
        lane: z
          .string()
          .min(1)
          .optional()
          .describe("Your exact session title; required when the thread's session is not live (the send restarts it)"),
        queue_entry: z.string().optional().describe("Entry id from an earlier queued answer, once launch_wait says granted"),
        ned_requested: z
          .boolean()
          .optional()
          .describe("True only when Ned asked for this restart himself in your session (goes first; logged)"),
        idempotencyKey: z
          .string()
          .min(8)
          .max(200)
          .optional()
          .describe("Any unique string for this message. Retrying with the same key never sends it twice (T3 answers from its receipt)"),
      },
    },
    async (args) => {
      try {
        const client = getClient();
        const snap = await client.thread(args.threadId, { turnLimit: 1, window: "bounded" });
        const t = snap.thread;
        const live = LIVE_SESSION_STATES.includes(t.session?.status ?? "");
        let gate: { desk: LaunchDesk; id: string; claim: string } | undefined;
        if (!live) {
          if (!args.lane) {
            return errorResult(
              new Error(
                `Thread ${t.id} has no live session (${t.session?.status ?? "none"}); this message would restart it, ` +
                  "which counts against the T3 launch cap. Pass lane (your exact session title).",
              ),
            );
          }
          const shell = await client.shell();
          const project = shell.projects.find((p) => p.id === t.projectId);
          const desk = getDesk();
          const admission = desk.admit(
            {
              lane: args.lane,
              projectId: t.projectId,
              project: project?.title ?? t.projectId,
              task: t.title ?? t.id,
              ned: args.ned_requested === true,
              queueEntry: args.queue_entry,
              kind: "resume",
              targetThreadId: t.id,
            },
            runningThreadIds(shell),
          );
          if (admission.kind === "queued") return queuedResult(admission, "send_message");
          gate = { desk, id: admission.entry.id, claim: admission.claim };
        }
        // Protocol 2: modes are thread settings, set before the message when they change.
        const pre: Record<string, unknown>[] = [];
        if (args.runtimeMode && args.runtimeMode !== t.runtimeMode) pre.push(commands.setRuntimeMode(t.id, args.runtimeMode));
        if (args.interactionMode && args.interactionMode !== t.interactionMode) {
          pre.push(commands.setInteractionMode(t.id, args.interactionMode));
        }
        // An idempotencyKey fixes the command and message ids, so a retry of this call is
        // answered from T3's receipt instead of sending the message twice.
        const ids = args.idempotencyKey
          ? {
              commandId: stableId("send_message/command", t.id, args.idempotencyKey),
              messageId: stableId("send_message/message", t.id, args.idempotencyKey),
            }
          : {};
        const command = commands.messageDispatch({ threadId: t.id, text: args.message, ...ids });
        let sent: MessageSendResult;
        // Only the message can start a provider; a failed mode command launched nothing.
        let atMessage = false;
        try {
          for (const c of pre) await client.dispatch(c);
          atMessage = true;
          const { journal, parked } = getDelivery();
          sent = await dispatchMessage({ client, journal, parked, readTimeoutMs: client.timeouts?.httpMs, rpcTimeoutMs: client.timeouts?.rpcMs }, command, sha256(args.message));
        } catch (e) {
          if (!gate) throw e;
          throw failLaunch(gate.desk, gate.id, gate.claim, e, { sent: atMessage && !wasNotSent(e), threadId: t.id, tool: "send_message" });
        }
        if (sent.outcome !== "delivered") {
          if (gate) {
            const err = new Error(`send ${sent.outcome} (${sent.reason})`);
            failLaunch(gate.desk, gate.id, gate.claim, err, { sent: sent.outcome === "unknown", threadId: t.id, tool: "send_message" });
          }
          return uncertainSendResult(t.id, sent);
        }
        const warning = gate ? recordLaunch(gate.desk, gate.id, gate.claim, t.id) : undefined;
        const busy = t.session?.activeTurnId ? true : false;
        return jsonResult({
          ...(warning ? { warning } : {}),
          sent: true,
          outcome: sent.outcome,
          reason: sent.reason,
          threadId: t.id,
          threadTitle: t.title,
          sequence: sent.sequence,
          commandId: sent.commandId,
          messageId: sent.messageId,
          ...(gate ? { queue_entry: gate.id, restarted: true } : {}),
          wasBusy: busy,
          note: busy
            ? "The thread was busy: T3 queued the message behind the active run. Use queue_status to see it."
            : "Turn started. Use wait_for_turn or get_thread to read the reply.",
        });
      } catch (e) {
        return errorResult(e);
      }
    },
  );
}
