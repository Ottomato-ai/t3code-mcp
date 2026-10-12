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

## Remote / voice clients (HTTP mode)

For a remote voice agent (e.g. Hermes over Tailscale), run the streamable-HTTP transport with its own bearer token:

```bash
MCP_HTTP_TOKEN=<secret> node dist/index.js --http --port 3774 --host 0.0.0.0
```

Clients connect to `http://<machine>:3774/` with `Authorization: Bearer <secret>`. Binds to 127.0.0.1 unless `--host` is given; T3 Code itself stays localhost-only.

## Testing

- `pnpm test` — builds, then runs the unit and tool tests with `node --test`, one file at a time (no live T3 needed).
- `node scripts/mutate.mjs [results-file] [label-filter]` — mutation check of the launch desk: applies one mutant at a time to the built `dist` and runs the tests; every mutant must be killed (run `pnpm build` first).
- CI (`.github/workflows/ci.yml`) runs install, build and `pnpm test` on Windows and Ubuntu for pull requests and pushes to `main`.
- `pnpm smoke` — read-only pass over every query tool against the live server.
- `node scripts/smoke.mjs --mutate <projectId>` — additionally runs the full write loop (create disposable thread → agent replies → follow-up message → rename → stop → archive). Use a scratch project; "t3code-mcp scratch" (`/tmp/t3code-mcp-scratch`) exists for this.

## Notes / limitations

- Uses T3's HTTP JSON API only (`/api/orchestration/*`). Live push, git-worktree bootstrap, and turn diffs are WebSocket-RPC-only in T3, so: updates are polled, and `create_thread` runs threads directly in the project workspace (start worktree threads from the T3 UI).
- Image attachments not yet supported on `send_message`.
- Revoke access anytime: `npx t3@latest auth session list` / `... revoke`.
