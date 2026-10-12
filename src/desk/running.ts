// Running count for the launch cap: read from T3 at decision time (same shell data as list_threads).
import type { ShellSnapshot } from "../model.js";

/**
 * Session states that hold a live provider process. Checked against T3 server 0.0.45
 * (resources/server.asar, provider runtime ingestion): "interrupted" is set only on
 * turn.aborted and the provider session stays up (session.exited sets "stopped"). "idle" is
 * in the schema, but no code path writes it. "error" is set on a failed turn (process alive)
 * and on a failed turn start (maybe no process), so it is not counted; a send to such a
 * thread is gated.
 */
export const LIVE_SESSION_STATES = ["running", "ready", "starting", "interrupted"];

export function runningThreadIds(shell: Pick<ShellSnapshot, "threads">): string[] {
  return shell.threads
    .filter((t) => !t.archivedAt && LIVE_SESSION_STATES.includes(t.session?.status ?? ""))
    .map((t) => t.id);
}
