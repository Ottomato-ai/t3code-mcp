# t3code-mcp — MCP Server for T3 Code

## Purpose

A standalone [MCP](https://modelcontextprotocol.io) server that lets any MCP client — Claude Code, Claude Desktop, and in the future a voice-driven model such as Hermes — see and control the agent threads running in a local **T3 Code** instance:

- See which threads exist and what state they're in (running, waiting for approval, done, errored).
- Read thread history (messages, tool activity, pending questions).
- Send messages to threads (continue work, answer the agent, kick off new work).
- Handle the interactive parts of a thread hands-free: approve/deny permission requests, answer agent questions, interrupt runs.

The driving use case is **eyes-free / voice control**: "what are my agents doing?", "read me the last reply on the auth thread", "tell it to also add tests", "approve that command" — from a phone or voice assistant while away from a screen.

## Architecture

```
┌─────────────┐  MCP (stdio, or           ┌──────────────┐  HTTP JSON API   ┌─────────────────┐
│ MCP client   │  streamable HTTP in P3)  │  t3code-mcp  │  Bearer token    │ T3 Code server  │
│ Claude Code /├─────────────────────────►│  (this repo) ├─────────────────►│ 127.0.0.1:3773  │
│ Hermes/voice │                          │  Node + TS   │                  │ (desktop app or │
└─────────────┘                          └──────────────┘                  │  npx t3)        │
                                                                            └─────────────────┘
```

**Standalone by design.** No dependency on the t3code monorepo. T3 Code's sanctioned external-automation surface is its plain HTTP JSON API (the same one the `t3 project` CLI uses), so we call it with `fetch` and mirror only the handful of wire shapes we need. This keeps the MCP server working across T3 Code updates without tracking its Effect-based internals.

### T3 Code integration points (verified against v0.0.34-nightly)

| Concern | Mechanism |
|---|---|
| Server discovery | `~/.t3/userdata/server-runtime.json` → `{origin, pid, port}`; overridable via `T3_ORIGIN` |
| Liveness probe | `GET /.well-known/t3/environment` (unauthenticated) |
| List projects + threads | `GET /api/orchestration/shell` → `{snapshotSequence, projects[], threads[]}` |
| Thread detail (messages, activities, session) | `GET /api/orchestration/threads/:threadId?turnLimit=N&beforeCursor=…` |
| All mutations | `POST /api/orchestration/dispatch` with a `ClientOrchestrationCommand` (`thread.turn.start`, `thread.turn.interrupt`, `thread.approval.respond`, `thread.user-input.respond`, `thread.session.stop`, `thread.archive`, …) |
| Auth | `Authorization: Bearer <token>`; token minted once via `npx t3 auth session issue --token-only --label t3code-mcp` (localhost is **not** unauthenticated). Reads need `orchestration:read`, dispatch needs `orchestration:operate`. |

Live updates over T3's WebSocket (Effect RPC) are intentionally **out of scope**; Phase 3 uses polling (`wait_for_turn`, `wait_for_change`), which is plenty for the voice cadence and avoids coupling to Effect RPC framing.

### Key data-model facts

- A **thread** is a chat with one agent; the **session** is the provider process attached to it. `session.status ∈ idle|starting|running|ready|interrupted|stopped|error`; `latestTurn.state ∈ running|interrupted|completed|error`.
- Pending interactivity is surfaced on the thread shell as `hasPendingApprovals` / `hasPendingUserInput` / `hasActionableProposedPlan`; the request details (requestId, kind, detail) live in `activities` with kind `approval.requested` / `user-input.requested`, matched against `*.resolved`.
- `thread.turn.start` both sends a message and starts the agent turn; with a `bootstrap.createThread` block it creates thread (+ optional worktree) and sends the first message in one dispatch.
- Approval decisions: `accept | acceptForSession | decline | cancel`. Runtime modes: `approval-required | auto-accept-edits | auto | full-access`. Interaction modes: `default | plan`.
- All ids are client-generated UUIDv4 strings; `commandId` makes dispatches idempotent-ish; `createdAt` is overwritten server-side.

## Design principles for the tool surface

1. **Voice-first outputs.** Every tool returns compact JSON with human-meaningful fields (titles, one-line status, relative freshness) ahead of ids, so a voice model can speak results without post-processing. Long text is truncated with explicit `truncated: true` markers and a way to page for more.
2. **Attention-oriented.** The core question on the move is "what needs me?" — statuses are collapsed to a single `attention` field per thread: `needs-approval | needs-input | plan-ready | working | done | error | idle`.
3. **Safe defaults.** Sending to an existing thread reuses the thread's current model/runtime/interaction modes. Destructive or quota-burning actions (create thread, checkpoint revert) are explicit tools with required parameters, never side effects.
4. **Fail with instructions.** If the T3 server is down → say how to start it; 401 → say how to mint a token. Errors name the fix, since the person may be operating by voice with no way to debug.

## Tool surface by phase

### Phase 1 — Core visibility & messaging (the basics)

| Tool | Params | Behavior |
|---|---|---|
| `t3_status` | — | Server reachable? version, environment label, auth OK, counts: projects, active threads, threads needing attention. |
| `list_projects` | `activeOnly?` | Projects with id, title, workspaceRoot; thread counts per project. |
| `list_threads` | `projectId?`, `attention?`, `includeArchived?`, `limit?` (default 25) | Compact rows sorted by recency: id, title, project title, provider+model, `attention`, latest-turn state, branch, updatedAt. Filter by project or attention state. |
| `get_thread` | `threadId`, `turnLimit?` (default 5), `beforeCursor?`, `includeActivities?` | Messages of the last N turns (role, text, timestamps), session status, latest turn, pending approvals/questions **with requestIds and detail**, proposed plans, pagination cursor. |
| `send_message` | `threadId`, `message`, `runtimeMode?`, `interactionMode?` | Dispatch `thread.turn.start` on an existing thread; defaults to the thread's current modes. Returns dispatch sequence + turn confirmation. |

Infrastructure in this phase: origin discovery, token loading (`T3_TOKEN` env or `.env`), HTTP client with typed wire shapes, error mapping, stdio transport, registration docs for `claude mcp add`.

### Phase 2 — Control & interaction

| Tool | Params | Behavior |
|---|---|---|
| `pending_actions` | — | Cross-thread digest of everything blocked on the human: approvals (with command/file detail), questions (with options), actionable plans, errored sessions. The voice "inbox". |
| `respond_to_approval` | `threadId`, `requestId`, `decision` | `thread.approval.respond`; decision `accept/acceptForSession/decline/cancel`. |
| `respond_to_user_input` | `threadId`, `requestId`, `answers` | `thread.user-input.respond`; answers keyed by question id. |
| `send_message` (gate) | `lane?`, `queue_entry?`, `ned_requested?` | See Launch desk: required only when the thread has no live session. |
| `create_thread` | `projectId`, `message`, `lane`, `queue_entry?`, `ned_requested?`, `title?`, `provider?`, `model?`, `effort?`, `runtimeMode?`, `interactionMode?` | Gated by the launch desk (see Launch desk below): launches only when a slot is free and nobody waits ahead, else answers `queued`. Effort defaults to `high`; `max` needs `ned_requested`. Two dispatches: `thread.create` then `thread.turn.start` (the `bootstrap` expansion is WS-only server-side, so the HTTP path must do the two-step itself). Model defaults to the project's `defaultModelSelection`, then the project's most recent thread's model. Threads run in the project workspace — worktree preparation is a WS-only service, so worktree threads must be started from the T3 UI. |
| `interrupt_thread` | `threadId` | `thread.turn.interrupt` on the active turn. |
| `stop_thread` | `threadId` | `thread.session.stop` (shuts down the provider process; thread stays). |
| `wait_for_turn` | `threadId`, `timeoutSeconds?` (default 120, max 300) | Poll until the latest turn leaves `running` **or** the thread starts waiting on approval/input; return final assistant text or what's being asked. Turns "send and check back" into one voice round-trip. |
| `archive_thread` / `unarchive_thread` | `threadId` | `thread.archive` / `thread.unarchive`. |
| `set_thread_title` | `threadId`, `title` | `thread.meta.update` (nice for voice: "call this one 'auth bug'"). |

### Phase 3 — Voice & remote layer

| Tool | Params | Behavior |
|---|---|---|
| `thread_digest` | `threadId`, `sinceMinutes?` | Chronological, TTS-friendly digest of recent activity: what the agent did (tool activity summarized), what it said (last assistant message), what it needs. Plain sentences, no markdown/code dumps. |
| `workspace_digest` | `activeOnly?` | One line per in-flight thread across all projects — the "drive home briefing". |
| `search_threads` | `query`, `limit?` | Substring/fuzzy match over titles + project names + branch from the shell snapshot (server-side search is WS-only). |
| `wait_for_change` | `timeoutSeconds?` (default 60, max 300) | Long-poll the shell snapshot; return when any thread changes attention state (turn completes, approval appears…). Enables a voice loop that stays quiet until something happens. |

Plus **remote transport**: `--http --port <p>` runs the MCP server as streamable HTTP with its own bearer auth (`MCP_HTTP_TOKEN`), bound to 127.0.0.1 by default, so Hermes or any remote voice agent can connect via Tailscale/tunnel while T3 Code itself stays localhost-only.

### Launch desk (cap and queue)

Design: `Infra/docs/superpowers/specs/2026-10-12-t3-launch-queue-design.md`. At most `T3_LAUNCH_CAP` (default 15) live T3 threads (session `running`, `ready` or `starting`, not archived) across all lanes; the count is read from `GET /api/orchestration/shell` at decision time.

| Tool | Params | Behavior |
|---|---|---|
| `launch_wait` | `queue_entry`, `timeout_seconds?` (default 120, max 300) | Poll (re-granting with a fresh running count) until the entry is granted, expires or is cancelled, or the timeout passes. Returns state and position. |
| `launch_queue` | — | Read-only: running, cap, free, host memory, live grants, waiting list (position, lane, project, task, priority, age). Agent text wrapped in `<untrusted-data>`. |
| `launch_cancel` | `queue_entry`, `lane` | Cancel your own waiting or granted entry. |
| `launch_queue_move` | `queue_entry`, `before`, `lane` | Move a waiting entry before another (takes its priority class; the waiting list is renumbered). Only the OttoContext lead: `** OttoContext` after one status tag, or exactly `T3_LAUNCH_LEAD_LANE`; logged. |

`send_message` to a thread without a live session (`stopped`, `error`, none) restarts the agent and is gated the same way (`lane`, `queue_entry?`, `ned_requested?`; entry kind `resume`, tied to that thread). Messages to running or ready threads are not gated.

Rules: Ned entries first, then first come, first served by a counter in `desk.json`; positions dense. A grant needs (running + grants + launches in progress + launches or failed attempts from the last 2 minutes that T3 does not show yet) < cap and host-guard commit < 90% (from `heartbeat.json`; unreadable or older than 2 minutes does not block, logged). A grant is tied to its lane, project and (resume) thread, holds its slot 10 minutes (`T3_LAUNCH_GRANT_MINUTES`), then expires and the next entry is granted. A grant is claimed (`launching`, token) for one launch; a second claim answers in progress; a failure before anything was sent returns the grant, a failure after marks the entry `failed`; a claim older than 5 minutes fails. Waiting entries expire after 24 hours. The last 200 entries are kept. Each server process re-grants every 30 seconds; `launch_wait` reads the T3 shell at most once per 30 s. State: `%LOCALAPPDATA%\OttoSystems\launch-desk\desk.json` (owner-only folder, verified once per process, refused if it cannot be made owner-only; `T3_LAUNCH_DESK_DIR`), whole-file writes under a `pid:uuid` lock file with rename-based stale breaking; audit log `events.jsonl`.

Explicit non-goals for now: file/terminal/preview control (T3 exposes these over WS RPC only), turn diffs, checkpoint revert (destructive; revisit with confirmation semantics), multi-environment fan-out (one T3 server per MCP instance; run several instances if needed).

## Security

- The T3 bearer token grants operate scope on all local agents — it lives in env/`.env` (0600), never in tool output or logs.
- HTTP transport mode requires its own bearer token and binds loopback unless `--host` is given explicitly.
- No tool ever echoes the token; `t3_status` reports auth as a boolean only.

## Failure modes

| Condition | Behavior |
|---|---|
| `server-runtime.json` missing / probe fails | Error: "T3 Code isn't running. Start the desktop app or `npx t3@latest`." |
| 401 | Error: "Token missing/expired. Run `npx t3 auth session issue --token-only --label t3code-mcp` and set T3_TOKEN." |
| Stale `server-runtime.json` (pid dead, port reused) | Probe `/.well-known/t3/environment` before first use; mismatch → treated as not running. |
| Dispatch rejection (schema/decider) | Surface T3's error body verbatim plus the command type attempted. |
