import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { T3Client } from "../client.js";
import { errorResult, jsonResult, relTime } from "../format.js";
import type { Admission, LaunchDesk } from "../desk/desk.js";
import { runningThreadIds } from "../desk/running.js";
import type { DeskEntry } from "../desk/store.js";
import { UNTRUSTED_NOTE, untrusted } from "../desk/untrusted.js";

export { UNTRUSTED_NOTE, untrusted };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function grantedNote(e: DeskEntry): string {
  const call =
    e.kind === "resume"
      ? `send_message to thread ${e.target_thread_id} with queue_entry=${e.id}, the same lane and the same message`
      : `create_thread with queue_entry=${e.id}, the same lane, the same project and the same arguments`;
  return (
    `Granted. Call ${call} now, before ${e.grant_expires_at}; after that the grant expires and ` +
    `the next lane gets the slot.`
  );
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * Record a launch that T3 accepted. A desk failure here must not turn the launch into an
 * error (the caller would retry and start a second thread): it becomes a warning.
 */
export function recordLaunch(desk: LaunchDesk, id: string, claim: string, threadId: string): string | undefined {
  try {
    desk.markLaunched(id, claim, threadId);
    return undefined;
  } catch (e) {
    console.error(`launch-desk: launched thread ${threadId} but could not record entry ${id}: ${message(e)}`);
    desk.store.logEvent({ type: "launch_warning", id, thread_id: threadId });
    return (
      `Launched, but the launch desk could not record it (${message(e)}). Do not retry: the thread ` +
      `is running. The entry stays launching and is failed after 5 minutes.`
    );
  }
}

/**
 * A claimed launch failed. When nothing reached T3 (connection refused) the grant is kept and
 * the error says how to retry; otherwise the entry is failed. Returns the error to throw.
 */
export function failLaunch(
  desk: LaunchDesk,
  id: string,
  claim: string,
  err: unknown,
  out: { sent: boolean; threadId: string; tool: "create_thread" | "send_message" },
): Error {
  try {
    desk.launchFailed(id, claim, { createSent: out.sent, threadId: out.threadId });
  } catch (e) {
    console.error(`launch-desk: could not release entry ${id}: ${message(e)}`);
  }
  if (out.sent) return err instanceof Error ? err : new Error(message(err));
  return new Error(
    `${message(err)} Nothing reached T3, so the grant is kept: call ${out.tool} again with ` +
      `queue_entry=${id} and the same lane before the grant expires.`,
  );
}

/** The answer for a launch that has to wait: no launch, the entry id and how to continue. */
export function queuedResult(admission: Extract<Admission, { kind: "queued" }>, tool: "create_thread" | "send_message") {
  return jsonResult({
    queued: true,
    queue_entry: admission.entry.id,
    position: admission.position,
    running: admission.running,
    cap: admission.cap,
    memory: { status: admission.memory.status, commitPercent: admission.memory.commitPercent },
    note:
      "Not launched: the launch cap is reached, host memory is high, or lanes wait ahead. " +
      "Do not retry in a loop. Call launch_wait with this queue_entry (or check back on your " +
      `watcher), then call ${tool} again with the same lane and queue_entry once granted.`,
  });
}

export function registerLaunchDesk(server: McpServer, getClient: () => T3Client, getDesk: () => LaunchDesk) {
  server.registerTool(
    "launch_wait",
    {
      title: "Wait for a launch slot",
      description:
        "Block until a queued create_thread or send_message entry is granted a launch slot, " +
        "expires, or the timeout passes (default 120 s, max 300 s). Returns the state and queue " +
        "position. When granted, repeat the call with queue_entry. On timeout, call launch_wait " +
        "again or check back later; do not loop create_thread.",
      inputSchema: {
        queue_entry: z.string().describe("Entry id from a queued answer"),
        timeout_seconds: z.number().int().min(1).max(300).optional(),
      },
    },
    async (args) => {
      try {
        const desk = getDesk();
        const deadline = Date.now() + (args.timeout_seconds ?? 120) * 1000;
        for (;;) {
          // desk.json on every poll; the T3 shell at most once per 30 s in this process.
          await desk.maybeTick(getClient());
          const { entry, position } = desk.status(args.queue_entry);
          if (entry.state !== "waiting") {
            return jsonResult({
              outcome: entry.state,
              state: entry.state,
              queue_entry: entry.id,
              grant_expires_at: entry.grant_expires_at,
              ...(entry.thread_id ? { threadId: entry.thread_id } : {}),
              note:
                entry.state === "granted"
                  ? grantedNote(entry)
                  : `Entry is ${entry.state}. Call again without queue_entry to queue a new launch if still needed.`,
            });
          }
          if (Date.now() >= deadline) {
            return jsonResult({
              outcome: "timeout",
              state: entry.state,
              queue_entry: entry.id,
              position,
              note: "Still queued. Call launch_wait again or check back on your watcher.",
            });
          }
          await sleep(desk.pollMs);
        }
      } catch (e) {
        return errorResult(e);
      }
    },
  );

  server.registerTool(
    "launch_queue",
    {
      title: "Launch queue",
      description:
        "Read-only view of the T3 launch desk: running thread count, cap, free slots, host " +
        "memory, live grants and the waiting list (lane, project, position, age). Lane, project " +
        "and task text is wrapped as untrusted data.",
      inputSchema: {},
    },
    async () => {
      try {
        const desk = getDesk();
        const shell = await getClient().shell();
        const v = desk.view(runningThreadIds(shell));
        const row = (e: DeskEntry) => ({
          queue_entry: e.id,
          lane: untrusted(e.lane),
          project: untrusted(e.project),
          task: untrusted(e.task),
          kind: e.kind,
          priority: e.priority,
          age: relTime(e.created_at, v.nowMs),
        });
        return jsonResult({
          running: v.running,
          cap: v.cap,
          free: v.free,
          memory: { status: v.memory.status, commitPercent: v.memory.commitPercent, blocks: v.memory.blocks },
          grants: v.grants.map((e) => ({ ...row(e), state: e.state, grant_expires_at: e.grant_expires_at })),
          waiting: v.waiting.map(({ entry, position }) => ({ position, ...row(entry) })),
          note: UNTRUSTED_NOTE,
        });
      } catch (e) {
        return errorResult(e);
      }
    },
  );

  server.registerTool(
    "launch_cancel",
    {
      title: "Cancel a launch request",
      description: "Cancel your own waiting or granted launch queue entry (lane must match the entry's lane).",
      inputSchema: {
        queue_entry: z.string(),
        lane: z.string().min(1).describe("Your exact session title, as given when queuing"),
      },
    },
    async (args) => {
      try {
        const e = getDesk().cancel(args.queue_entry, args.lane);
        return jsonResult({ cancelled: true, queue_entry: e.id });
      } catch (e) {
        return errorResult(e);
      }
    },
  );

  server.registerTool(
    "launch_queue_move",
    {
      title: "Reorder the launch queue",
      description:
        "Move a waiting entry to just before another waiting entry. Only the OttoContext lead's lane " +
        "may do this; every move is logged.",
      inputSchema: {
        queue_entry: z.string(),
        before: z.string().describe("Entry id to place it before"),
        lane: z.string().min(1).describe("Your exact session title"),
      },
    },
    async (args) => {
      try {
        const { entry, position } = getDesk().move(args.queue_entry, args.before, args.lane);
        return jsonResult({ moved: true, queue_entry: entry.id, position, priority: entry.priority });
      } catch (e) {
        return errorResult(e);
      }
    },
  );
}
