# Bug report: queued messages build up behind automatic completions (2026-11-07)

Status: connector fixes in this change; one server-side cause (T3 scheduling) remains open.
T3 versions checked: upstream `v0.1.6` and a fork build `0.1.6-perf.5` (the files cited are identical in both).

## Summary

Real (user) messages queued on busy orchestrator threads waited for hours while automatic
delegated-task completions kept running ahead of them. Fleet checks did not see every thread, queue
reads were slow on large threads, "send now" attempts were rejected or timed out with unknown
outcomes, and the deployed connector did not use the configured timeouts.

## Defects, root causes and evidence

All times are UTC on 2026-11-07. Thread A is a long-lived orchestrator thread (about 3,100 runs and
29,000 timeline items); thread B is one of its delegated "seat" threads. Evidence comes from read-only
queries of the T3 projection and command-receipt tables and from T3's source; no message content is
reproduced here.

### 1. Thread lists silently truncated (does not cause the buildup)

`list_threads` fetched the whole shell but returned at most 100 rows per filter, with no way to get
the rest; `matchedOf` counted all threads, not the matches. `search_threads` stopped at 50. Fleet
checks with more threads than that could not see all of them.

**Fix:** keyset pagination (`src/paging.ts`) with `total`, `returnedSoFar`, `hasMore`, `nextCursor`,
change detection across pages (`changedSinceFirstPage`, `consistentSinceFirstPage`) and a stable
`created` order. First pages and existing fields are unchanged.

### 2. Queue reads pulled the full thread history

The queue was extracted from the full thread projection (`/api/orchestration/threads/:id`), which for
thread A is the whole history.

**Root cause / interface:** T3 documents a bounded snapshot,
`GET /api/orchestration/threads/:id/bounded` (`packages/contracts/src/environmentHttp.ts`). Its
projection always contains every run in `queued`, `preparing`, `starting`, `running` or `waiting`,
the user message of each (`threadHistoryPaging.ts`, `messagesForBoundedProjection`), all provider
sessions and runtime requests, and a byte-bounded window of recent history.

**Fix:** `queue_status`, `send_now`, reconciliation, `send_message`, `wait_for_turn`, `interrupt_thread`,
`stop_thread`, `pending_actions` and `thread_digest` read the bounded snapshot (full projection only
as a fallback for servers without the route, or to find a run that has left the window). T3 has no
queue-only read, so the bounded snapshot is the lightest documented option.

### 3. "Send now" treated starting/preparing threads as stopped

**Root cause:** T3 accepts `queued-run.start` only when no run is active, and active means
`preparing`, `starting`, `running` or `waiting` (`CommandPolicy.isActiveRun`; the start handler in
`Orchestrator.ts` rejects with "A queued user message can only be sent now while the thread is
stopped."). Command receipts on thread A show exactly this:

| `queued-run.start` | Receipt | Active run at that moment |
| --- | --- | --- |
| 20:58:43.481 | rejected | one run `running` |
| 21:44:20.889 | rejected | one run `starting` |
| 23:09:25.880 | accepted | none |

**Fix:** one run-state classifier (`src/queue.ts`, `runStateOf`) with five phases. Only `stopped`
allows a send; every send is preceded by a fresh read that re-checks all preconditions.

### 4. Waiting-state delivery: unbounded effort, uncertain outcomes

Delivery while a thread was `waiting` retried up to 40 rounds, each a full projection, overran its
deadline, and left mutations with unknown outcomes. Thread B's queued message is an example of such
an uncertain send: its only `queued-run.start` (21:50:04.929) has a **rejected** receipt, so nothing
was applied, and the message later started through the normal queue (23:11:51) and ran once.

**Fix (`src/delivery/`):**
- Waiting is bounded: nothing is sent later than `waitSeconds` (≤ 120) after the call began, every
  read's timeout fits the remaining time, and a call makes at most 60 reads (15 kept back for
  verification).
- Explicit outcomes: `delivered`, `deferred` (nothing changed), `unknown` (quarantined).
- A journal record is written before every mutating send. Only a refused connection, an
  authorization refusal or T3's receipt proves a first attempt was not applied (for a retry of an
  unproven send, only the receipt). T3 can answer with a failure after committing a command (for
  example when starting the queued run fails), so any other answer is reconciled: from state first,
  then by replaying the same command with the same `commandId`. T3 keeps a durable receipt per
  command id (`Orchestrator.dispatchWithReceipt`): a replay is answered from the receipt (applied,
  or "previously rejected") or applied once. No retry ever uses a new id. A start T3 accepted but
  that has not happened yet also stays open until proven.
- Unproven sends stay quarantined; an exited owner or a still-queued message never clears them.
- `send_message` uses the same journal and takes an `idempotencyKey`, so caller retries cannot
  duplicate a message. Message ids and content are preserved.
- Delivery never interrupts, steers or cancels a run. `queued-message.promote-to-steer` is not used:
  it can stop the target run (a compacting target) or interrupt it (providers that steer by
  interrupt-restart).

### 5. Deployed build drifted from source (hardcoded 30 s timeouts)

The deployed dist used fixed timeouts while its source read them from configuration. In addition,
the deployed connector's queue tools are not in this repository: `main` (`a6f4416`) has no
`queue_status`, `send_now` or delivery code, and a `main` build has fixed `AbortSignal.timeout(30_000)`,
`AbortSignal.timeout(3_000)` and `timeoutMs ?? 30_000`. Neither the deployed source nor its build
inputs could be traced, so this change implements those tools from T3's documented contract.

**Fix:** timeouts come only from `T3_HTTP_TIMEOUT_MS`, `T3_PROBE_TIMEOUT_MS` and `T3_RPC_TIMEOUT_MS`
(invalid values are startup errors). `pnpm build` stamps `dist/build-info.json` (git sha, dirty flag,
source hash). `scripts/verify-deploy.mjs` checks a deployed dist against a checkout file by file,
flags hardcoded timeouts, and prints the timeouts a launch environment yields. Run against a build of
`main` it reports the drift above and exits 1. `t3_status` reports the running build and timeouts.

### 6. Automatic continuations advance while older real messages wait (server-side)

**Root cause, established:** `QueuedRunOrder.queuedRunsInDeliveryOrder` sorts every automatic
completion delivery (a message with `delegatedCompletion`) before every other queued run, with no
aging. The scheduler starts the first unheld run in that order. `queued-run.reorder` refuses to move
a message ahead of automatic completions. So a user message cannot start on its own while any
automatic completion is queued.

On thread A, a user message queued at 16:04:40 started at 23:09:27 only because of an explicit
`queued-run.start`. Across those 7.0 hours:

- the queue advanced 221 times; 220 picked automatic completions, and the only other start was that
  explicit one;
- 25 to 44 automatic completions were queued at every advance (the backlog never drained);
- automatic completions arrived at 33.7/h and completed at 33.4/h.

Other user messages started within seconds only when they arrived while the thread was momentarily
idle. After a run ended, the next queue advance took a median of 7 s (90th percentile 34 s, maximum
104 s); 31 dispatches arrived inside such a gap and started directly, ahead of everything queued. Between 23:09:30 and 23:10:51 the 25
user messages still queued were delivered into the started run as steering (`promote-to-steer`). Their
runs show `cancelled` because the queue entries were retired; the content was delivered.

**Not changed here.** The fix belongs in T3's scheduler. Proposed for the T3 fork: age-bounded
priority, for example delivering the oldest non-automatic queued run next once it has waited longer
than a threshold, or after N consecutive automatic deliveries. `queue_status` reports the condition
(`starvation`), and `send_now` remains the only non-interrupting way to start a starved message.

## Tests

`pnpm test` runs 350 tests. 348 pass and 2 Windows-only ACL tests are skipped on macOS and Linux;
CI runs them on Windows. New coverage:

- more than 100 and more than 1,000 threads (2,500), in both orders and with archived threads;
  per-filter lists over 100; search past 50;
- updates, creations and deletions between pages; cursor misuse;
- malformed or failed answers (shell, archived snapshot, thread snapshots, command results), none of
  which reads as empty;
- every run status and phase precedence, holds, automatic completions and notifications, the 5-minute
  floor, parked threads;
- timeout ambiguity (applied, not applied, accepted but not started, replay lost, previously
  rejected, failure answers that are not proof, refused retries), quarantine surviving an exited
  owner, journal fencing between concurrent writers, concurrent sends, idempotent `send_message`
  retries, send deadlines with slow reads;
- configured timeouts used by the client, no hardcoded timeout in the build, build info, and
  `verify-deploy` drift detection.

## Remaining limitations

- Queue starvation (6) persists until T3's scheduler changes.
- The bounded snapshot still carries recent history; T3 has no queue-only read.
- Message ages use the connector host's clock against T3's `requestedAt`.
- Quarantine records of the previously deployed connector are not imported; they stay where they are
  until reconciled under coordination.
- `consistentSinceFirstPage` and `changedSinceFirstPage` depend on T3 updating `updatedAt` and
  `snapshotSequence`; use order `created` and check `consistentSinceFirstPage` for exact fleet counts.

## Rollout and rollback

Source repair only: nothing in this change touches live queues. Queue clearance is a separate,
coordinated operation.

1. **Pre-flight (read-only).** On the host running the current connector, record its folder, launch
   environment and journal state. Run `node scripts/verify-deploy.mjs --dist <deployed dist>
   --env-file <launch env>` from a checkout of this change. Drift is expected; keep the output. Map
   the existing timeout settings to `T3_HTTP_TIMEOUT_MS` / `T3_PROBE_TIMEOUT_MS` / `T3_RPC_TIMEOUT_MS`
   (verify-deploy flags variables a dist ignores). Put parked threads in `T3_PARKED_THREADS`.
2. **Side-by-side build.** Build into a new folder (`pnpm install --frozen-lockfile && pnpm build`)
   with its own `T3_DELIVERY_STATE_DIR`. Do not overwrite the existing isolated build or its launch
   configuration. `verify-deploy` against the new folder must exit 0, and `t3_status` must show the
   expected git sha and timeouts.
3. **Read-only canary.** Use only `list_threads` (cursor paging, order `created`), `search_threads`
   and `queue_status` from the new build. Compare totals with the old build and with the shell, and
   check `queue_status` latency on the largest threads.
4. **Delivery canary on a scratch thread** (when approvals resume and with coordination): `send_now`
   while the thread runs (expect `deferred`), after it stops (expect `delivered`); check
   `delivery_journal` stays empty.
5. **One production thread**, coordinated, then the remaining checker launches. Settle known uncertain
   sends of the old connector first, by proof only (receipts or `reconcile_send` semantics).

**Rollback:** point the MCP client back at the previous folder and launch environment (left intact
in step 2). Keep the new journal folder for audit; its open records stay valid if the new build
returns. No T3 data or settings change in any step.
