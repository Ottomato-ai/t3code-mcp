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

At most `T3_LAUNCH_CAP` (default 15) T3 threads run at once across every lane on the machine. A thread counts while its session is `running`, `ready` or `starting` and it is not archived; the count is read from T3 at decision time. Ned's own launches in the T3 window are not gated but count toward the cap.

- `create_thread` needs `lane` (the caller's exact session title). With a free slot and nobody waiting ahead it launches at once. Otherwise it answers `queued` with `queue_entry`, `position`, `running` and `cap`, and does not launch.
- `launch_wait({ queue_entry, timeout_seconds })` blocks (max 300 s) until the entry is granted or expires. A grant holds a slot for 10 minutes (`T3_LAUNCH_GRANT_MINUTES`); call `create_thread` again with the same `lane` and `queue_entry` within that window. A grant launches only for its own lane. A missed grant expires and the next entry gets the slot.
- Order: entries with `ned_requested: true` first (only when Ned asked for the launch himself; every one is logged), then first come, first served. Waiting entries expire after 24 hours.
- No grant while host-guard reports commit at or above 90%. host-guard status is read from `%USERPROFILE%\.host-guard\heartbeat.json` (or `HOST_GUARD_HOME`); an unreadable or stale (2 min) heartbeat does not block and is logged.
- `launch_queue` is read-only (running, cap, memory, grants, waiting list). Lane and task text is wrapped in `<untrusted-data>`.
- `launch_cancel({ queue_entry, lane })` cancels your own entry. `launch_queue_move({ queue_entry, before, lane })` reorders, only for the lane `(Resume) ** OttoContext`.
- Effort defaults to `high` on every new thread (also on the project default model). `effort: "max"` is refused unless `ned_requested: true`.
- Every running server re-grants every 30 seconds, so a `stop_thread` frees a slot within 30 s.

State lives in `%LOCALAPPDATA%\OttoSystems\launch-desk\desk.json` (override: `T3_LAUNCH_DESK_DIR`), an owner-only folder shared by every t3code-mcp process. Writes are whole-file (temp, fsync, rename) under `desk.lock`; a corrupt file reads as empty (a copy is kept as `desk.json.corrupt`). Audit events (`ned_entry`, `queue_move`, `cancel`, `memory_unreadable`, `corrupt_state`) go to `events.jsonl` in the same folder. The last 200 entries are kept.

## Remote / voice clients (HTTP mode)

For a remote voice agent (e.g. Hermes over Tailscale), run the streamable-HTTP transport with its own bearer token:

```bash
MCP_HTTP_TOKEN=<secret> node dist/index.js --http --port 3774 --host 0.0.0.0
```

Clients connect to `http://<machine>:3774/` with `Authorization: Bearer <secret>`. Binds to 127.0.0.1 unless `--host` is given; T3 Code itself stays localhost-only.

## Testing

- `pnpm test` — builds, then runs the unit and tool tests with `node --test`, one file at a time (no live T3 needed).
- `pnpm smoke` — read-only pass over every query tool against the live server.
- `node scripts/smoke.mjs --mutate <projectId>` — additionally runs the full write loop (create disposable thread → agent replies → follow-up message → rename → stop → archive). Use a scratch project; "t3code-mcp scratch" (`/tmp/t3code-mcp-scratch`) exists for this.

## Notes / limitations

- Uses T3's HTTP JSON API only (`/api/orchestration/*`). Live push, git-worktree bootstrap, and turn diffs are WebSocket-RPC-only in T3, so: updates are polled, and `create_thread` runs threads directly in the project workspace (start worktree threads from the T3 UI).
- Image attachments not yet supported on `send_message`.
- Revoke access anytime: `npx t3@latest auth session list` / `... revoke`.
