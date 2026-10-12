import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { wasNotSent, type T3Client } from "../client.js";
import { attentionOf, newId, nowIso, pendingRequests } from "../model.js";
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
        });
      } catch (e) {
        return errorResult(e);
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
        "anything, it needs from the human.",
      inputSchema: {
        projectId: z.string().optional().describe("Only threads in this project"),
        attention: z
          .enum(ATTENTION_VALUES)
          .optional()
          .describe("Only threads in this attention state"),
        includeArchived: z.boolean().optional().describe("Include archived threads (default false)"),
        limit: z.number().int().min(1).max(100).optional().describe("Max rows (default 25)"),
      },
    },
    async (args) => {
      try {
        const shell = await getClient().shell();
        const projectsById = new Map(shell.projects.map((p) => [p.id, p]));
        const limit = args.limit ?? 25;
        const rows = shell.threads
          .filter((t) => (args.includeArchived ? true : !t.archivedAt))
          .filter((t) => (args.projectId ? t.projectId === args.projectId : true))
          .filter((t) => (args.attention ? attentionOf(t) === (args.attention as Attention) : true))
          .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
          .slice(0, limit)
          .map((t) => threadRow(t, projectsById));
        const total = shell.threads.filter((t) => (args.includeArchived ? true : !t.archivedAt))
          .length;
        return jsonResult({ shown: rows.length, matchedOf: total, threads: rows });
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
      },
    },
    async (args) => {
      try {
        const client = getClient();
        const snap = await client.thread(args.threadId, { turnLimit: 1 });
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
        const command = {
          type: "thread.turn.start",
          commandId: newId(),
          threadId: t.id,
          message: { messageId: newId(), role: "user", text: args.message, attachments: [] },
          runtimeMode: args.runtimeMode ?? t.runtimeMode ?? "full-access",
          interactionMode: args.interactionMode ?? t.interactionMode ?? "default",
          createdAt: nowIso(),
        };
        let result: { sequence: number };
        try {
          result = await client.dispatch(command);
        } catch (e) {
          if (!gate) throw e;
          throw failLaunch(gate.desk, gate.id, gate.claim, e, { sent: !wasNotSent(e), threadId: t.id, tool: "send_message" });
        }
        const warning = gate ? recordLaunch(gate.desk, gate.id, gate.claim, t.id) : undefined;
        return jsonResult({
          ...(warning ? { warning } : {}),
          sent: true,
          threadId: t.id,
          threadTitle: t.title,
          sequence: result.sequence,
          ...(gate ? { queue_entry: gate.id, restarted: true } : {}),
          wasBusy: t.session?.activeTurnId ? true : false,
          note: "Turn started. Use wait_for_turn or get_thread to read the reply.",
        });
      } catch (e) {
        return errorResult(e);
      }
    },
  );
}
