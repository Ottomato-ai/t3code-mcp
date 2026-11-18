# Desk memory block setting Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The launch desk refuses a new grant when Host Guard commit is at or above a configurable percent, `T3_LAUNCH_MEMORY_BLOCK_PERCENT` (integer 50 to 95, default 85), in place of the fixed 90.

**Architecture:** `LaunchDesk.fromEnv` parses the setting (like `T3_LAUNCH_CAP`) and holds it as `memoryBlockPercent`. The desk passes it to `readHostGuardMemory({ blockPercent })` (memory.ts, `blocks`) and in `SlotContext.memoryBlockPercent` to `memoryAllowsGrant` (store.ts). memory.ts and store.ts take the value as an argument; neither imports a constant for it. A bad value falls back to 85 with one stderr line naming the value.

**Tech Stack:** TypeScript (tsc), node:test, MCP SDK.

**Spec:** the lead's brief (handoff `desk-memory-85-build`, Ned's approval 2026-11-19 00:25). Earlier design: `Infra/docs/superpowers/specs/2026-10-12-t3-launch-queue-design.md`.

## Global Constraints

- `T3_LAUNCH_MEMORY_BLOCK_PERCENT`: integer 50 to 95; default 85; missing (unset or empty) uses 85 silently; out of range or not an integer uses 85 and logs one line that names the bad value.
- A grant is refused at or above the percent, also under the cap. Unreadable or stale Host Guard readings never block.
- Every memory refusal keeps its answer (`queued`, same note) and states the percent used (`memory.blockPercent`).
- README and SPEC list the setting next to `T3_LAUNCH_CAP`.
- Never change the user environment, MCP config or Host Guard config. No real thread launches in evals.

---

### Task 1: memory.ts and store.ts take the percent

**Files:** Modify `src/desk/memory.ts`, `src/desk/store.ts:88,174-176`; Test `test/memory.test.mjs`, `test/store.test.mjs`.

**Interfaces:** Produces `readHostGuardMemory(opts: { file?; nowMs?; blockPercent: number }): MemoryReading` with `MemoryReading.blockPercent: number`; `memoryAllowsGrant(commitPercent: number | null, blockPercent: number)`; `SlotContext.memoryBlockPercent: number`. `MEMORY_BLOCK_PERCENT` is removed.

- [ ] Failing tests: 84.9 does not block, 85 blocks (blockPercent 85); 89.9 / 90 with blockPercent 90; unreadable and stale never block at blockPercent 50; store grants at 84.9, refuses at 85, grants on null.
- [ ] Run each file alone (`npx tsc && node --test test/memory.test.mjs`, then store): FAIL.
- [ ] Implement; run each file alone: PASS.

### Task 2: the desk reads the setting and passes it through

**Files:** Modify `src/desk/desk.ts` (constants, `envPercent`, options, `fromEnv`, `memory()`, `ctx()`), `src/tools/desk.ts` (queued answer, `launch_queue`); Test `test/desk-tools.test.mjs`.

**Interfaces:** `DEFAULT_MEMORY_BLOCK_PERCENT = 85`, `MIN_ = 50`, `MAX_ = 95`; `LaunchDeskOptions.memoryBlockPercent?: number`; `LaunchDesk.memoryBlockPercent`; `LaunchDesk.fromEnv(env, log = console.error)`.

- [ ] Failing tests: default 85; `"90"` gives 90; `"49"`, `"96"`, `"abc"` give 85 with exactly one log line naming the value; unset gives 85 with no line; a desk at 85 queues a launch at commit 85 under a free cap and the answer has `memory.blockPercent: 85` and the old note; a desk at 90 launches at commit 87 (the default reader gets the percent); `launch_queue` shows `blockPercent`.
- [ ] Run `node --test test/desk-tools.test.mjs` alone: FAIL. Implement. PASS.

### Task 3: docs, mutants, real-input eval

- [ ] README (setting list next to `T3_LAUNCH_CAP`, the rule line), SPEC rule line, `src/index.ts` help text.
- [ ] Mutants, one at a time, each killed by a named test: default 90; `>=` to `>` in memory.ts; `<` to `<=` in store.ts; MIN 49; MAX 96; no log line; stale branch blocks; desk ignores the setting.
- [ ] Dry run: `LaunchDesk.fromEnv` with `T3_LAUNCH_DESK_DIR` in the scratchpad against the real `%USERPROFILE%\.host-guard\heartbeat.json` (read only); print commit percent, block percent and the decision for 85 and 90. No T3 call.
- [ ] Full `pnpm test` (files run one after another), ship gates, PR.
