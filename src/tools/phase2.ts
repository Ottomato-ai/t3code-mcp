import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { wasNotSent, type T3Client } from "../client.js";
import { attentionOf, newId, nowIso, pendingRequests } from "../model.js";
import type { ModelSelection, ThreadShell } from "../model.js";
import { errorResult, jsonResult, messageRow, relTime, truncate } from "../format.js";
import type { LaunchDesk } from "../desk/desk.js";
import { runningThreadIds } from "../desk/running.js";
import { failLaunch, queuedResult, recordLaunch } from "./desk.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function needsHuman(t: ThreadShell): boolean {
  const a = attentionOf(t);
  return a === "needs-approval" || a === "needs-input" || a === "plan-ready" || a === "error";
}

/**
 * The option id T3 reads for reasoning effort differs per provider: Codex "reasoningEffort",
 * Cursor "reasoning", Claude "effort". A wrong id is ignored and the provider runs on its
 * default (low for Codex), so map by instance id.
 */
export function effortOptionId(instanceId: string): string {
  if (instanceId.startsWith("codex")) return "reasoningEffort";
  if (instanceId.startsWith("cursor")) return "reasoning";
  return "effort";
}

const EFFORT_IDS = ["effort", "reasoningEffort", "reasoning"];

/** Set the effort option on a model selection, keeping its other options. */
export function withEffort(sel: ModelSelection, effort: string): ModelSelection {
  const key = effortOptionId(sel.instanceId);
  if (sel.options !== undefined && !Array.isArray(sel.options)) {
    const rest = Object.fromEntries(Object.entries(sel.options).filter(([k]) => !EFFORT_IDS.includes(k)));
    return { ...sel, options: { ...rest, [key]: effort } };
  }
  const others = (sel.options ?? []).filter((o) => !EFFORT_IDS.includes(o.id));
  return { ...sel, options: [...others, { id: key, value: effort }] };
}

export function registerPhase2(
  server: McpServer,
  getClient: () => T3Client,
  getDesk: () => LaunchDesk,
) {
  server.registerTool(
    "pending_actions",
    {
      title: "What needs me?",
      description:
        "Cross-thread inbox: every thread currently blocked on the human — pending command/file " +
        "approvals (with the exact request detail), unanswered agent questions, actionable " +
        "proposed plans, and errored sessions. Includes the requestIds needed by " +
        "respond_to_approval / respond_to_user_input.",
      inputSchema: {},
    },
    async () => {
      try {
        const client = getClient();
        const shell = await client.shell();
        const projectsById = new Map(shell.projects.map((p) => [p.id, p]));
        const blocked = shell.threads
          .filter((t) => !t.archivedAt && needsHuman(t))
          .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
          .slice(0, 15);
        const items = [];
        for (const t of blocked) {
          const attention = attentionOf(t);
          const item: Record<string, unknown> = {
            threadId: t.id,
            title: t.title ?? "(untitled)",
            project: projectsById.get(t.projectId)?.title ?? t.projectId,
            attention,
            updated: relTime(t.updatedAt),
          };
          if (attention === "needs-approval" || attention === "needs-input") {
            try {
              const detail = await client.thread(t.id, { turnLimit: 3 });
              item.requests = pendingRequests(detail.thread.activities ?? []);
            } catch {
              item.requests = "unavailable";
            }
          }
          if (attention === "error") {
            item.lastError = t.session?.lastError ?? t.latestTurn?.state ?? null;
          }
          items.push(item);
        }
        return jsonResult({
          needsAttention: items.length,
          items,
          ...(items.length === 0 ? { note: "Nothing is waiting on you." } : {}),
        });
      } catch (e) {
        return errorResult(e);
      }
    },
  );

  server.registerTool(
    "respond_to_approval",
    {
      title: "Respond to a permission request",
      description:
        "Approve or decline a pending permission request (command execution, file read, file " +
        "change) on a thread. Get the requestId from pending_actions or get_thread. Decisions: " +
        "accept (once), acceptForSession (don't ask again this session), decline, cancel.",
      inputSchema: {
        threadId: z.string(),
        requestId: z.string().describe("From pendingRequests in pending_actions/get_thread"),
        decision: z.enum(["accept", "acceptForSession", "decline", "cancel"]),
      },
    },
    async (args) => {
      try {
        const result = await getClient().dispatch({
          type: "thread.approval.respond",
          commandId: newId(),
          threadId: args.threadId,
          requestId: args.requestId,
          decision: args.decision,
          createdAt: nowIso(),
        });
        return jsonResult({ responded: true, decision: args.decision, sequence: result.sequence });
      } catch (e) {
        return errorResult(e);
      }
    },
  );

  server.registerTool(
    "respond_to_user_input",
    {
      title: "Answer an agent's question",
      description:
        "Answer a pending user-input request (an agent asked a question with options or free " +
        "text). Get the requestId and the question structure from pending_actions or get_thread; " +
        "answers is an object keyed by question id.",
      inputSchema: {
        threadId: z.string(),
        requestId: z.string(),
        answers: z
          .record(z.string(), z.unknown())
          .describe("Answers keyed by question id, e.g. {\"q1\": \"option-a\"}"),
      },
    },
    async (args) => {
      try {
        const result = await getClient().dispatch({
          type: "thread.user-input.respond",
          commandId: newId(),
          threadId: args.threadId,
          requestId: args.requestId,
          answers: args.answers,
          createdAt: nowIso(),
        });
        return jsonResult({ responded: true, sequence: result.sequence });
      } catch (e) {
        return errorResult(e);
      }
    },
  );

  server.registerTool(
    "create_thread",
    {
      title: "Start a new T3 thread",
      description:
        "Create a new agent thread in a project and send its first message, starting the agent. " +
        "Gated by the launch desk: at most T3_LAUNCH_CAP (default 15) live T3 threads across all " +
        "lanes. If a slot is free and nobody waits ahead, it launches at once; otherwise it answers " +
        "queued with a queue_entry. Do not retry in a loop: call launch_wait, then call " +
        "create_thread again with queue_entry once granted. The thread runs directly in the project " +
        "workspace (worktree isolation is only available from the T3 UI). Model defaults to the " +
        "project's default, falling back to the project's most recent thread's model; effort " +
        "defaults to high. runtimeMode defaults to approval-required (safest); pass full-access for " +
        "autonomous work.",
      inputSchema: {
        projectId: z.string().describe("Project id (from list_projects)"),
        message: z.string().min(1).describe("First user message / task description"),
        lane: z.string().min(1).describe("Your exact session title (the launch queue is per lane)"),
        queue_entry: z
          .string()
          .optional()
          .describe("Entry id from an earlier queued answer, once launch_wait says granted"),
        ned_requested: z
          .boolean()
          .optional()
          .describe("True only when Ned asked for this launch himself in your session (goes first; logged)"),
        title: z.string().optional().describe("Thread title (default: derived from message)"),
        provider: z
          .string()
          .optional()
          .describe("Provider instance id, e.g. claude, codex, cursor, grok, opencode"),
        model: z.string().optional().describe("Model name for the provider, e.g. gpt-5.4"),
        effort: z
          .enum(["low", "medium", "high", "xhigh", "max"])
          .optional()
          .describe("Reasoning effort for the new thread (default high; max only with ned_requested)"),
        runtimeMode: z
          .enum(["approval-required", "auto-accept-edits", "auto", "full-access"])
          .optional()
          .describe("Permission mode (default approval-required)"),
        interactionMode: z.enum(["default", "plan"]).optional(),
      },
    },
    async (args) => {
      try {
        if (args.effort === "max" && args.ned_requested !== true) {
          return errorResult(
            new Error("effort max is refused unless Ned asked for it himself (ned_requested: true). Use high."),
          );
        }
        const client = getClient();
        const shell = await client.shell();
        const project = shell.projects.find((p) => p.id === args.projectId);
        if (!project) {
          return errorResult(
            new Error(`No project with id ${args.projectId}. Use list_projects to find one.`),
          );
        }
        let modelSelection: ModelSelection | null =
          args.provider && args.model
            ? { instanceId: args.provider, model: args.model }
            : (project.defaultModelSelection ?? null);
        if (!modelSelection) {
          const recent = shell.threads
            .filter((t) => t.projectId === project.id && t.modelSelection)
            .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))[0];
          modelSelection = recent?.modelSelection ?? null;
        }
        if (!modelSelection) {
          return errorResult(
            new Error(
              "No model available: project has no default and no prior threads. " +
                "Pass provider and model explicitly (e.g. provider=claude).",
            ),
          );
        }
        const selection = withEffort(modelSelection, args.effort ?? "high");
        const runtimeMode = args.runtimeMode ?? "approval-required";
        const interactionMode = args.interactionMode ?? "default";
        const title = args.title ?? truncate(args.message.replace(/\s+/g, " "), 60).text;

        const desk = getDesk();
        const admission = desk.admit(
          {
            lane: args.lane,
            projectId: project.id,
            project: project.title,
            task: title,
            ned: args.ned_requested === true,
            queueEntry: args.queue_entry,
          },
          runningThreadIds(shell),
        );
        if (admission.kind === "queued") return queuedResult(admission, "create_thread");

        const threadId = newId();
        let result: { sequence: number };
        // Sent means the request may have reached T3; only a refused connection is "not sent".
        let createSent = false;
        try {
          // The HTTP dispatch path has no bootstrap expansion (that lives in the
          // WS handler), so create the thread and start the turn as two commands.
          try {
            await client.dispatch({
              type: "thread.create",
              commandId: newId(),
              threadId,
              projectId: project.id,
              title,
              modelSelection: selection,
              runtimeMode,
              interactionMode,
              branch: null,
              worktreePath: null,
              createdAt: nowIso(),
            });
          } catch (e) {
            createSent = !wasNotSent(e);
            throw e;
          }
          createSent = true;
          result = await client.dispatch({
            type: "thread.turn.start",
            commandId: newId(),
            threadId,
            message: { messageId: newId(), role: "user", text: args.message, attachments: [] },
            runtimeMode,
            interactionMode,
            createdAt: nowIso(),
          });
        } catch (e) {
          throw failLaunch(desk, admission.entry.id, admission.claim, e, {
            sent: createSent,
            threadId,
            tool: "create_thread",
          });
        }
        const warning = recordLaunch(desk, admission.entry.id, admission.claim, threadId);
        return jsonResult({
          created: true,
          threadId,
          title,
          project: project.title,
          model: `${selection.instanceId}/${selection.model}`,
          runtimeMode,
          queue_entry: admission.entry.id,
          sequence: result.sequence,
          ...(warning ? { warning } : {}),
          note: "Agent is starting. Use wait_for_turn to get the first reply. Stop the thread (stop_thread) when it is done.",
        });
      } catch (e) {
        return errorResult(e);
      }
    },
  );

  server.registerTool(
    "interrupt_thread",
    {
      title: "Interrupt a running turn",
      description:
        "Interrupt the agent's current turn on a thread (like pressing stop). The thread and " +
        "session survive; you can send a new message afterwards.",
      inputSchema: { threadId: z.string() },
    },
    async (args) => {
      try {
        const result = await getClient().dispatch({
          type: "thread.turn.interrupt",
          commandId: newId(),
          threadId: args.threadId,
          createdAt: nowIso(),
        });
        return jsonResult({ interrupted: true, sequence: result.sequence });
      } catch (e) {
        return errorResult(e);
      }
    },
  );

  server.registerTool(
    "stop_thread",
    {
      title: "Stop a thread's agent session",
      description:
        "Shut down the provider process attached to a thread. The thread and its history remain; " +
        "a new session starts automatically on the next message.",
      inputSchema: { threadId: z.string() },
    },
    async (args) => {
      try {
        const result = await getClient().dispatch({
          type: "thread.session.stop",
          commandId: newId(),
          threadId: args.threadId,
          createdAt: nowIso(),
        });
        return jsonResult({ stopped: true, sequence: result.sequence });
      } catch (e) {
        return errorResult(e);
      }
    },
  );

  server.registerTool(
    "wait_for_turn",
    {
      title: "Wait for the agent's reply",
      description:
        "Block until the thread's current turn finishes OR the agent asks for approval/input, " +
        "then return the latest assistant message or the pending request. Use after send_message " +
        "or create_thread for a single round-trip. Times out (default 120s, max 300s) with the " +
        "current state.",
      inputSchema: {
        threadId: z.string(),
        timeoutSeconds: z.number().int().min(5).max(300).optional(),
      },
    },
    async (args) => {
      try {
        const client = getClient();
        const deadline = Date.now() + (args.timeoutSeconds ?? 120) * 1000;
        let last: Awaited<ReturnType<typeof client.thread>> | undefined;
        for (;;) {
          last = await client.thread(args.threadId, { turnLimit: 2 });
          const t = last.thread;
          const pending = pendingRequests(t.activities ?? []);
          const turnState = t.latestTurn?.state;
          const messages = t.messages ?? [];
          const lastUser = [...messages].reverse().find((m) => m.role === "user");
          const assistant = [...messages]
            .reverse()
            .find((m) => m.role === "assistant" && !m.streaming);
          // A queued turn briefly leaves the thread looking "completed" right
          // after send_message: only settle once the reply postdates the last
          // user message (or the turn errored/was interrupted).
          const answered =
            assistant &&
            (!lastUser || Date.parse(assistant.createdAt) >= Date.parse(lastUser.createdAt));
          const running =
            turnState === "running" ||
            t.session?.status === "starting" ||
            (t.session?.activeTurnId != null && turnState !== "completed");
          if (pending.length > 0) {
            return jsonResult({
              outcome: "needs-you",
              pendingRequests: pending,
              note: "Respond with respond_to_approval or respond_to_user_input.",
            });
          }
          const settled =
            !running &&
            (turnState === "error" || turnState === "interrupted" ||
              (turnState === "completed" && answered));
          if (settled) {
            return jsonResult({
              outcome: turnState === "completed" ? "completed" : turnState,
              sessionStatus: t.session?.status ?? "none",
              lastError: t.session?.lastError ?? null,
              reply: assistant ? messageRow(assistant, 6000) : null,
            });
          }
          if (Date.now() > deadline) {
            return jsonResult({
              outcome: "timeout",
              turnState: turnState ?? null,
              sessionStatus: t.session?.status ?? "none",
              note: "Still working. Call wait_for_turn again or check later with get_thread.",
            });
          }
          await sleep(1500);
        }
      } catch (e) {
        return errorResult(e);
      }
    },
  );

  server.registerTool(
    "archive_thread",
    {
      title: "Archive a thread",
      description: "Archive a thread (hides it from the active list; reversible).",
      inputSchema: { threadId: z.string() },
    },
    async (args) => {
      try {
        const result = await getClient().dispatch({
          type: "thread.archive",
          commandId: newId(),
          threadId: args.threadId,
        });
        return jsonResult({ archived: true, sequence: result.sequence });
      } catch (e) {
        return errorResult(e);
      }
    },
  );

  server.registerTool(
    "unarchive_thread",
    {
      title: "Unarchive a thread",
      description: "Bring an archived thread back to the active list.",
      inputSchema: { threadId: z.string() },
    },
    async (args) => {
      try {
        const result = await getClient().dispatch({
          type: "thread.unarchive",
          commandId: newId(),
          threadId: args.threadId,
        });
        return jsonResult({ unarchived: true, sequence: result.sequence });
      } catch (e) {
        return errorResult(e);
      }
    },
  );

  server.registerTool(
    "set_thread_title",
    {
      title: "Rename a thread",
      description: "Set a thread's title (useful for voice: 'call this one auth bug').",
      inputSchema: { threadId: z.string(), title: z.string().min(1) },
    },
    async (args) => {
      try {
        const result = await getClient().dispatch({
          type: "thread.meta.update",
          commandId: newId(),
          threadId: args.threadId,
          title: args.title,
        });
        return jsonResult({ renamed: true, title: args.title, sequence: result.sequence });
      } catch (e) {
        return errorResult(e);
      }
    },
  );
}
