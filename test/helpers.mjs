// Shared test helpers. Tests run against dist (build first: `pnpm build`).
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const T0 = Date.parse("2026-10-12T00:00:00Z");
export const MIN = 60_000;
export const HOUR = 60 * MIN;

export function tempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), "launch-desk-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** icacls output for an owner-only folder (current user and SYSTEM, nothing inherited). */
export function ownerOnlyAcl(dir, user = "TESTDOMAIN\\tester") {
  return `${dir} NT AUTHORITY\\SYSTEM:(OI)(CI)(F)\n${" ".repeat(dir.length)} ${user}:(OI)(CI)(F)\n\nSuccessfully processed 1 files; Failed processing 0 files\n`;
}

/** icacls output for a folder that still inherits access. */
export function inheritedAcl(dir, user = "TESTDOMAIN\\tester") {
  return `${dir} BUILTIN\\Administrators:(I)(OI)(CI)(F)\n${" ".repeat(dir.length)} ${user}:(I)(OI)(CI)(F)\n\nSuccessfully processed 1 files; Failed processing 0 files\n`;
}

/**
 * Fake T3 client: projects p1 and p2, a mutable list of running thread ids (every other
 * thread is stopped), recorded dispatches, optional dispatch delay.
 */
export function fakeClient(opts = {}) {
  const state = {
    running: opts.running ?? [],
    /** Session status per thread id for thread(); default running if in running, else stopped. */
    statuses: opts.statuses ?? {},
    dispatched: [],
    shellCalls: 0,
    /** Options passed to each shell() call. */
    shellOpts: [],
    /** Active run id per thread id (thread() detail), for interrupt_thread. */
    activeRunIds: opts.activeRunIds ?? {},
    /** Provider session ids per thread id (thread() detail), for stop_thread. */
    sessionIds: opts.sessionIds ?? {},
    dispatchDelayMs: opts.dispatchDelayMs ?? 0,
    project: {
      id: "p1",
      title: "Scratch",
      workspaceRoot: "C:/scratch",
      defaultModelSelection: opts.defaultModelSelection ?? {
        instanceId: "claude",
        model: "claude-opus-5-5",
        options: [{ id: "fastMode", value: false }],
      },
    },
    project2: {
      id: "p2",
      title: "Other",
      workspaceRoot: "C:/other",
      defaultModelSelection: { instanceId: "claude", model: "m", options: [] },
    },
  };
  let seq = 0;
  const threadShell = (id, status) => ({
    id,
    projectId: "p1",
    title: `thread ${id}`,
    runtimeMode: "full-access",
    interactionMode: "default",
    createdAt: new Date(T0).toISOString(),
    updatedAt: new Date(T0).toISOString(),
    session: { threadId: id, status },
  });
  const client = {
    state,
    async shell(shellOpts) {
      state.shellCalls++;
      state.shellOpts.push(shellOpts ?? {});
      return {
        snapshotSequence: seq,
        updatedAt: new Date().toISOString(),
        projects: [state.project, state.project2],
        threads: state.running.map((id) => threadShell(id, "running")),
      };
    },
    async thread(id) {
      const t = threadShell(id, state.statuses[id] ?? (state.running.includes(id) ? "running" : "stopped"));
      return {
        snapshotSequence: seq,
        thread: {
          ...t,
          activeRunId: state.activeRunIds[id] ?? null,
          providerSessionIds: state.sessionIds[id] ?? [],
          messages: [],
          activities: [],
        },
      };
    },
    async dispatch(cmd) {
      if (state.dispatchDelayMs) await new Promise((r) => setTimeout(r, state.dispatchDelayMs));
      state.dispatched.push(cmd);
      return { sequence: ++seq };
    },
  };
  return client;
}

/** Parse a tool result's first text item as JSON (errors come back as plain text). */
export function parse(result) {
  const text = result.content[0].text;
  if (result.isError) return { isError: true, text };
  return JSON.parse(text);
}
