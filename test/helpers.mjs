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

/** Fake T3 client: one project, a mutable list of running thread ids, recorded dispatches. */
export function fakeClient(opts = {}) {
  const state = {
    running: opts.running ?? [],
    dispatched: [],
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
  };
  let seq = 0;
  const client = {
    state,
    async shell() {
      return {
        snapshotSequence: seq,
        updatedAt: new Date().toISOString(),
        projects: [state.project],
        threads: state.running.map((id) => ({
          id,
          projectId: "p1",
          title: id,
          createdAt: new Date(T0).toISOString(),
          updatedAt: new Date(T0).toISOString(),
          session: { threadId: id, status: "running" },
        })),
      };
    },
    async dispatch(cmd) {
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
