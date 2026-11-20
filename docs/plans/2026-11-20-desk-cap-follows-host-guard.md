# Desk cap follows Host Guard: implementation plan

> **For agentic workers:** executed inline by the builder (superpowers:executing-plans style). Steps use checkbox (`- [ ]`) syntax.

**Goal:** A fresh Host Guard headroom record can lower the launch desk's cap below `T3_LAUNCH_CAP`.

**Architecture:** One pure function changes: `decideCap` in `src/desk/headroom.ts`. With `status: ok` it stops clamping to the floor: the base is the record's `baseCap` (a whole number of 1 or more, else the floor), and every branch is clamped to the record's `hardCap` (a whole number of 1 or more) and to the ceiling `max(20, floor)`. Stale, unreadable, unknown-schema or missing records keep the floor. `LaunchDesk.logCap` adds `floor` and `below_floor: true` to the `cap` event only when the effective cap is under the floor, so the existing event keys stay as they are.

**Tech Stack:** TypeScript 5.9 (tsc to `dist/`), `node --test` on `.mjs` files that import `dist/`.

**Spec:** `O:\Development\Infra\docs\superpowers\specs\2026-11-20-t3-desk-cap-follows-host-guard.md`

## Global Constraints

- Fresh record: base = `baseCap` when a whole number of 1 or more, even below the floor; else the floor.
- Effective cap never above `hardCap` (whole number of 1 or more) in every branch: base, measuring, pending-measurement, extra.
- Ceiling `max(20, floor)` still applies.
- Extra: `max(base, live) + allowedExtra`, at most hardCap and the ceiling.
- Stale, unreadable, unknown schema, no record: the floor, unchanged.
- Running MCP servers are not touched: work only in the worktree.

---

## Task 1: decideCap follows a fresh record

**Files:** modify `src/desk/headroom.ts` (decideCap and its doc comment); modify `test/headroom.test.mjs`.

- [ ] Add the spec tests to `test/headroom.test.mjs`: floor 12 and 14 with 10/10 give 10 (`base`); floor 12, baseCap 12, hardCap 10 gives 10; measuring with 10/10 gives 10 (`measuring`); pending-measurement with 10/10 gives 10; stale with 10/10 gives 12 (`stale`); baseCap 0, null, -1 and 10.5 give base 12, and with hardCap 10 base 10.
- [ ] Rewrite the old floor-pinning cases (lines 123, 124, 126, 171) to the new contract, each name saying why.
- [ ] Build and run `node --test test/headroom.test.mjs`: the new cases fail on the floor clamp (expected 10, got 12/14/15).
- [ ] Change `decideCap`. Run the file: all pass.
- [ ] Mutant: drop the hardCap clamp from the base branch, rebuild, show a test fails; restore.

## Task 2: desk queues at the record's cap and logs it

**Files:** modify `src/desk/desk.ts` (`logCap`); modify `test/desk-tools.test.mjs`; modify `README.md` (phase 2 paragraph).

- [ ] Desk test: cap 12 from env, 10 running, fresh record 10/10 with allowedExtra 0: `create_thread` is queued with cap 10, nothing dispatched; `launch_queue` shows cap 10, cap_base 10, reason `base`; the `cap` event has effective 10, base 10, reason `base`, floor 12, below_floor true.
- [ ] Run `node --test test/desk-tools.test.mjs`: the new test fails before the change.
- [ ] Add `floor` and `below_floor` to the event only when effective < floor. Run: all pass, including the exact-keys test for an event at the floor.
- [ ] README: the cap stays within [floor, 20] only without a fresh record; a fresh record may lower it.

## Task 3: evidence and ship

- [ ] Real-input eval, read-only: build, then a scratchpad script reads the live `C:\Users\Ned\.host-guard\headroom.json` with `readHeadroom` and runs `decideCap` with floor 12 and 14, then with status forced to `stale`.
- [ ] Ship gates (security, API, review, observability, launch) with evidence.
- [ ] Full `npm test` in the worktree, tsc clean.
- [ ] Commit, push, PR to main with Gates, Real-input evals and Design record. Do not merge.
