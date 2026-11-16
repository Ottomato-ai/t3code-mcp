// Queued messages: list, cancel and edit the messages T3 holds behind a busy thread's running
// turn. Commands as the T3 web client sends them (queued-run.cancel, queued-run.edit); the
// order and the text as the T3 server reads them (see queuedMessagesFromV2).
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { wasNotSent, type T3Client } from "../client.js";
import { errorResult, jsonResult, relTime } from "../format.js";
import type { ThreadShell } from "../model.js";
import { commands, queuedMessagesFromV2, type QueuedMessage, type V2ThreadDetailSnapshot } from "../v2.js";
import type { LaunchDesk } from "../desk/desk.js";
import { UNTRUSTED_NOTE, untrusted } from "../desk/untrusted.js";

/** Most threads list_queued_messages reads when no threadId is given. */
export const LIST_THREAD_CAP = 25;
/** Characters of message text shown per row. */
export const TEXT_CHARS = 300;
/** Characters of message text written to the desk event log. */
export const LOG_CHARS = 120;
/** The server's own limit for an edited message (t3_queue text: isMaxLength(1e5)). */
export const EDIT_MAX_CHARS = 100_000;

const STARTED = ["preparing", "starting", "running", "waiting"];

/** Clip by code points (never splits an emoji or surrogate pair). */
function clip(text: string, max: number): { text: string; truncated: boolean } {
  const chars = Array.from(text);
  if (chars.length <= max) return { text, truncated: false };
  return { text: `${chars.slice(0, max).join("")}…`, truncated: true };
}

/** Message text for a tool answer: clipped, then marked as data written by someone else. */
function shown(text: string, max = TEXT_CHARS): { text: string; truncated: boolean } {
  const c = clip(text, max);
  return { text: untrusted(c.text, Number.MAX_SAFE_INTEGER), truncated: c.truncated };
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * A queue only stands behind an active run. The shell derives the session from the run status
 * (v2.ts sessionFromShell): any active run, a queued one included, gives running or starting.
 */
const ACTIVE_SESSION = ["running", "starting"];
function hasActiveRun(t: ThreadShell): boolean {
  return ACTIVE_SESSION.includes(t.session?.status ?? "");
}

/** The queued entry for runId, or an error that names the run's state and the fix. */
function queuedEntry(detail: V2ThreadDetailSnapshot, threadId: string, runId: string, action: "cancel" | "edit"): QueuedMessage {
  const run = (detail.projection.runs ?? []).find((r) => r.id === runId);
  if (!run) {
    throw new Error(
      `No run ${runId} on thread ${threadId}. Call list_queued_messages with threadId ${threadId} to see its queued runIds.`,
    );
  }
  if (run.status !== "queued") {
    const fix = STARTED.includes(run.status)
      ? `It has already started. To stop it, use interrupt_thread on thread ${threadId}.`
      : action === "edit"
        ? "Nothing to do; send a new message with send_message if it is still needed."
        : "Nothing to do.";
    throw new Error(`Run ${runId} is ${run.status}, not queued. ${fix}`);
  }
  const entry = queuedMessagesFromV2(detail).find((m) => m.runId === runId);
  if (!entry) throw new Error(`Run ${runId} is queued but T3 did not list it; call list_queued_messages again.`);
  return entry;
}

export function registerQueue(server: McpServer, getClient: () => T3Client, getDesk: () => LaunchDesk) {
  /** Audit trail in the launch desk event log; never fails the tool. */
  const log = (event: Record<string, unknown>) => {
    try {
      getDesk().store.logEvent(event);
    } catch (e) {
      console.error(`queue: could not write the desk event log: ${message(e)}`);
    }
  };

  server.registerTool(
    "list_queued_messages",
    {
      title: "List queued messages",
      description:
        "Messages T3 holds behind a busy thread's running turn (sent with send_message or the T3 " +
        "UI while the agent was working). With threadId: that thread's queue. Without: every " +
        `non-archived thread with an active run, read one by one (at most ${LIST_THREAD_CAP}; the ` +
        "answer says when capped). Rows in send order (position 1 = next) with age, sender and the " +
        "text (wrapped as untrusted data), then threadId and runId for cancel_queued_message and " +
        "edit_queued_message. Read-only.",
      inputSchema: {
        threadId: z.string().min(1).optional().describe("Only this thread (from list_threads)"),
        limit: z.number().int().min(1).max(100).optional().describe("Max rows (default 20)"),
      },
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      try {
        const client = getClient();
        const limit = args.limit ?? 20;
        const shell = await client.shell();
        const projects = new Map(shell.projects.map((p) => [p.id, p.title]));
        let candidates: Array<{ id: string; title: string | null }>;
        let ofThreads = 1;
        if (args.threadId) {
          candidates = [{ id: args.threadId, title: null }];
        } else {
          const active = shell.threads
            .filter((t) => !t.archivedAt && hasActiveRun(t))
            .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
          ofThreads = active.length;
          candidates = active.slice(0, LIST_THREAD_CAP).map((t) => ({ id: t.id, title: t.title }));
        }

        const groups: Array<{ title: string; project: string; threadId: string; queue: QueuedMessage[] }> = [];
        const unreadable: Array<{ threadId: string; thread: string | null; error: string }> = [];
        for (const c of candidates) {
          let detail: V2ThreadDetailSnapshot;
          try {
            detail = await client.queuedMessages(c.id);
          } catch (e) {
            // One thread is asked for: its error is the answer. Across threads: keep going.
            if (args.threadId) throw e;
            unreadable.push({ threadId: c.id, thread: c.title, error: message(e) });
            continue;
          }
          const queue = queuedMessagesFromV2(detail);
          const t = detail.projection.thread;
          groups.push({ title: t.title ?? "(untitled)", project: projects.get(t.projectId) ?? t.projectId, threadId: t.id, queue });
        }

        // Threads whose queue waits longest first; send order inside a thread.
        const oldest = (q: QueuedMessage[]) => Math.min(...q.map((m) => Date.parse(m.queuedAt ?? "") || Infinity));
        groups.sort((a, b) => oldest(a.queue) - oldest(b.queue));
        const rows = groups.flatMap((g) =>
          g.queue.map((m) => {
            const { text, truncated } = shown(m.text);
            return {
              thread: g.title,
              project: g.project,
              position: m.position,
              age: relTime(m.queuedAt),
              queuedAt: m.queuedAt,
              sender: `${m.createdBy ?? "unknown"} via ${m.creationSource ?? "unknown"}`,
              text,
              ...(truncated ? { truncated: true } : {}),
              ...(m.automatic ? { automatic: true } : {}),
              threadId: g.threadId,
              runId: m.runId,
            };
          }),
        );
        const count = rows.length;
        const withQueue = groups.filter((g) => g.queue.length > 0);
        const first = rows[0];
        const spoken =
          count === 0
            ? args.threadId
              ? `No queued messages on ${groups[0]?.title ?? args.threadId}.`
              : "No queued messages."
            : args.threadId
              ? `${plural(count, "queued message")} on ${first.thread}; the next one was queued ${first.age ?? "at an unknown time"}.`
              : `${plural(count, "queued message")} on ${plural(withQueue.length, "thread")}; the oldest was queued ${first.age ?? "at an unknown time"} on ${first.thread}.`;
        const capped = !args.threadId && ofThreads > LIST_THREAD_CAP;
        const notes = [
          ...(capped
            ? [`Capped: checked ${LIST_THREAD_CAP} of ${ofThreads} threads with an active run (most recently updated first); pass threadId for the others.`]
            : []),
          UNTRUSTED_NOTE,
          "Cancel or edit only messages you sent; for another sender's message, tell that lane's lead.",
        ];
        return jsonResult({
          count,
          spoken,
          messages: rows.slice(0, limit),
          ...(count > limit ? { shown: limit } : {}),
          ...(args.threadId ? {} : { threadsChecked: candidates.length }),
          ...(capped ? { capped: true } : {}),
          ...(unreadable.length > 0 ? { unreadable } : {}),
          note: notes.join(" "),
        });
      } catch (e) {
        return errorResult(e);
      }
    },
  );

  server.registerTool(
    "cancel_queued_message",
    {
      title: "Cancel a queued message",
      description:
        "Remove one queued message before T3 sends it (like the X on a queued message in the T3 " +
        "UI). Get threadId and runId from list_queued_messages. Checks first that the run is still " +
        "queued; a run that already started cannot be cancelled here (use interrupt_thread). " +
        "Returns the removed text and how many messages remain queued. Cancel only messages you " +
        "sent; for another sender's message, tell that lane's lead. Every cancel is logged with your lane.",
      inputSchema: {
        threadId: z.string().min(1),
        runId: z.string().min(1).describe("The queued run, from list_queued_messages"),
        lane: z.string().min(1).describe("Your exact session title (written to the audit log)"),
      },
      annotations: { destructiveHint: true, idempotentHint: false },
    },
    async (args) => {
      try {
        const client = getClient();
        const before = await client.queuedMessages(args.threadId);
        const entry = queuedEntry(before, args.threadId, args.runId, "cancel");
        const title = before.projection.thread.title ?? "(untitled)";
        const base = { thread_id: args.threadId, run_id: args.runId, lane: args.lane, preview: clip(entry.text, LOG_CHARS).text };
        let sequence: number;
        try {
          sequence = (await client.dispatch(commands.queuedRunCancel(args.threadId, args.runId))).sequence;
        } catch (e) {
          const sent = !wasNotSent(e);
          log({ type: "queue_cancel_failed", ...base, sent, error: message(e).slice(0, 300) });
          if (!sent) {
            throw new Error(
              `Not sent: nothing reached T3, so the message is still queued (${message(e)}). ` +
                "Call cancel_queued_message again once T3 answers.",
            );
          }
          throw e;
        }
        log({ type: "queue_cancel", ...base, sequence });
        const removed = shown(entry.text);
        let after: { remaining?: number; runStatus?: string; warning?: string };
        try {
          const d = await client.queuedMessages(args.threadId);
          const status = (d.projection.runs ?? []).find((r) => r.id === args.runId)?.status;
          after = {
            remaining: queuedMessagesFromV2(d).length,
            runStatus: status,
            ...(status === "queued" ? { warning: "T3 accepted the cancel but still shows the run queued; check again with list_queued_messages." } : {}),
          };
        } catch (e) {
          after = { warning: `Cancelled, but the queue could not be read again (${message(e)}). Do not cancel again; check with list_queued_messages.` };
        }
        return jsonResult({
          cancelled: true,
          thread: title,
          position: entry.position,
          removed: removed.text,
          ...(removed.truncated ? { truncated: true } : {}),
          ...after,
          sequence,
          threadId: args.threadId,
          runId: args.runId,
          note: UNTRUSTED_NOTE,
        });
      } catch (e) {
        return errorResult(e);
      }
    },
  );

  server.registerTool(
    "edit_queued_message",
    {
      title: "Edit a queued message",
      description:
        "Replace the text of one queued message before T3 sends it (like the pencil on a queued " +
        "message in the T3 UI); attachments stay. Get threadId and runId from list_queued_messages. " +
        "Checks first that the run is still queued. An empty message is refused: use " +
        "cancel_queued_message to remove it. Returns the old and the new text as T3 now holds it. " +
        "Edit only messages you sent; for another sender's message, tell that lane's lead. Every " +
        "edit is logged with your lane.",
      inputSchema: {
        threadId: z.string().min(1),
        runId: z.string().min(1).describe("The queued run, from list_queued_messages"),
        message: z.string().max(EDIT_MAX_CHARS).describe("The new text (replaces the whole message)"),
        lane: z.string().min(1).describe("Your exact session title (written to the audit log)"),
      },
      annotations: { destructiveHint: true, idempotentHint: true },
    },
    async (args) => {
      try {
        if (args.message.trim().length === 0) {
          throw new Error("An empty message is refused. To remove the queued message, use cancel_queued_message.");
        }
        const client = getClient();
        const before = await client.queuedMessages(args.threadId);
        const entry = queuedEntry(before, args.threadId, args.runId, "edit");
        const title = before.projection.thread.title ?? "(untitled)";
        const base = {
          thread_id: args.threadId,
          run_id: args.runId,
          lane: args.lane,
          preview: clip(entry.text, LOG_CHARS).text,
          new_preview: clip(args.message, LOG_CHARS).text,
        };
        let sequence: number;
        try {
          sequence = (await client.dispatch(commands.queuedRunEdit(args.threadId, args.runId, args.message))).sequence;
        } catch (e) {
          const sent = !wasNotSent(e);
          log({ type: "queue_edit_failed", ...base, sent, error: message(e).slice(0, 300) });
          if (!sent) {
            throw new Error(
              `Not sent: nothing reached T3, so the queued message is unchanged (${message(e)}). ` +
                "Call edit_queued_message again once T3 answers.",
            );
          }
          throw e;
        }
        log({ type: "queue_edit", ...base, sequence });
        let now = args.message;
        let warning: string | undefined;
        try {
          const d = await client.queuedMessages(args.threadId);
          const m = queuedMessagesFromV2(d).find((x) => x.runId === args.runId);
          if (!m) warning = "Edited, but the run is no longer queued: it may have started already.";
          else if (m.text !== args.message) {
            now = m.text;
            warning = "T3 accepted the edit but shows different text; check with list_queued_messages.";
          }
        } catch (e) {
          warning = `Edited, but the queue could not be read again (${message(e)}). Check with list_queued_messages.`;
        }
        const oldText = shown(entry.text);
        const newText = shown(now);
        return jsonResult({
          edited: true,
          thread: title,
          position: entry.position,
          old: oldText.text,
          new: newText.text,
          ...(oldText.truncated || newText.truncated ? { truncated: true } : {}),
          ...(warning ? { warning } : {}),
          sequence,
          threadId: args.threadId,
          runId: args.runId,
          note: UNTRUSTED_NOTE,
        });
      } catch (e) {
        return errorResult(e);
      }
    },
  );
}
