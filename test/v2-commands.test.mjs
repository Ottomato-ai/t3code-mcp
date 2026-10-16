// Orchestration protocol 2 command builders. Field lists follow OrchestrationV2Command in the
// T3 server bundle; required fields must be present, retired V1 fields must be gone.
import { test } from "node:test";
import assert from "node:assert/strict";
import { commands } from "../dist/v2.js";

const isId = (v) => typeof v === "string" && v.length > 0;

test("message.dispatch starts immediately (the server queues behind an active run)", () => {
  const c = commands.messageDispatch({ threadId: "t-1", text: "hello" });
  assert.equal(c.type, "message.dispatch");
  assert.ok(isId(c.commandId));
  assert.ok(isId(c.messageId));
  assert.equal(c.threadId, "t-1");
  assert.equal(c.text, "hello");
  assert.deepEqual(c.attachments, []);
  assert.equal(c.createdBy, "user");
  assert.equal(c.creationSource, "mcp");
  assert.deepEqual(c.dispatchMode, { type: "start_immediately" });
  for (const gone of ["message", "runtimeMode", "interactionMode", "createdAt"]) assert.equal(gone in c, false, gone);
});

test("thread.create carries creation fields and no createdAt", () => {
  const c = commands.threadCreate({
    threadId: "t-2",
    projectId: "p1",
    title: "T",
    modelSelection: { instanceId: "codex", model: "m", options: [{ id: "reasoningEffort", value: "high" }] },
    runtimeMode: "approval-required",
    interactionMode: "default",
  });
  assert.deepEqual(Object.keys(c).sort(), [
    "branch", "commandId", "createdBy", "creationSource", "interactionMode", "modelSelection",
    "projectId", "runtimeMode", "threadId", "title", "type", "worktreePath",
  ]);
  assert.equal(c.type, "thread.create");
  assert.equal(c.createdBy, "user");
  assert.equal(c.creationSource, "mcp");
  assert.equal(c.branch, null);
  assert.equal(c.worktreePath, null);
});

test("run.interrupt names the run", () => {
  const c = commands.runInterrupt("t-1", "run-9");
  assert.deepEqual({ ...c, commandId: "x" }, { type: "run.interrupt", commandId: "x", threadId: "t-1", runId: "run-9" });
});

test("provider-session.detach names the provider session", () => {
  const c = commands.detachSession("t-1", "ps-1");
  assert.deepEqual({ ...c, commandId: "x" }, {
    type: "provider-session.detach", commandId: "x", threadId: "t-1", providerSessionId: "ps-1", reason: "client-requested",
  });
});

test("runtime-request.respond carries a decision or answers", () => {
  const a = commands.respondApproval("t-1", "rr-1", "acceptForSession");
  assert.deepEqual({ ...a, commandId: "x" }, { type: "runtime-request.respond", commandId: "x", threadId: "t-1", requestId: "rr-1", decision: "acceptForSession" });
  const u = commands.respondUserInput("t-1", "rr-2", { q1: "a" });
  assert.deepEqual({ ...u, commandId: "x" }, { type: "runtime-request.respond", commandId: "x", threadId: "t-1", requestId: "rr-2", answers: { q1: "a" } });
});

test("title, runtime mode and interaction mode use the V2 command names", () => {
  assert.deepEqual({ ...commands.setTitle("t-1", "New"), commandId: "x" }, { type: "thread.metadata.update", commandId: "x", threadId: "t-1", title: "New" });
  assert.deepEqual({ ...commands.setRuntimeMode("t-1", "full-access"), commandId: "x" }, { type: "thread.runtime-mode.set", commandId: "x", threadId: "t-1", runtimeMode: "full-access" });
  assert.deepEqual({ ...commands.setInteractionMode("t-1", "plan"), commandId: "x" }, { type: "thread.interaction-mode.set", commandId: "x", threadId: "t-1", interactionMode: "plan" });
});

test("archive and unarchive keep their shape", () => {
  assert.deepEqual({ ...commands.archive("t-1"), commandId: "x" }, { type: "thread.archive", commandId: "x", threadId: "t-1" });
  assert.deepEqual({ ...commands.unarchive("t-1"), commandId: "x" }, { type: "thread.unarchive", commandId: "x", threadId: "t-1" });
});

test("every builder makes a fresh commandId", () => {
  assert.notEqual(commands.archive("t").commandId, commands.archive("t").commandId);
});
