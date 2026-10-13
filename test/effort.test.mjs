import { test } from "node:test";
import assert from "node:assert/strict";
import { withEffort } from "../dist/tools/phase2.js";

// T3 reads a provider-specific option id: Codex "reasoningEffort", Cursor "reasoning",
// Claude "effort". Sending the wrong id leaves the provider on its default (low for Codex).
test("codex threads get reasoningEffort, not effort", () => {
  const sel = withEffort({ instanceId: "codex", model: "gpt-6.1-sol" }, "high");
  assert.deepEqual(sel.options, [{ id: "reasoningEffort", value: "high" }]);
});
test("codex drops a stale effort option and replaces an old reasoningEffort", () => {
  const sel = withEffort({ instanceId: "codex", model: "m", options: [{ id: "effort", value: "low" }, { id: "reasoningEffort", value: "low" }, { id: "serviceTier", value: "default" }] }, "high");
  assert.deepEqual(sel.options, [{ id: "serviceTier", value: "default" }, { id: "reasoningEffort", value: "high" }]);
});
test("cursor threads get reasoning", () => {
  const sel = withEffort({ instanceId: "cursor", model: "m" }, "xhigh");
  assert.deepEqual(sel.options, [{ id: "reasoning", value: "xhigh" }]);
});
test("claude instances keep effort", () => {
  for (const instanceId of ["claude", "claudeAgent", "claudeAgent_claude_2"]) {
    const sel = withEffort({ instanceId, model: "m", options: [{ id: "fastMode", value: false }] }, "high");
    assert.deepEqual(sel.options, [{ id: "fastMode", value: false }, { id: "effort", value: "high" }]);
  }
});
test("object-shaped options use the provider key", () => {
  const sel = withEffort({ instanceId: "codex", model: "m", options: { effort: "low", serviceTier: "default" } }, "high");
  assert.deepEqual(sel.options, { serviceTier: "default", reasoningEffort: "high" });
});
