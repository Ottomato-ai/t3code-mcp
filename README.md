# t3code-mcp

MCP server for a running [T3 Code](https://t3.codes) instance. See which agent threads exist and what they need, read their history, send them messages, approve their permission requests — from Claude Code, Claude Desktop, or (the end goal) a voice-controlled model like Hermes while away from a screen.

See `SPEC.md` for the design and `PLAN.md` for the phased build.

## Setup

```bash
pnpm install && pnpm build
```

1. Make sure T3 Code is running (desktop app or `npx t3@latest`).
2. Mint a bearer token for the local T3 server and put it in `.env` (or export it):

```bash
npx t3@latest auth session issue --token-only --label t3code-mcp --ttl 365d
echo "T3_TOKEN=<the token>" > .env
```

3. Sanity check against the live server (read-only):

```bash
pnpm smoke
```

## Connect from Claude Code

```bash
claude mcp add --scope user t3code -- node /Users/thomascrundwell/Documents/projects/t3code-mcp/dist/index.js
```

(Token is picked up from `.env` in this directory; alternatively pass `--env T3_TOKEN=...`.)

## Tools

**Visibility** — `t3_status`, `list_projects`, `list_threads` (filter by project / attention state), `get_thread`, `search_threads`

**Queues and delivery** — `queue_status`, `send_now`, `reconcile_send`, `delivery_journal`; see below

**Messaging & control** — `send_message`, `create_thread`, `wait_for_turn` (send-and-wait round trip), `interrupt_thread`, `stop_thread`, `archive_thread`, `unarchive_thread`, `set_thread_title`

**Launch desk (cap and queue)** — `create_thread` (now gated, requires `lane`), `launch_wait`, `launch_queue`, `launch_cancel`, `launch_queue_move`; see below

**Hands-free interaction** — `pending_actions` (cross-thread "what needs me?" inbox), `respond_to_approval`, `respond_to_user_input`

**Voice layer** — `thread_digest` and `workspace_digest` (TTS-friendly `spoken` summaries), `wait_for_change` (long-poll until anything needs attention)

Every thread carries a single `attention` state: `needs-approval | needs-input | plan-ready | working | error | done | idle`.

## Launch desk

Scope: the launch desk is for this machine only (Ned's PC). It is not part of the OttoSystems server (bare-metal) build; it may be adapted for that later.

At most `T3_LAUNCH_CAP` (default 15) T3 threads run at once across every lane on the machine. A thread counts while its session is `running`, `ready`, `starting` or `interrupted` (T3 0.0.45 keeps the provider process for these; `idle` is never written, `error` may have no process) and it is not archived; the count is read from T3 at decision time. Ned's own launches in the T3 window are not gated but count toward the cap.

- `create_thread` needs `lane` (the caller's exact session title). With a free slot and nobody waiting ahead it launches at once. Otherwise it answers `queued` with `queue_entry`, `position`, `running` and `cap`, and does not launch.
- `send_message` to a thread whose session is not live (stopped, error, none) starts a provider process again, so it goes through the desk the same way: it needs `lane`, counts as a launch and can answer `queued`. A message to a running, ready, starting or interrupted thread is not gated and needs no lane.
- `launch_wait({ queue_entry, timeout_seconds })` blocks (max 300 s) until the entry is granted or expires. It reads the desk file on every poll and the T3 shell at most once per 30 s. A grant holds a slot for 10 minutes (`T3_LAUNCH_GRANT_MINUTES`); repeat the call (`create_thread` or `send_message`) with the same `lane` and `queue_entry` within that window. A grant is tied to its lane, its project and (for `send_message`) its thread. A missed grant expires and the next entry gets the slot.
- One grant launches one thread. While a launch runs, the entry is `launching` with a claim token; a second call with the same `queue_entry` answers "in progress". If the request never reached T3 (connection refused), the grant comes back and the error says to retry with `queue_entry`. Any other failure marks the entry `failed` (the thread may exist) and it holds its slot for 2 minutes. If the launch succeeded but the desk could not record it, the tool still answers success with a `warning` (do not retry).
- Order: entries with `ned_requested: true` first (only when Ned asked for the launch himself; every one is logged), then first come, first served (a counter in the desk file, not the clock). Waiting entries expire after 24 hours.
- No grant while host-guard reports commit at or above 90%. host-guard status is read from `%USERPROFILE%\.host-guard\heartbeat.json` (or `HOST_GUARD_HOME`); an unreadable or stale (2 min) heartbeat does not block and is logged.
- `launch_queue` is read-only (running, cap, free, memory, grants, waiting list). `free` subtracts running threads, grants and launches of the last 2 minutes. Lane, project and task text is wrapped in `<untrusted-data>`, also in error messages.
- `launch_cancel({ queue_entry, lane })` cancels your own entry. `launch_queue_move({ queue_entry, before, lane })` reorders, only for the OttoContext lead: the lane, without one leading status tag such as `(Resume)`, must be `** OttoContext`, or must equal `T3_LAUNCH_LEAD_LANE` when that is set.
- Effort defaults to `high` on every new thread (also on the project default model). `effort: "max"` is refused unless `ned_requested: true`.
- Every running server re-grants every 30 seconds, so a `stop_thread` frees a slot within 30 s.
- Phase 2, extra slots: the desk reads Host Guard's `%USERPROFILE%.host-guardheadroom.json` (or `HOST_GUARD_HOME`; schema `hostguard.headroom/v1`, rewritten about every 30 s). Effective cap = max(`baseCap`, `t3.live`) + `allowedExtra` (Host Guard formula: `allowedExtra` is how many more agents fit now), at most `hardCap`, always between 15 (`T3_LAUNCH_CAP`) and 20; `allowedExtra` 0 means no extra. A record older than `staleAfterSeconds`, an unreadable file or an unknown schema gives the base cap; so does `measuring` (Host Guard is measuring a new launch). Above the base cap only one extra launch at a time: after an extra grant, no further extra until a record newer than that launch arrives with `measuring` null. `launch_queue` shows `cap`, `cap_base`, `cap_extra`, `cap_reason` (`config`, `base`, `extra`, `stale`, `unreadable`, `schema`, `measuring`, `pending-measurement`) and `headroom`. A `{type: "cap", effective, base, extra, reason}` event is logged when the effective cap changes.

State lives in `%LOCALAPPDATA%\OttoSystems\launch-desk\desk.json` (override: `T3_LAUNCH_DESK_DIR`), shared by every t3code-mcp process. Once per process the folder is checked with icacls and made owner-only (current user and SYSTEM, nothing inherited); if that fails, the desk refuses to use it. Writes are whole-file (temp, fsync, rename) under `desk.lock`, which holds `pid:uuid`; a lock is broken only when its holder process is dead or the lock is 60 s or older (a stalled live holder keeps it), by one breaker at a time (`desk.lock.break`) that renames it aside. Nothing is put back. A holder checks that the lock still holds its token just before it renames its write over `desk.json`, and refuses to write otherwise; it deletes the lock only while it holds its own token. A corrupt or invalid file reads as empty (a copy is kept as `desk.json.corrupt-<ms>`). Temp and stale-lock files older than a minute are swept at start. Audit events (`ned_entry`, `queue_move`, `cancel`, `memory_unreadable`, `corrupt_state`, `stale_lock_broken`, `acl_applied`) go to `events.jsonl` in the same folder. For Host Guard, which measures each launch's memory cost from this file, every recorded launch (`create_thread`, or a gated `send_message`) logs `{at, type: "launched", id, lane, project, thread_id, kind: "create" | "resume", launched_at}`, and a launch T3 accepted but the desk could not record logs `{at, type: "launch_warning", id, thread_id}`. The last 200 entries are kept.

## Complete thread lists (paging)

`list_threads` and `search_threads` page instead of truncating. Every answer carries `total` (threads matching the filters), `returnedSoFar`, `hasMore` and `nextCursor`; call again with `cursor: nextCursor` and the same filters until `hasMore` is false. A call without a cursor returns the same first page and fields as before (`shown`, `matchedOf`, `threads`; `limit` stays at most 100 per page for `list_threads` and 50 for `search_threads`).

- Order `updated` (default) is most recently updated first. A thread updated after the first page can move behind the cursor; every such thread is listed in `changedSinceFirstPage` on later pages, so pages plus that list cover every thread.
- Order `created` (`list_threads` only) is stable while threads update; use it for fleet checks. Threads created after the first page appear in `changedSinceFirstPage`.
- `consistentSinceFirstPage` is true when the workspace did not change while paging (same `snapshotSequence`).
- A cursor belongs to its query: other filters, another order or a damaged cursor is an error. A malformed or failed answer from T3 is always an error, never an empty list.

## Queues and delivery

T3 queues a message sent to a busy thread. These tools read and drive that queue without interrupting anything.

- `queue_status({ threadId })` — the thread's queued runs in T3's delivery order, with the run state (`stopped`, `preparing`, `starting`, `running`, `waiting`), held flags, kind (`user`, `automatic` completion delivery, `notification`), age, text and a SHA-256 of each text. It reads T3's bounded thread snapshot (`/api/orchestration/threads/:id/bounded`: every queued and active run with its message, plus recent history), not the whole history; a server without that route gets the full projection. `starvation` flags user messages waiting behind automatic completions (see Limitations).
- `send_now({ threadId, queuedRunId? })` — starts one queued user message with `queued-run.start`, only while the thread is stopped: T3 refuses while any run is preparing, starting, running or waiting, and so does this tool. It re-reads the thread right before sending, never interrupts, steers or cancels a run, and only sends messages queued at least 5 minutes (`minAgeSeconds` can raise that, not lower it). Without `queuedRunId` it picks the oldest eligible user message. `waitSeconds` (max 120) waits for the thread to stop with one bounded read per `pollSeconds`, at most 60 reads per call; every read's timeout fits the remaining time and nothing is sent after `waitSeconds`. A held queue needs `releaseHold: true`, because starting a run releases every hold on the queue. Threads in `T3_PARKED_THREADS` are never started or released.
- Every result has `outcome`: `delivered` (the run left the queue; content and message id unchanged), `deferred` (nothing changed, or T3 provably refused; safe to try later) or `unknown` (not proven; quarantined). A start T3 accepted but that had not happened by the end of `verifySeconds` is `unknown` too, until reconciled.
- Before a send, a record goes into the delivery journal (`T3_DELIVERY_STATE_DIR`). Only a refused connection, an authorization refusal or T3's receipt ("previously rejected") proves a first attempt was not applied; for a retry of an unproven send only the receipt does. Any other answer (timeout, dropped socket, or a failure answer, which T3 can give after committing a command) is reconciled: the connector re-reads the thread and, if that does not prove the outcome, replays the very same command (same `commandId`), which T3 answers from its receipt or applies once, never twice. It never retries with a new command id. A send that still cannot be proven stays `unknown`: later sends of that message refuse until `reconcile_send` proves the outcome. A record is never cleared because its owner process exited or because the message is still queued (an accepted start can leave a run queued).
- `send_message` uses the same journal. Pass `idempotencyKey` to make retries safe: the same key gives the same command and message ids, so a retried call is answered from T3's receipt. An `unknown` outcome is an error that says not to resend.
- `delivery_journal` lists open (in-flight or unknown) records; `reconcile_send({ threadId, queuedRunId | messageId, allowReplay? })` settles one on proof (`allowReplay` replays the recorded command with its commandId).

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `T3_TOKEN` | — | Bearer token for the T3 server (required) |
| `T3_ORIGIN` | from `~/.t3/userdata/server-runtime.json` | T3 server origin |
| `T3_HTTP_TIMEOUT_MS` | 30000 | HTTP read timeout (100..600000) |
| `T3_PROBE_TIMEOUT_MS` | 3000 | Liveness probe timeout |
| `T3_RPC_TIMEOUT_MS` | 30000 | WebSocket RPC (command) timeout |
| `T3_PARKED_THREADS` | — | Thread ids whose queues the connector never starts or releases |
| `T3_DELIVERY_STATE_DIR` | `%LOCALAPPDATA%\OttoSystems\t3code-mcp\delivery`, else `$XDG_STATE_HOME/t3code-mcp/delivery` (`~/.local/state/...`) | Delivery journal |

Variables can also be set in `.env` next to the package. An invalid timeout is a startup error, not a silent default. `t3_status` reports the effective timeouts and the build the process runs.

## Deployment verification

`pnpm build` writes `dist/build-info.json` (version, git sha, whether the checkout was dirty, a hash of the source). To check a deployed copy against a checkout, read-only:

```bash
node scripts/verify-deploy.mjs --dist /path/to/deployed/dist --env-file /path/to/launch.env
```

It rebuilds the checkout into a temporary folder and compares every file, compares the build info, flags hardcoded timeouts, and prints the timeouts the deployed dist would use under that launch environment (flagging timeout variables it ignores). Exit 0 means the deployed dist is exactly this checkout's build.

## Remote / voice clients (HTTP mode)

For a remote voice agent (e.g. Hermes over Tailscale), run the streamable-HTTP transport with its own bearer token:

```bash
MCP_HTTP_TOKEN=<secret> node dist/index.js --http --port 3774 --host 0.0.0.0
```

Clients connect to `http://<machine>:3774/` with `Authorization: Bearer <secret>`. Binds to 127.0.0.1 unless `--host` is given; T3 Code itself stays localhost-only.

## Testing

- `pnpm test` — builds (with build info), then runs the unit and tool tests with `node --test`, one file at a time (no live T3 needed).
- `node scripts/mutate.mjs [results-file] [label-filter]` — mutation check of the launch desk: applies one mutant at a time to the built `dist` and runs the tests; every mutant must be killed (run `pnpm build` first).
- CI (`.github/workflows/ci.yml`) runs install, build and `pnpm test` on Windows and Ubuntu for pull requests and pushes to `main`.
- `pnpm smoke` — read-only pass over every query tool against the live server.
- `node scripts/smoke.mjs --mutate <projectId>` — additionally runs the full write loop (create disposable thread → agent replies → follow-up message → rename → stop → archive). Use a scratch project; "t3code-mcp scratch" (`/tmp/t3code-mcp-scratch`) exists for this.

## Notes / limitations

- Speaks T3 orchestration protocol 2: reads over HTTP (`/api/orchestration/*` with `x-t3-orchestration-protocol: 2`), commands and archived threads over one short-lived WebSocket RPC call each (`/ws`). Live push is not used: updates are polled, and `create_thread` runs threads directly in the project workspace (start worktree threads from the T3 UI).
- Image attachments not yet supported on `send_message`.
- Queue starvation is a T3 server behaviour: T3 (0.1.6, `QueuedRunOrder.ts`) starts every queued automatic completion before any other queued message, with no aging, and does not allow reordering a message ahead of them. While automatic completions keep arriving, user messages behind them do not start on their own. `queue_status` reports it; `send_now` can start a user message only at a moment the thread is stopped. A fix belongs in T3's scheduler.
- T3 offers no queue-only read; `queue_status` uses the bounded snapshot, which still carries recent history and is heavier than the queue alone.
- Message ages are measured with this machine's clock against T3's `requestedAt`.
- Revoke access anytime: `npx t3@latest auth session list` / `... revoke`.
