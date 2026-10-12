// Running count for the launch cap: read from T3 at decision time (same shell data as list_threads).
import type { ShellSnapshot } from "../model.js";

/** Session states that hold a live provider process. */
export const LIVE_SESSION_STATES = ["running", "ready", "starting"];

export function runningThreadIds(shell: Pick<ShellSnapshot, "threads">): string[] {
  return shell.threads
    .filter((t) => !t.archivedAt && LIVE_SESSION_STATES.includes(t.session?.status ?? ""))
    .map((t) => t.id);
}
