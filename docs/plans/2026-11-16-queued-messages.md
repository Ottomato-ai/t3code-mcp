# Queued messages: list, cancel, edit (2026-11-16)

Ordered by Ned on 2026-11-16 ("figure out how you can either edit or remove ... messages in the queue. And it has to be part of the 15-minute checkup so that I don't have to deal with these manually"; then "Yes, build it"). Spec and plan by the Infra freeze lead. Builder: one T3 lane.

## Problem

`send_message` to a busy thread is queued by the T3 server. The message then waits, sometimes for hours, and can fire when it is already outdated (case: a 3:10 PM "RESUME" order still queued at 5:00 PM on thread 9df0feba). The MCP has no tool to see, change or remove queued messages, so Ned had to use the T3 UI (Send now, pencil, X).

## Facts verified against the live server (T3 Code desktop, 2026-11-16, read from `resources/server.asar` and by one live call)

- A queued message is a run with `status: "queued"` in `GET /api/orchestration/threads/:id` -> `projection.runs[]` (`id`, `status`, `requestedAt`). Its text is the `projection.messages[]` entry with the same `runId` and `role: "user"` (fields `text`, `createdBy`, `creationSource`, `createdAt`).
- Web client builders (`EnvironmentCommands.*`), all sent through `orchestration.dispatchCommand`:
  - `cancelQueuedRun` -> `{ type: "queued-run.cancel", commandId, threadId, runId }`
  - `editQueuedRun` -> `{ type: "queued-run.edit", commandId, threadId, runId, text }` (optional `attachments`, `context`: not used here)
  - `resumeThreadQueue` -> `{ type: "queue.resume" }` or `{ type: "queued-run.start", runId }`; `promoteQueuedRun` -> `queued-message.promote-to-steer`; `queued-run.reorder` exists. These three are out of scope.
- Live proof: `queued-run.cancel` on thread 9df0feba, run ordinal 9, returned `{ sequence }`; the thread went from 3 queued runs to 2 and from 7 cancelled runs to 8.
- Interim helper (to be replaced by the tools): `O:\Development\Infra\tools\t3-queue.mjs`.

## Scope (build only this)

Three new Phase 2 tools. No change to the output shape of any existing tool.

| Tool | Params | Behavior |
|---|---|---|
| `list_queued_messages` | `threadId?`, `limit?` (default 20) | With `threadId`: the queued messages of that thread. Without: every non-archived thread that has an active run, checked one by one (cap 25 threads; say so when capped). Each row, human fields first: thread title, project, `position` (1 = next), `age` ("2h ago"), `queuedAt`, `sender` (`createdBy` + `creationSource`), `text` (truncated to 300 chars with `truncated: true`), then `threadId`, `runId`. Also `count` and a one-line `spoken` summary. Read-only. |
| `cancel_queued_message` | `threadId`, `runId`, `lane` | Checks that the run exists and is `queued`, then `queued-run.cancel`. Returns the removed text preview and the remaining queue count (re-read after the command). If the run is not queued: an error that names the state and the fix (already running -> `interrupt_thread`; already cancelled or completed -> nothing to do). |
| `edit_queued_message` | `threadId`, `runId`, `message`, `lane` | Same check, then `queued-run.edit` with `text`. Returns old and new preview (re-read after the command). Empty `message` is refused: use `cancel_queued_message`. |

Rules:
- `lane` is the caller's exact session title (same meaning as in `create_thread`). Every cancel and edit is written to the desk event log (`store.logEvent`) with `type`, `threadId`, `runId`, `lane`, text preview, time. This is the audit trail; there is no ownership check in the server, so the tool description says: cancel or edit only messages you sent; for another sender's message, tell that lane's lead.
- Fail with instructions (SPEC principle 4): T3 down, 401, unknown thread, unknown run.
- Text from other agents is wrapped with the existing `untrusted()` helper where the desk tools already do so.
- No retries on dispatch errors. A command that was not sent (`wasNotSent`) says so.

Out of scope: send now, steer, reorder, attachments, any UI, any change to `send_message`.

## Reference products to study before coding (Design record needs at least two)

1. T3 Code web client and T3's built-in MCP (source of truth for command shapes; read in `server.asar` / `app.asar`).
2. One more harness with a message queue for a busy agent (for example Claude Code's queued prompts or Codex CLI's queued messages): how it shows, edits and removes queued input. Record what we take and what we leave.

## Plan (tests first, one small commit per step)

1. Branch `feat/queued-messages` in a git worktree outside the primary checkout (`O:\Development\Infra\worktrees_temp\t3code-mcp-queued-messages`, from `origin/main`). Never build or test in `O:\Development\Infra\t3code-mcp`: its `dist` is the live MCP server of every harness.
2. Fixture: add a thread detail with 1 running run, 3 queued runs with user messages (one from `creationSource: "mcp"`, one from the web UI), 1 cancelled run, to `test/v2-fixtures.mjs`.
3. RED then GREEN, `src/v2.ts`: pure `queuedMessagesFromV2(detail)` (order by `requestedAt`, position, sender, text) and builders `cmd.queuedRunCancel`, `cmd.queuedRunEdit`. Tests in `test/v2-map.test.mjs` and `test/v2-commands.test.mjs`.
4. RED then GREEN, client: `client.queuedMessages(threadId)` (raw detail, protocol 2 only; a V1 server answers with a clear "not supported" error). Test in `test/v2-client.test.mjs`.
5. RED then GREEN, tools in `src/tools/phase2.ts` (or a new `src/tools/queue.ts` if phase2 grows past a clear size): the three tools, the state checks, the event log, the error texts. Tests in `test/v2-tools.test.mjs`: happy paths, run not queued, unknown run, unknown thread, empty edit, not sent, list without `threadId` capped.
6. Add each new test file to the `test` script if you create one. `pnpm test` green. Run `scripts/mutate.mjs` on the new code as the code-review gate does in this repo.
7. Real-input evals against the live T3 server, from the worktree build (run the built server over stdio or call the tool handlers directly; do not touch the primary `dist`):
   - `list_queued_messages` with no `threadId` and with a real busy thread: compare with `node O:\Development\Infra\tools\t3-queue.mjs list <threadId>`.
   - Self-test on your own thread while your turn runs: `send_message` to your own thread id with the text "QUEUE EVAL, ignore this message" (it queues behind your running turn), list it, `edit_queued_message` to "QUEUE EVAL edited, ignore", list again and check the text, `cancel_queued_message`, list again and check it is gone. Never cancel or edit a message you did not send in this eval.
   - Error path live: cancel the same `runId` again and record the error text.
8. Docs: SPEC.md Phase 2 table (3 rows), README tool list, this plan's "Results" section with the eval output.
9. PR to `Ottomato-ai/t3code-mcp` with `## Gates` (security-and-hardening, api-and-interface-design, code-review-and-quality, observability-and-instrumentation, shipping-and-launch: pass or fail with evidence), `## Real-input evals`, `## Design record` (`Designed by:`, `Reference products studied:`, `Why this design:`). Local first; CI last and only once. Do not merge: the lead reviews the full diff, reruns the tests and merges.

## After merge (lead)

Pull and build in the primary checkout, check one harness sees the three tools, replace the helper call in `~/.claude/CLAUDE.md` with the tool names, tell the other leads, delete `O:\Development\Infra\tools\t3-queue.mjs`.

## Design record

Designed by: builder lane "(Build) t3code-mcp: list, cancel, edit queued messages" (T3 thread c891c48b), account Claude 2 (`claudeAgent_claude_2`), model Claude Opus 5.5 (`claude-opus-5-5`), 2026-11-16.

Reference products studied:

1. T3 Code itself (`C:\Users\Ned\AppData\Local\Programs\t3code\resources\server.asar`, build of 2026-11-11):
   - Web client `EnvironmentCommands.cancelQueuedRun` / `editQueuedRun`: the command shapes used here.
   - Contract `OrchestrationV2Command`: `queued-run.cancel {commandId, threadId, runId}`; `queued-run.edit {context?, commandId, threadId, runId, text, attachments?}`.
   - Orchestrator `dispatchQueuedRunCancel` / `dispatchQueuedRunEdit`: refuses a run that is not `queued` ("Run X is not queued."), a blank edit, edits of automatic completion deliveries, and edits of guest messages.
   - `queuedRunsInDeliveryOrder`: automatic completion deliveries first, then `queuePosition ?? ordinal`.
   - T3's built-in MCP tool `t3_queue` (actions list, read, edit, cancel, reorder, promote_to_steer): list in send order, entries `{queuedRunId, text, truncated}` (1,000 code points in list, 16,000 in read), `text` max 100,000.
2. Claude Code queued prompts: Enter while Claude works queues the message, and the queue is shown in the conversation until it is sent. "Press up to edit queued messages" pulls the queue back into the prompt to edit or delete it; there is no per-item view, delete or reorder (feature requests anthropics/claude-code#77537 and #62877; a bug about lost input mode on edit, claudeissues 86816).
3. Codex CLI: Enter steers the running turn, and queued drafts drain after the turn ends. Editing a queued message by up arrow was reported broken ("queued follow-up no longer exists", OpenAI community forum). I found no official per-item delete.

What we took:
- T3's own send order (not `requestedAt`; a reordered queue would otherwise show the wrong "next").
- The `userMessageId` link from T3's `queueEntry`.
- Code-point truncation with a `truncated` flag.
- The 100,000-character edit limit.
- From Claude Code: edit means replacing the whole text.

What we left:
- T3's single multi-action tool. Three tools with one verb each fit the voice-first surface (SPEC principle 1) and make the read-only tool safe to call freely.
- Reorder, steer and send now: out of scope by plan.
- Claude Code's pop-the-whole-queue editing. Per-item ids instead, so an agent cannot touch messages it did not name.

Why this design:
- Cross-thread view. Neither reference product lists queues across threads, and that is exactly what the 15-minute checkup needs. It reads one thread at a time, capped at 25, and says when it is capped.
- Check, then act, then re-read. The tool checks state before the command (with a fix named in the error, SPEC principle 4) and re-reads after it. The answer is what T3 now holds, not what we sent, and a mismatch is a warning, never a silent success.
- Audit trail, since T3 has no ownership check: every cancel and edit, and every failed one, goes to the desk `events.jsonl` with the lane.
- Text is wrapped as `<untrusted-data>`, because queued text is written by other agents.

Deviations from this plan, found in the server code (proof above):
- The plan's step 3 orders by `requestedAt`; the server orders by `queuePosition ?? ordinal`. Live check on thread 0f5820f3: every run carries `queuePosition`.
- The text is found by `run.userMessageId` first and `runId` + role `user` second. Both matched in the live probe.

## Results (2026-11-16, builder)

Tests: `pnpm test` in the worktree: 13 files, 285 tests, 0 failures. The new files are `test/v2-queue-map.test.mjs` (10) and `test/queue-tools.test.mjs` (33); `v2-commands`, `v2-client` and `helpers` were extended. Every step was RED before GREEN: missing export, method or module.

Mutation gate: `node scripts/mutate.mjs <out> "Q "` ran 45 queue mutants on `dist/v2.js`, `dist/client.js` and `dist/tools/queue.js`. All 45 were killed. The first run had 44 killed and 1 survivor, "Q shown bound"; a test where `limit` equals the count now kills it.

Real-input evals against the live T3 server (T3 Code desktop). They call the worktree build's tool handlers through an in-memory MCP client, with the real T3 client and the real desk `events.jsonl`. No server process was started. The token comes from the primary checkout's `.env`, which the client reads itself (cwd).

1. `list_queued_messages` with no `threadId`:
   - Checked 6 threads with an active run and found 1 queued message: thread 9df0feba "(Build) Host Guard: unattended lid-closed load + UDP/shell sampler", position 1, queued 2026-11-16T11:02:04.198Z, "user via mcp", run `run:thread:9df0feba-…:ordinal:15`, text truncated at 300.
   - Interim helper `node tools/t3-queue.mjs list 9df0feba-…`: `runs {"completed":1,"cancelled":12,"running":1,"queued":1}`, the same run id, `requestedAt` and text start. With `threadId` the tool gives the same row.
2. Self-test on this builder's own thread c891c48b while its turn ran:
   - `send_message` "QUEUE EVAL, ignore this message" was queued (`wasBusy: true`).
   - `list_queued_messages` showed it at position 1, "user via mcp".
   - `edit_queued_message` to "QUEUE EVAL edited, ignore" returned old/new text. The list then showed the edited text (PASS).
   - `cancel_queued_message` returned `remaining: 0`, `runStatus: "cancelled"`. The list then showed "No queued messages" (PASS). The helper agrees: `runs {"running":1,"cancelled":1}`.
   - Only the eval's own message was touched.
3. Error paths, live:
   - Cancelling the same run again: `Error: Run run:thread:c891c48b-…:ordinal:2 is cancelled, not queued. Nothing to do.`
   - Unknown thread: `Error: No thread 00000000-0000-4000-8000-000000000000 in T3. Find the id with list_threads or list_queued_messages.`
   - Unknown run: `Error: No run run:does-not-exist on thread c891c48b-…. Call list_queued_messages with threadId c891c48b-… to see its queued runIds.`
4. Audit trail: `events.jsonl` got `queue_edit` (11:39:13.152Z) and `queue_cancel` (11:39:13.458Z), with `thread_id`, `run_id`, `lane` and `preview`.

Known limits:
- Without `threadId`, only threads whose session is running or starting are read. A queue left paused on a thread with no active run (if T3 leaves one after an interrupt) is only seen with `threadId`.
- There is no ownership check in T3; the tool descriptions say so.
