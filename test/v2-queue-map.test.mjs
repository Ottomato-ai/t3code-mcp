// Queued messages read from a V2 thread detail, in the order the server sends them.
import { test } from "node:test";
import assert from "node:assert/strict";
import { queuedMessagesFromV2 } from "../dist/v2.js";
import { v2Detail, v2Run, v2Message, v2QueueDetail, LONG_TEXT, iso, MIN } from "./v2-fixtures.mjs";

test("lists only queued runs, in send order (queuePosition), with position 1 = next", () => {
  const q = queuedMessagesFromV2(v2QueueDetail());
  assert.deepEqual(q.map((m) => m.runId), ["run-q8", "run-q6", "run-q7"]);
  assert.deepEqual(q.map((m) => m.position), [1, 2, 3]);
});

test("each entry carries text, sender, message id and both times", () => {
  const [first, second] = queuedMessagesFromV2(v2QueueDetail());
  assert.equal(first.text, "from the web <b>ui</b>");
  assert.equal(first.createdBy, "user");
  assert.equal(first.creationSource, "web");
  assert.equal(first.messageId, "m-q8");
  assert.equal(first.queuedAt, iso(10 * MIN));
  assert.equal(second.creationSource, "mcp");
  assert.equal(second.text, "RESUME now");
});

test("text is full length here; truncation is the tool's job", () => {
  const q = queuedMessagesFromV2(v2QueueDetail());
  assert.equal(q[2].text, LONG_TEXT);
});

test("without queuePosition the run ordinal decides the order", () => {
  const d = v2Detail({
    runs: [
      v2Run({ id: "b", ordinal: 9, status: "queued", userMessageId: "mb" }),
      v2Run({ id: "a", ordinal: 3, status: "queued", userMessageId: "ma" }),
    ],
    messages: [v2Message({ id: "ma", runId: "a", text: "A" }), v2Message({ id: "mb", runId: "b", text: "B" })],
  });
  assert.deepEqual(queuedMessagesFromV2(d).map((m) => m.runId), ["a", "b"]);
});

test("automatic completion deliveries go first and are marked, as the server sends them", () => {
  const d = v2Detail({
    runs: [
      v2Run({ id: "u", ordinal: 1, status: "queued", userMessageId: "mu", queuePosition: 1 }),
      v2Run({ id: "auto", ordinal: 2, status: "queued", userMessageId: "mauto", queuePosition: 2 }),
    ],
    messages: [
      v2Message({ id: "mu", runId: "u", text: "user" }),
      v2Message({ id: "mauto", runId: "auto", text: "done", delegatedCompletion: { parentRunId: "p", taskIds: [] } }),
    ],
  });
  const q = queuedMessagesFromV2(d);
  assert.deepEqual(q.map((m) => m.runId), ["auto", "u"]);
  assert.equal(q[0].automatic, true);
  assert.equal(q[1].automatic, false);
});

test("the message is found by run.userMessageId, else by runId and role user", () => {
  const d = v2Detail({
    runs: [v2Run({ id: "r1", ordinal: 1, status: "queued", userMessageId: null })],
    messages: [
      v2Message({ id: "ma", runId: "r1", role: "assistant", text: "not me" }),
      v2Message({ id: "mu", runId: "r1", role: "user", text: "me" }),
    ],
  });
  assert.equal(queuedMessagesFromV2(d)[0].text, "me");
});

test("a queued run with no message is still listed, with empty text", () => {
  const d = v2Detail({ runs: [v2Run({ id: "r1", status: "queued", userMessageId: "gone" })], messages: [] });
  const [m] = queuedMessagesFromV2(d);
  assert.equal(m.runId, "r1");
  assert.equal(m.text, "");
  assert.equal(m.messageId, null);
});

test("no runs: empty list", () => {
  assert.deepEqual(queuedMessagesFromV2(v2Detail()), []);
});

test("a message linked only by userMessageId (no runId) is found", () => {
  const d = v2Detail({
    runs: [v2Run({ id: "r1", status: "queued", userMessageId: "mx" })],
    messages: [v2Message({ id: "mx", runId: null, text: "linked by id" })],
  });
  assert.equal(queuedMessagesFromV2(d)[0].text, "linked by id");
});

test("queuedAt is when the run was queued, else when its message was written", () => {
  const d = v2Detail({
    runs: [
      v2Run({ id: "r1", ordinal: 1, status: "queued", userMessageId: "m1", requestedAt: iso(9 * MIN) }),
      v2Run({ id: "r2", ordinal: 2, status: "queued", userMessageId: "m2", requestedAt: null }),
    ],
    messages: [v2Message({ id: "m1", text: "a", createdAt: iso(8 * MIN) }), v2Message({ id: "m2", text: "b", createdAt: iso(7 * MIN) })],
  });
  assert.deepEqual(queuedMessagesFromV2(d).map((m) => m.queuedAt), [iso(9 * MIN), iso(7 * MIN)]);
});
