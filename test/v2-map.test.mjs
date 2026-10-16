// Orchestration protocol 2: V2 shell and thread detail mapped to the shapes the tools use.
import { test } from "node:test";
import assert from "node:assert/strict";
import { shellFromV2, detailFromV2, isV2Shell, isV2Detail, turnStateOf, IDLE_RELEASE_MS } from "../dist/v2.js";
import { attentionOf, pendingRequests } from "../dist/model.js";
import { runningThreadIds } from "../dist/desk/running.js";
import {
  NOW, MIN, iso, v2Thread, v2Shell, v2Run, v2Message, v2Session, v2Item, v2Request, v2Detail,
} from "./v2-fixtures.mjs";

const one = (over) => shellFromV2(v2Shell([v2Thread(over)]), { now: NOW }).threads[0];

// ---------- detection ----------

test("detects V2 shell and detail payloads, not legacy ones", () => {
  assert.equal(isV2Shell(v2Shell([])), true);
  assert.equal(isV2Shell({ snapshotSequence: 1, projects: [], threads: [], updatedAt: iso(0) }), false);
  assert.equal(isV2Detail(v2Detail()), true);
  assert.equal(isV2Detail({ snapshotSequence: 1, thread: { id: "x" } }), false);
});

// ---------- run status ----------

test("run status maps to the legacy turn state", () => {
  for (const s of ["preparing", "queued", "starting", "running", "waiting"]) assert.equal(turnStateOf(s), "running", s);
  assert.equal(turnStateOf("completed"), "completed");
  for (const s of ["interrupted", "cancelled", "rolled_back"]) assert.equal(turnStateOf(s), "interrupted", s);
  assert.equal(turnStateOf("failed"), "error");
});

// ---------- shell ----------

test("shell keeps projects, sequence and base thread fields", () => {
  const shell = shellFromV2(v2Shell([v2Thread({ title: "a", branch: "b1", worktreePath: "C:/w" })]), { now: NOW });
  assert.equal(shell.snapshotSequence, 42);
  assert.equal(shell.projects[0].id, "p1");
  const t = shell.threads[0];
  assert.equal(t.id, "t-1");
  assert.equal(t.projectId, "p1");
  assert.equal(t.title, "a");
  assert.equal(t.branch, "b1");
  assert.equal(t.worktreePath, "C:/w");
  assert.deepEqual(t.modelSelection, { instanceId: "codex", model: "model-a" });
  assert.equal(t.archivedAt, null);
  assert.equal(typeof shell.updatedAt, "string");
});

test("a thread that never ran is idle with no session and no latest turn", () => {
  const t = one({});
  assert.equal(t.latestTurn, null);
  assert.equal(t.session, null);
  assert.equal(attentionOf(t), "idle");
});

test("an active run is working, with a running session", () => {
  const t = one({ status: "running", activeRunId: "run-2", activityRunStatus: "running", latestRunId: "run-2", latestRunRequestedAt: iso(2 * MIN), latestRunStartedAt: iso(2 * MIN) });
  assert.equal(t.latestTurn.state, "running");
  assert.equal(t.latestTurn.turnId, "run-2");
  assert.equal(t.session.status, "running");
  assert.equal(t.session.activeTurnId, "run-2");
  assert.equal(attentionOf(t), "working");
});

test("a preparing or starting run gives a starting session", () => {
  for (const s of ["preparing", "starting", "queued"]) {
    const t = one({ status: s, activeRunId: "run-2", activityRunStatus: s === "queued" ? null : s, latestRunId: "run-2" });
    assert.equal(t.session.status, "starting", s);
  }
});

test("pending approval and pending user input set the attention flags", () => {
  const ap = one({ status: "waiting", activeRunId: "r", latestRunId: "r", pendingRuntimeRequest: { id: "rr", kind: "command", createdAt: iso(MIN) } });
  assert.equal(ap.hasPendingApprovals, true);
  assert.equal(ap.hasPendingUserInput, false);
  assert.equal(attentionOf(ap), "needs-approval");
  const ui = one({ status: "waiting", activeRunId: "r", latestRunId: "r", pendingRuntimeRequest: { id: "rr", kind: "user_input", createdAt: iso(MIN) } });
  assert.equal(ui.hasPendingUserInput, true);
  assert.equal(ui.hasPendingApprovals, false);
  assert.equal(attentionOf(ui), "needs-input");
});

test("a failed latest run is an error with the server's lastError", () => {
  const t = one({ status: "failed", latestRunId: "r", latestRunCompletedAt: iso(5 * MIN), lastError: "provider crashed" });
  assert.equal(t.latestTurn.state, "error");
  assert.equal(t.session.status, "error");
  assert.equal(t.session.lastError, "provider crashed");
  assert.equal(attentionOf(t), "error");
});

test("an actionable plan is plan-ready", () => {
  const t = one({ status: "completed", latestRunId: "r", latestRunCompletedAt: iso(5 * MIN), hasActionableProposedPlan: true });
  assert.equal(attentionOf(t), "plan-ready");
});

test("a run that ended inside the idle-release window holds a ready session; older is stopped", () => {
  const recent = one({ status: "completed", latestRunId: "r", latestRunCompletedAt: iso(IDLE_RELEASE_MS - MIN) });
  assert.equal(recent.session.status, "ready");
  assert.equal(attentionOf(recent), "done");
  const old = one({ status: "completed", latestRunId: "r", latestRunCompletedAt: iso(IDLE_RELEASE_MS + MIN) });
  assert.equal(old.session.status, "stopped");
  assert.equal(attentionOf(old), "done");
  const interrupted = one({ status: "interrupted", latestRunId: "r", latestRunCompletedAt: iso(MIN) });
  assert.equal(interrupted.latestTurn.state, "interrupted");
  assert.equal(interrupted.session.status, "ready");
});

test("the launch desk counts active, waiting and recently idle threads, not old or failed ones", () => {
  const shell = shellFromV2(v2Shell([
    v2Thread({ id: "run", status: "running", activeRunId: "r1", latestRunId: "r1" }),
    v2Thread({ id: "wait", status: "waiting", activeRunId: "r2", latestRunId: "r2", pendingRuntimeRequest: { id: "x", kind: "command", createdAt: iso(MIN) } }),
    v2Thread({ id: "recent", status: "completed", latestRunId: "r3", latestRunCompletedAt: iso(5 * MIN) }),
    v2Thread({ id: "old", status: "completed", latestRunId: "r4", latestRunCompletedAt: iso(IDLE_RELEASE_MS * 2) }),
    v2Thread({ id: "failed", status: "failed", latestRunId: "r5", latestRunCompletedAt: iso(MIN) }),
    v2Thread({ id: "never" }),
  ]), { now: NOW });
  assert.deepEqual(runningThreadIds(shell).sort(), ["recent", "run", "wait"]);
});

test("archived threads from the shell and from the archived snapshot are merged, archived first excluded by default", () => {
  const shell = shellFromV2(
    v2Shell([v2Thread({ id: "a" })], [v2Thread({ id: "b", archivedAt: iso(MIN) })]),
    { now: NOW, archived: [v2Thread({ id: "c", archivedAt: iso(MIN) }), v2Thread({ id: "b", archivedAt: iso(MIN) })] },
  );
  assert.deepEqual(shell.threads.map((t) => t.id), ["a", "b", "c"]);
  assert.ok(shell.threads.filter((t) => t.id !== "a").every((t) => t.archivedAt));
});

test("deleted threads are dropped", () => {
  const shell = shellFromV2(v2Shell([v2Thread({ id: "a" }), v2Thread({ id: "d", deletedAt: iso(MIN) })]), { now: NOW });
  assert.deepEqual(shell.threads.map((t) => t.id), ["a"]);
});

test("unknown run status degrades to idle instead of throwing", () => {
  const t = one({ status: "some_future_status", latestRunId: "r" });
  assert.equal(attentionOf(t), "idle");
});

// ---------- thread detail ----------

const turnMessages = () => [
  v2Message({ id: "u1", role: "user", text: "q1", runId: "run-1", createdAt: iso(50 * MIN) }),
  v2Message({ id: "a1", role: "assistant", text: "r1", runId: "run-1", createdAt: iso(49 * MIN) }),
  v2Message({ id: "u2", role: "user", text: "q2", runId: "run-2", createdAt: iso(40 * MIN) }),
  v2Message({ id: "a2", role: "assistant", text: "r2", runId: "run-2", createdAt: iso(39 * MIN) }),
  v2Message({ id: "u3", role: "user", text: "q3", runId: "run-3", createdAt: iso(30 * MIN) }),
  v2Message({ id: "a3", role: "assistant", text: "r3", runId: "run-3", streaming: true, createdAt: iso(29 * MIN) }),
];

test("detail maps thread fields, messages and snapshot sequence", () => {
  const snap = detailFromV2(v2Detail({ thread: { title: "x" }, messages: turnMessages() }), {});
  assert.equal(snap.snapshotSequence, 7);
  assert.equal(snap.thread.id, "t-1");
  assert.equal(snap.thread.title, "x");
  assert.equal(snap.thread.messages.length, 6);
  const m = snap.thread.messages[5];
  assert.equal(m.role, "assistant");
  assert.equal(m.text, "r3");
  assert.equal(m.streaming, true);
  assert.equal(m.turnId, "run-3");
});

test("turnLimit keeps the last N turns and the cursor pages back", () => {
  const raw = v2Detail({ messages: turnMessages() });
  const last = detailFromV2(raw, { turnLimit: 1 });
  assert.deepEqual(last.thread.messages.map((m) => m.id), ["u3", "a3"]);
  assert.equal(last.page.hasMore, true);
  assert.equal(typeof last.page.beforeCursor, "string");
  const prev = detailFromV2(raw, { turnLimit: 1, beforeCursor: last.page.beforeCursor });
  assert.deepEqual(prev.thread.messages.map((m) => m.id), ["u2", "a2"]);
  const first = detailFromV2(raw, { turnLimit: 5, beforeCursor: prev.page.beforeCursor });
  assert.deepEqual(first.thread.messages.map((m) => m.id), ["u1", "a1"]);
  assert.equal(first.page.hasMore, false);
  assert.equal(first.page.beforeCursor, null);
});

test("an unknown cursor is an error, not a silent full page", () => {
  assert.throws(() => detailFromV2(v2Detail({ messages: turnMessages() }), { beforeCursor: "m:nope" }), /cursor/i);
});

test("latest turn comes from the last run; session from provider sessions", () => {
  const snap = detailFromV2(v2Detail({
    thread: { status: "running", activeRunId: "run-2" },
    runs: [v2Run({ id: "run-1" }), v2Run({ id: "run-2", ordinal: 2, status: "running", completedAt: null })],
    providerSessions: [v2Session({ id: "ps-1", status: "waiting" })],
  }), {});
  assert.equal(snap.thread.latestTurn.turnId, "run-2");
  assert.equal(snap.thread.latestTurn.state, "running");
  assert.equal(snap.thread.session.status, "running");
  assert.equal(snap.thread.session.activeTurnId, "run-2");
  assert.equal(snap.thread.activeRunId, "run-2");
  assert.deepEqual(snap.thread.providerSessionIds, ["ps-1"]);
  assert.equal(attentionOf(snap.thread), "working");
});

test("a ready provider session after a completed run is live and done", () => {
  const snap = detailFromV2(v2Detail({ runs: [v2Run()], providerSessions: [v2Session({ status: "ready" })] }), {});
  assert.equal(snap.thread.session.status, "ready");
  assert.equal(snap.thread.activeRunId, null);
  assert.equal(attentionOf(snap.thread), "done");
});

test("no provider session left after runs means stopped; never ran means no session", () => {
  assert.equal(detailFromV2(v2Detail({ runs: [v2Run()] }), {}).thread.session.status, "stopped");
  assert.equal(detailFromV2(v2Detail({}), {}).thread.session, null);
});

test("a session error is reported as the session lastError", () => {
  const snap = detailFromV2(v2Detail({ runs: [v2Run({ status: "failed" })], providerSessions: [v2Session({ status: "error", lastError: "boom" })] }), {});
  assert.equal(snap.thread.session.status, "error");
  assert.equal(snap.thread.session.lastError, "boom");
  assert.equal(attentionOf(snap.thread), "error");
});

test("pending approval and user input requests come back with ids, kinds and detail", () => {
  const snap = detailFromV2(v2Detail({
    thread: { status: "waiting", activeRunId: "run-1", pendingRuntimeRequest: { id: "rr-1", kind: "command", createdAt: iso(5 * MIN) } },
    runs: [v2Run({ status: "waiting", completedAt: null })],
    runtimeRequests: [
      v2Request({ id: "rr-1", kind: "command" }),
      v2Request({ id: "rr-2", kind: "user_input" }),
      v2Request({ id: "rr-3", kind: "file-change", status: "resolved", resolvedAt: iso(MIN), decision: "accept" }),
    ],
    turnItems: [
      v2Item({ id: "i1", type: "approval_request", requestId: "rr-1", requestKind: "command", prompt: "run the tests", title: "Run command", status: "waiting" }),
      v2Item({ id: "i2", type: "user_input_request", requestId: "rr-2", questions: [{ id: "q1", header: "H", question: "Which?", options: [] }], status: "waiting" }),
      v2Item({ id: "i3", type: "approval_request", requestId: "rr-3", requestKind: "file-change", status: "completed" }),
    ],
  }), {});
  const pending = pendingRequests(snap.thread.activities);
  assert.deepEqual(pending.map((p) => [p.requestId, p.kind]), [["rr-1", "approval"], ["rr-2", "user-input"]]);
  assert.equal(pending[0].requestKind, "command");
  assert.equal(pending[0].summary, "Run command");
  assert.match(JSON.stringify(pending[0].detail), /run the tests/);
  assert.match(JSON.stringify(pending[1].detail), /Which\?/);
  assert.equal(snap.thread.hasPendingApprovals, true);
});

test("a pending runtime request with no turn item is still listed", () => {
  const snap = detailFromV2(v2Detail({ runtimeRequests: [v2Request({ id: "rr-9", kind: "permission" })] }), {});
  assert.deepEqual(pendingRequests(snap.thread.activities).map((p) => [p.requestId, p.kind, p.requestKind]), [["rr-9", "approval", "permission"]]);
});

test("tool turn items become tool activities; errors become error activities", () => {
  const snap = detailFromV2(v2Detail({
    turnItems: [
      v2Item({ id: "c", type: "command_execution", input: "ls", ordinal: 1 }),
      v2Item({ id: "f", type: "file_change", fileName: "a.ts", ordinal: 2 }),
      v2Item({ id: "u", type: "user_message", messageId: "m", text: "x", ordinal: 3 }),
      v2Item({ id: "e", type: "error", failure: { class: "provider_error", message: "it broke", code: null, retryable: null }, ordinal: 4 }),
    ],
  }), {});
  const kinds = snap.thread.activities.map((a) => a.kind);
  assert.deepEqual(kinds, ["tool.command_execution", "tool.file_change", "error"]);
  assert.equal(snap.thread.activities[0].summary, "ls");
  assert.equal(snap.thread.activities[1].summary, "a.ts");
  assert.equal(snap.thread.activities[2].summary, "it broke");
});
