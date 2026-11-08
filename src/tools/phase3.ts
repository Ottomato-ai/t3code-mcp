import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { T3Client } from "../client.js";
import { attentionOf, pendingRequests } from "../model.js";
import type { Attention, ThreadShell } from "../model.js";
import { errorResult, jsonResult, relTime, stripForVoice, threadRow, truncate } from "../format.js";
import { ms, paginate, queryHash } from "../paging.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function speakAttention(a: Attention): string {
  switch (a) {
    case "needs-approval":
      return "waiting for your approval";
    case "needs-input":
      return "waiting for an answer from you";
    case "plan-ready":
      return "ready with a plan for you to review";
    case "working":
      return "still working";
    case "error":
      return "hit an error";
    case "done":
      return "finished";
    case "idle":
      return "idle";
  }
}

export function registerPhase3(server: McpServer, getClient: () => T3Client) {
  server.registerTool(
    "thread_digest",
    {
      title: "Speakable thread digest",
      description:
        "A TTS-friendly plain-language digest of one thread: what it's doing, what the agent " +
        "last said (markdown/code stripped), and anything it's waiting on. Designed to be read " +
        "aloud by a voice assistant.",
      inputSchema: {
        threadId: z.string(),
        maxReplyChars: z.number().int().min(100).max(4000).optional().describe("Default 800"),
      },
    },
    async (args) => {
      try {
        const snap = await getClient().thread(args.threadId, { turnLimit: 8, window: "bounded" });
        const t = snap.thread;
        const attention = attentionOf(t);
        const pending = pendingRequests(t.activities ?? []);
        const messages = t.messages ?? [];
        const lastUser = [...messages].reverse().find((m) => m.role === "user");
        const lastAssistant = [...messages].reverse().find((m) => m.role === "assistant");
        const toolCount = (t.activities ?? []).filter((a) => a.kind.startsWith("tool.")).length;

        const parts: string[] = [];
        parts.push(`Thread "${t.title ?? "untitled"}" is ${speakAttention(attention)}.`);
        if (lastUser) {
          parts.push(
            `Your last message, ${relTime(lastUser.createdAt) ?? "earlier"}: ${
              truncate(stripForVoice(lastUser.text), 200).text
            }`,
          );
        }
        if (toolCount > 0) parts.push(`The agent has run ${toolCount} tool actions recently.`);
        if (lastAssistant) {
          parts.push(
            `Latest reply, ${relTime(lastAssistant.createdAt) ?? "earlier"}: ${
              truncate(stripForVoice(lastAssistant.text), args.maxReplyChars ?? 800).text
            }`,
          );
        }
        for (const p of pending) {
          parts.push(
            p.kind === "approval"
              ? `It is asking permission for a ${p.requestKind ?? "action"}: ${
                  truncate(stripForVoice(String(p.summary ?? JSON.stringify(p.detail))), 200).text
                }`
              : `It has a question for you: ${
                  truncate(stripForVoice(String(p.summary ?? JSON.stringify(p.detail))), 300).text
                }`,
          );
        }
        if (t.session?.lastError) {
          parts.push(`Session error: ${truncate(String(t.session.lastError), 200).text}`);
        }
        return jsonResult({
          spoken: parts.join(" "),
          attention,
          pendingRequests: pending,
          threadId: t.id,
        });
      } catch (e) {
        return errorResult(e);
      }
    },
  );

  server.registerTool(
    "workspace_digest",
    {
      title: "Speakable workspace briefing",
      description:
        "One-line-per-thread briefing across all projects — the 'what are my agents doing' " +
        "answer. Covers threads needing attention first, then working, then recently finished. " +
        "TTS-friendly 'spoken' field plus structured rows.",
      inputSchema: {
        sinceHours: z
          .number()
          .min(1)
          .max(168)
          .optional()
          .describe("Include finished/idle threads updated within this window (default 24h)"),
      },
    },
    async (args) => {
      try {
        const shell = await getClient().shell();
        const projectsById = new Map(shell.projects.map((p) => [p.id, p]));
        const cutoff = Date.now() - (args.sinceHours ?? 24) * 3600_000;
        const order: Attention[] = [
          "needs-approval",
          "needs-input",
          "plan-ready",
          "error",
          "working",
          "done",
          "idle",
        ];
        const interesting = shell.threads
          .filter((t) => !t.archivedAt)
          .filter((t) => {
            const a = attentionOf(t);
            if (a === "done" || a === "idle") return Date.parse(t.updatedAt) >= cutoff;
            return true;
          })
          .sort(
            (a, b) =>
              order.indexOf(attentionOf(a)) - order.indexOf(attentionOf(b)) ||
              Date.parse(b.updatedAt) - Date.parse(a.updatedAt),
          )
          .slice(0, 20);
        const lines = interesting.map((t: ThreadShell) => {
          const project = projectsById.get(t.projectId)?.title ?? "unknown project";
          return `"${t.title ?? "untitled"}" in ${project} is ${speakAttention(attentionOf(t))}` +
            ` (updated ${relTime(t.updatedAt) ?? "recently"}).`;
        });
        const needing = interesting.filter((t) =>
          ["needs-approval", "needs-input", "plan-ready", "error"].includes(attentionOf(t)),
        ).length;
        const working = interesting.filter((t) => attentionOf(t) === "working").length;
        const spoken =
          (interesting.length === 0
            ? "All quiet — no active agent threads right now."
            : `You have ${working} thread${working === 1 ? "" : "s"} working and ${needing} ` +
              `waiting on you. ${lines.join(" ")}`) ;
        return jsonResult({
          spoken,
          threads: interesting.map((t) => threadRow(t, projectsById)),
        });
      } catch (e) {
        return errorResult(e);
      }
    },
  );

  server.registerTool(
    "search_threads",
    {
      title: "Search threads",
      description:
        "Find threads by words from the title, project name, or branch (case-insensitive " +
        "substring match on each word). Searches active and archived threads. Paged: when " +
        "hasMore is true, call again with cursor=nextCursor and the same query; total is the " +
        "number of matching threads.",
      inputSchema: {
        query: z.string().min(1),
        limit: z.number().int().min(1).max(50).optional().describe("Rows per page (default 10)"),
        cursor: z.string().optional().describe("nextCursor from the previous page (same query)"),
      },
    },
    async (args) => {
      try {
        const shell = await getClient().shell({ includeArchived: true });
        const projectsById = new Map(shell.projects.map((p) => [p.id, p]));
        const words = args.query.toLowerCase().split(/\s+/).filter(Boolean);
        const matching = shell.threads
          .map((t) => {
            const hay = [
              t.title ?? "",
              projectsById.get(t.projectId)?.title ?? "",
              t.branch ?? "",
            ]
              .join(" ")
              .toLowerCase();
            const hits = words.filter((w) => hay.includes(w)).length;
            return { t, hits };
          })
          .filter((m) => m.hits === words.length || (words.length > 2 && m.hits >= words.length - 1));
        const page = paginate(
          matching.map((m) => ({ row: m.t, rank: [m.hits, ms(m.t.updatedAt)], id: m.t.id, updatedMs: ms(m.t.updatedAt) })),
          {
            limit: args.limit ?? 10,
            cursor: args.cursor,
            query: queryHash({ tool: "search_threads", words }),
            snapshotSequence: shell.snapshotSequence,
            allUpdated: shell.threads.map((t) => ({ id: t.id, updatedMs: ms(t.updatedAt) })),
          },
        );
        return jsonResult({
          matches: page.rows.length,
          total: page.total,
          returnedSoFar: page.returnedSoFar,
          hasMore: page.hasMore,
          nextCursor: page.nextCursor,
          snapshotSequence: page.snapshotSequence,
          ...(args.cursor
            ? {
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
    "wait_for_change",
    {
      title: "Wait for anything to change",
      description:
        "Long-poll the workspace until any thread changes attention state (a turn finishes, an " +
        "approval appears, an error occurs) or the timeout passes. Returns the changed threads " +
        "with old and new state. Lets a voice loop stay silent until something actually happens.",
      inputSchema: {
        timeoutSeconds: z.number().int().min(5).max(300).optional().describe("Default 60"),
      },
    },
    async (args) => {
      try {
        const client = getClient();
        const baseline = await client.shell();
        const projectsById = new Map(baseline.projects.map((p) => [p.id, p]));
        const before = new Map(
          baseline.threads.filter((t) => !t.archivedAt).map((t) => [t.id, attentionOf(t)]),
        );
        const deadline = Date.now() + (args.timeoutSeconds ?? 60) * 1000;
        for (;;) {
          await sleep(2500);
          const shell = await client.shell();
          const changes = [];
          for (const t of shell.threads) {
            if (t.archivedAt) continue;
            const prev = before.get(t.id);
            const now = attentionOf(t);
            if (prev === undefined) {
              changes.push({ ...threadRow(t, projectsById), change: `new thread (${now})` });
            } else if (prev !== now) {
              changes.push({ ...threadRow(t, projectsById), change: `${prev} → ${now}` });
            }
          }
          if (changes.length > 0) return jsonResult({ changed: changes.length, changes });
          if (Date.now() > deadline) {
            return jsonResult({ changed: 0, note: "No changes before timeout." });
          }
        }
      } catch (e) {
        return errorResult(e);
      }
    },
  );
}
