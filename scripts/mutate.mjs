// Mutation check for the launch desk: one mutant at a time against the built dist/*.js,
// killed when any test file fails. The original file is restored after each mutant.
//
//   pnpm build && node scripts/mutate.mjs [results-file] [label-filter]
//
// Host memory: runs one test process at a time and waits while host-guard reports
// commit at or above 85% (%USERPROFILE%\.host-guard\heartbeat.json, if present).
import { readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const OUT = process.argv[2];
const FILTER = process.argv[3];
const HB = join(process.env.USERPROFILE || process.env.HOME || ".", ".host-guard", "heartbeat.json");
const TESTS = ["test/store.test.mjs", "test/memory.test.mjs", "test/desk-tools.test.mjs", "test/client.test.mjs", "test/headroom.test.mjs"];

const S = "dist/desk/store.js", D = "dist/desk/desk.js", M = "dist/desk/memory.js", R = "dist/desk/running.js";
const T = "dist/tools/desk.js", P1 = "dist/tools/phase1.js", P2 = "dist/tools/phase2.js";
const U = "dist/desk/untrusted.js";
const C = "dist/client.js";
const H = "dist/desk/headroom.js";

// [file, exact text (must occur once), replacement, label]
export const MUTANTS = [
  // queue rules
  [S, `const isActive = (e) => e.state === "waiting" || e.state === "granted" || e.state === "launching";`, `const isActive = (e) => e.state === "waiting" || e.state === "granted";`, "trim keeps launching"],
  [S, `const isActive = (e) => e.state === "waiting" || e.state === "granted" || e.state === "launching";`, `const isActive = (e) => e.state === "waiting" || e.state === "launching";`, "trim keeps granted"],
  [S, `    state.seq = (state.seq ?? 0) + 1;`, `    state.seq = (state.seq ?? 0);`, "counter goes up"],
  [S, `        sort_key: state.seq,`, `        sort_key: req.nowMs,`, "sort key from counter, not clock"],
  [S, `        kind: req.kind ?? "create",`, `        kind: "create",`, "enqueue kind"],
  [S, `        target_thread_id: req.target_thread_id ?? null,`, `        target_thread_id: null,`, "enqueue target"],
  [S, `        project_id: req.project_id,`, `        project_id: "",`, "enqueue project id"],
  [S, `        state: "waiting",`, `        state: "granted",`, "enqueue state"],
  [S, `.filter((e) => e.state === "waiting")\n        .sort(`, `.filter((e) => e.state !== "expired")\n        .sort(`, "orderedWaiting filter"],
  [S, `return a.priority === "ned" ? -1 : 1;`, `return a.priority === "ned" ? 1 : -1;`, "ned first"],
  [S, `        return a.sort_key - b.sort_key;\n    });`, `        return b.sort_key - a.sort_key;\n    });`, "FIFO direction"],
  [S, `return i < 0 ? null : i + 1;`, `return i < 0 ? null : i;`, "position 1-based"],
  [S, `return i < 0 ? null : i + 1;`, `return i <= 0 ? null : i + 1;`, "position null bound"],
  [S, `    let used = running.size;`, `    let used = 0;`, "slotsUsed running"],
  [S, `        if (e.state === "granted" || e.state === "launching")\n            used++;`, `        if (e.state === "granted")\n            used++;`, "launching holds a slot"],
  [S, `        if (e.state === "granted" || e.state === "launching")\n            used++;`, `        if (e.state === "launching")\n            used++;`, "grant holds a slot"],
  [S, `(e.state === "launched" || e.state === "failed") &&`, `(e.state === "launched") &&`, "failed holds a slot"],
  [S, `(e.state === "launched" || e.state === "failed") &&`, `(e.state === "failed") &&`, "launched holds a slot"],
  [S, `ctx.nowMs - Date.parse(e.launched_at) < RECENT_LAUNCH_MS &&`, `ctx.nowMs - Date.parse(e.launched_at) <= RECENT_LAUNCH_MS &&`, "recent launch bound"],
  [S, `!(e.thread_id && running.has(e.thread_id)))`, `true)`, "recent launch double count"],
  [S, `return commitPercent === null || commitPercent < MEMORY_BLOCK_PERCENT;`, `return commitPercent === null || commitPercent <= MEMORY_BLOCK_PERCENT;`, "memory bound"],
  [S, `return commitPercent === null || commitPercent < MEMORY_BLOCK_PERCENT;`, `return commitPercent !== null && commitPercent < MEMORY_BLOCK_PERCENT;`, "memory null does not block"],
  [S, `export const GRANT_WINDOW_MS = 10 * 60_000;`, `export const GRANT_WINDOW_MS = 11 * 60_000;`, "grant window"],
  [S, `export const WAITING_TTL_MS = 24 * 60 * 60_000;`, `export const WAITING_TTL_MS = 25 * 60 * 60_000;`, "waiting ttl"],
  [S, `export const HISTORY_LIMIT = 200;`, `export const HISTORY_LIMIT = 201;`, "history limit"],
  [S, `export const MEMORY_BLOCK_PERCENT = 90;`, `export const MEMORY_BLOCK_PERCENT = 91;`, "memory percent"],
  [S, `export const RECENT_LAUNCH_MS = 2 * 60_000;`, `export const RECENT_LAUNCH_MS = 3 * 60_000;`, "recent launch window"],
  [S, `export const CLAIM_TTL_MS = 5 * 60_000;`, `export const CLAIM_TTL_MS = 6 * 60_000;`, "claim ttl"],
  [S, `export const SWEEP_AGE_MS = 60_000;`, `export const SWEEP_AGE_MS = 180_000;`, "sweep age"],
  [S, `nowMs >= Date.parse(e.grant_expires_at)`, `nowMs > Date.parse(e.grant_expires_at)`, "grant expiry bound"],
  [S, `nowMs - Date.parse(e.created_at) >= WAITING_TTL_MS`, `nowMs - Date.parse(e.created_at) > WAITING_TTL_MS`, "waiting expiry bound"],
  [S, `nowMs - Date.parse(e.claimed_at) >= CLAIM_TTL_MS`, `nowMs - Date.parse(e.claimed_at) > CLAIM_TTL_MS`, "claim expiry bound"],
  [S, `            e.state = "expired";\n        }`, `            e.state = "cancelled";\n        }`, "expired state"],
  [S, `            e.state = "failed";\n            e.launched_at = e.claimed_at;`, `            e.state = "expired";\n            e.launched_at = e.claimed_at;`, "stuck claim fails"],
  [S, `    if (!memoryAllowsGrant(ctx.commitPercent))\n        return granted;`, `    if (false)\n        return granted;`, "grantNext memory guard"],
  [S, `        if (used >= ctx.cap)\n            break;`, `        if (used > ctx.cap)\n            break;`, "cap bound"],
  [S, `        granted.push(e);\n        used++;`, `        granted.push(e);`, "grant consumes slot"],
  [S, `(ctx.grantWindowMs ?? GRANT_WINDOW_MS)`, `(GRANT_WINDOW_MS)`, "grant window option"],
  // claims
  [S, `    if (e.state === "launching") {\n        throw new Error(\`Queue entry \${id}: a launch is already`, `    if (false) {\n        throw new Error(\`Queue entry \${id}: a launch is already`, "second claim refused"],
  [S, `    if (e.state !== "granted")\n        throw new Error(\`Queue entry \${id} is \${e.state}, not granted.\`);`, ``, "claim needs grant"],
  [S, `    e.state = "launching";`, `    e.state = "granted";`, "claim state"],
  [S, `    e.claim = token;`, ``, "claim token stored"],
  [S, `    if (e.state !== "launching" || e.claim !== token) {\n        throw`, `    if (e.state !== "launching") {\n        throw`, "markLaunched checks token"],
  [S, `    e.state = "launched";`, `    e.state = "granted";`, "markLaunched state"],
  [S, `    e.thread_id = threadId;\n    e.launched_at = iso(nowMs);`, `    e.launched_at = iso(nowMs);`, "markLaunched thread id"],
  [S, `    e.launched_at = iso(nowMs);\n    e.updated_at = iso(nowMs);\n    e.claim = null;`, `    e.updated_at = iso(nowMs);\n    e.claim = null;`, "markLaunched time"],
  [S, `    if (e.state !== "launching" || e.claim !== token)\n        return;`, `    if (e.state !== "launching")\n        return;`, "release checks token"],
  [S, `    if (!out.createSent) {`, `    if (false) {`, "grant back when nothing sent"],
  [S, `    if (!out.createSent) {`, `    if (true) {`, "failed after send"],
  [S, `    e.thread_id = out.threadId;`, ``, "failed keeps thread id"],
  [S, `    e.launched_at = e.claimed_at ?? iso(out.nowMs);`, ``, "failed holds slot"],
  // history and moves
  [S, `.filter((e) => !isActive(e))\n        .sort(`, `.filter((e) => true)\n        .sort(`, "trim never drops active"],
  [S, `.sort((a, b) => Date.parse(a.updated_at) - Date.parse(b.updated_at))`, `.sort((a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at))`, "trim oldest first"],
  [S, `    if (id === beforeId)\n        throw`, `    if (false)\n        throw`, "move self"],
  [S, `        if (x.state !== "waiting")\n            throw`, `        if (false)\n            throw`, "move waiting only"],
  [S, `    order.splice(order.indexOf(target), 0, e);`, `    order.splice(order.indexOf(target) + 1, 0, e);`, "move lands before target"],
  [S, `    e.priority = target.priority;`, ``, "move takes priority"],
  [S, `    e.updated_at = iso(nowMs);\n    for (const x of order)`, `    for (const x of order)`, "move sets updated_at"],
  [S, `        x.sort_key = ++state.seq;`, `        x.sort_key = state.seq;`, "move renumbers"],
  // validation
  [S, `    return (isStr(x.id) &&`, `    return (true &&`, "valid id"],
  [S, `        isStr(x.lane) &&`, `        true &&`, "valid lane"],
  [S, `        isStr(x.project) &&`, `        true &&`, "valid project"],
  [S, `        isStr(x.project_id) &&`, `        true &&`, "valid project id"],
  [S, `        isStr(x.task) &&`, `        true &&`, "valid task"],
  [S, `        KINDS.includes(x.kind) &&`, `        true &&`, "valid kind"],
  [S, `        PRIORITIES.includes(x.priority) &&`, `        true &&`, "valid priority"],
  [S, `        STATES.includes(x.state) &&`, `        true &&`, "valid state"],
  [S, `        isTime(x.created_at) &&`, `        true &&`, "valid created_at"],
  [S, `        isTime(x.updated_at) &&`, `        true &&`, "valid updated_at"],
  [S, `        Number.isFinite(x.sort_key));`, `        true);`, "valid sort_key"],
  [S, `const isTime = (v) => isStr(v) && Number.isFinite(Date.parse(v));`, `const isTime = (v) => isStr(v);`, "valid time parse"],
  [S, `    if (!e || typeof e !== "object")\n        return false;\n    const x = e;`, `    const x = e;`, "valid entry object"],
  [S, `    return (s.version === 1 &&`, `    return (true &&`, "valid version"],
  [S, `(s.seq === undefined || (typeof s.seq === "number" && Number.isFinite(s.seq))) &&`, `true &&`, "valid seq"],
  [S, `        Array.isArray(s.entries) &&\n        s.entries.every(validEntry));`, `        Array.isArray(s.entries));`, "entries validated"],
  // lock
  [S, `return code === "EEXIST" || code === "EPERM";`, `return code === "EEXIST";`, "lockBusy EPERM (Windows race)"],
  [S, `return code === "EEXIST" || code === "EPERM";`, `return code === "EPERM";`, "lockBusy EEXIST"],
  [S, `                if (!lockBusy(e.code))\n                    throw e;`, ``, "acquire rethrows other errors"],
  [S, `        const token = \`\${process.pid}:\${randomUUID()}\`;`, `        const token = "x";`, "lock token pid:uuid"],
  [S, `            if (this.breakIfStale())\n                continue;`, ``, "stale lock broken"],
  [S, `export const STALE_LOCK_MS = 60_000;`, `export const STALE_LOCK_MS = 15_000;`, "live holder keeps lock 60 s"],
  [S, `        return ageMs >= this.staleLockMs || lockHolderDead(content);`, `        return ageMs >= this.staleLockMs + 1000 || lockHolderDead(content);`, "60 s bound"],
  [S, `        return ageMs >= this.staleLockMs || lockHolderDead(content);`, `        return ageMs >= this.staleLockMs;`, "dead holder broken at once"],
  [S, `        return ageMs >= this.staleLockMs || lockHolderDead(content);`, `        return lockHolderDead(content);`, "old lock broken"],
  [S, `    if (!m)\n        return false;`, ``, "unparsable lock is not dead"],
  [S, `        process.kill(pid, 0); // pid 0 never gives ESRCH, so it reads as alive\n        return false;`, `        return false;`, "pid probed"],
  [S, `        return e.code === "ESRCH";`, `        return true;`, "EPERM means alive"],
  [S, `            renameSync(path, aside);\n        }\n        catch {\n            return null;`, `            rmSync(path, { force: true });\n        }\n        catch {\n            return null;`, "removed by rename-aside"],
  [S, `            if (holder === null)\n                return false;`, ``, "lost rename not logged"],
  [S, `            this.logEvent({ type: "stale_lock_broken", holder });`, ``, "stale break logged"],
  [S, `            if (this.breakable(guard))\n                this.removeAside(guard);`, ``, "dead breaker guard cleared"],
  [S, `            return false; // another process is breaking it`, ``, "one breaker at a time"],
  [S, `            if (!this.breakable(this.lockFile))\n                return false; // already broken`, ``, "lock checked again inside guard"],
  [S, `        if (!this.breakable(this.lockFile))\n            return false;\n        const guard`, `        const guard`, "fresh lock takes no guard"],
  [S, `                writeSync(fd, guardToken);`, ``, "guard holds a token"],
  [S, `            if (readText(guard) === guardToken)\n                rmSync(guard`, `            if (true)\n                rmSync(guard`, "guard removed by token only"],
  [S, `            if (readText(guard) === guardToken)\n                rmSync(guard`, `            if (false)\n                rmSync(guard`, "guard released"],
  [S, `        if (readText(this.lockFile) !== token) {`, `        if (false) {`, "write checks the token"],
  [S, `        if (readText(this.lockFile) !== token)\n            return;`, ``, "release only own lock"],
  [S, `            this.release(token);`, ``, "lock released"],
  [S, `            trimHistory(state);\n            this.write(state, token);`, `            this.write(state, token);`, "update trims"],
  // read
  [S, `                this.loggedCorrupt = false;`, ``, "corrupt log resets on good read"],
  [S, `        if (!this.loggedCorrupt) {`, `        if (true) {`, "corrupt logged once"],
  [S, `                copyFileSync(this.file, copy);`, ``, "corrupt copy kept"],
  [S, `const copy = \`\${this.file}.corrupt-\${Date.now()}\`;`, `const copy = \`\${this.file}.corrupt\`;`, "corrupt copy timestamped"],
  // folder
  [S, `        if (prepared.has(this.dir))\n            return;`, ``, "ACL once per process"],
  [S, `        prepared.add(this.dir);`, ``, "ACL remembered"],
  [S, `        if (this.platform === "win32")\n            this.secureAcl();`, ``, "ACL step runs"],
  [S, `            if (aclIsOwnerOnly(out, this.dir, this.user))\n                return;`, ``, "owner-only only verified"],
  [S, `"/inheritance:r", `, ``, "inheritance removed"],
  [S, `                this.icacls([this.dir, "/remove", /^S-1-/i.test(p) ? \`*\${p}\` : p]);`, ``, "other principals removed"],
  [S, `            if (!aclIsOwnerOnly(out, this.dir, this.user))\n                throw refuse(`, `            if (false)\n                throw refuse(`, "refuse when not owner-only"],
  [S, `            throw refuse(e.message);`, ``, "refuse on icacls failure"],
  [S, `        if (flags.includes("(I)") || !allowed.has(principal))`, `        if (!allowed.has(principal))`, "inherited ACE rejected"],
  [S, `        if (flags.includes("(I)") || !allowed.has(principal))`, `        if (flags.includes("(I)"))`, "foreign principal rejected"],
  [S, `    return aces > 0;\n}`, `    return true;\n}`, "no ACEs is not owner-only"],
  [S, `    const allowed = new Set([user.toLowerCase(), "nt authority\\\\system"]);`, `    const allowed = new Set([user, "nt authority\\\\system"]);`, "owner match case-insensitive"],
  [S, `            if (!(n.startsWith("desk.json.") && n.endsWith(".tmp")) && !n.startsWith("desk.lock.stale."))\n                continue;`, ``, "sweep only leftovers"],
  [S, `                if (Date.now() - statSync(p).mtimeMs > SWEEP_AGE_MS)`, `                if (true)`, "sweep only old files"],
  [S, `        this.sweep();\n        prepared.add`, `        prepared.add`, "sweep runs"],
  // memory
  [M, `blocks: commitPercent >= MEMORY_BLOCK_PERCENT, detail: null`, `blocks: commitPercent > MEMORY_BLOCK_PERCENT, detail: null`, "memory blocks bound"],
  [M, `if (nowMs - at >= HEARTBEAT_STALE_MS) {`, `if (nowMs - at > HEARTBEAT_STALE_MS) {`, "stale bound"],
  [M, `const home = env.HOST_GUARD_HOME || join(profile, ".host-guard");`, `const home = join(profile, ".host-guard");`, "HOST_GUARD_HOME"],
  [M, `const profile = env.USERPROFILE || env.HOME || ".";`, `const profile = env.HOME || ".";`, "USERPROFILE"],
  [M, `|| !Number.isFinite(at)) {`, `) {`, "time check"],
  [M, `            blocks: false,\n            detail: \`host-guard heartbeat`, `            blocks: commitPercent >= MEMORY_BLOCK_PERCENT,\n            detail: \`host-guard heartbeat`, "stale does not block"],
  // running
  [R, `.filter((t) => !t.archivedAt && `, `.filter((t) => `, "archived excluded"],
  // desk
  [D, `        return lane === override;`, `        return true;`, "lead override exact"],
  [D, `    if (override)\n        return lane === override;`, ``, "lead override used"],
  [D, `return lane.trim().replace(/^\\([^()]*\\)\\s*/, "") === LEAD_LANE_NAME;`, `return lane.trim().replace(/^\\(.*\\)\\s*/, "") === LEAD_LANE_NAME;`, "one status tag only"],
  [D, `return lane.trim().replace(/^\\([^()]*\\)\\s*/, "") === LEAD_LANE_NAME;`, `return lane.replace(/^\\([^()]*\\)\\s*/, "") === LEAD_LANE_NAME;`, "lead lane trimmed"],
  [D, `return lane.trim().replace(/^\\([^()]*\\)\\s*/, "") === LEAD_LANE_NAME;`, `return lane.trim().replace(/^\\([^()]*\\)/, "") === LEAD_LANE_NAME;`, "space after tag"],
  [D, `        this.leadLane = opts.leadLane || undefined;`, `        this.leadLane = undefined;`, "lead lane option"],
  [D, `            leadLane: env.T3_LAUNCH_LEAD_LANE,`, ``, "T3_LAUNCH_LEAD_LANE"],
  [D, `const holdsQueue = (e) => e.state === "waiting" || e.state === "granted" || e.state === "launching";`, `const holdsQueue = (e) => e.state === "waiting";`, "tick runs for grants"],
  [D, `return value !== undefined && value !== "" && Number.isInteger(n) && n >= 0 ? n : fallback;`, `return value !== undefined && value !== "" && n >= 0 ? n : fallback;`, "envInt integer"],
  [D, `return value !== undefined && value !== "" && Number.isInteger(n) && n >= 0 ? n : fallback;`, `return value !== undefined && value !== "" && Number.isInteger(n) && n > 0 ? n : fallback;`, "envInt zero"],
  [D, `return value !== undefined && value !== "" && Number.isInteger(n) && n >= 0 ? n : fallback;`, `return value !== undefined && Number.isInteger(n) && n >= 0 ? n : fallback;`, "envInt empty"],
  [D, `    if (env.T3_LAUNCH_DESK_DIR)\n        return env.T3_LAUNCH_DESK_DIR;`, ``, "desk dir env"],
  [D, `export const DEFAULT_CAP = 15;`, `export const DEFAULT_CAP = 16;`, "default cap"],
  [D, `export const SHELL_INTERVAL_MS = 30_000;`, `export const SHELL_INTERVAL_MS = 0;`, "shell interval default"],
  [D, `envInt(env.T3_LAUNCH_GRANT_MINUTES, GRANT_WINDOW_MS / 60_000) * 60_000`, `GRANT_WINDOW_MS`, "grant minutes env"],
  [D, `if (m.status !== "ok" && this.lastMemoryStatus === "ok") {`, `if (m.status !== "ok") {`, "memory log once"],
  [D, `if (m.status !== "ok" && this.lastMemoryStatus === "ok") {`, `if (false) {`, "memory logged"],
  [D, `commitPercent: memory.blocks ? memory.commitPercent : null,`, `commitPercent: null,`, "desk passes memory"],
  [D, `                if (e.lane !== req.lane) {`, `                if (false) {`, "grant lane check"],
  [D, `                if (e.project_id !== req.projectId) {`, `                if (false) {`, "grant project check"],
  [D, `        if (e.target_thread_id !== target) {`, `        if (false) {`, "grant tied to kind and thread"],
  [D, `                recompute(state, ctx);\n                if (e.state === "granted")`, `                if (e.state === "granted")`, "queue_entry recompute"],
  [D, `                if (e.state === "granted")\n                    return launch(state, e);`, `                if (false)\n                    return launch(state, e);`, "granted launches"],
  [D, `                if (e.state === "waiting")\n                    return queued(state, e);`, ``, "waiting entry re-queued"],
  [D, `                if (e.state === "launching")\n                    claim(state, e.id, ctx.nowMs);`, ``, "launching answers in progress"],
  [D, `            : e.state === "failed"`, `            : false`, "failed entry explained"],
  [D, `priority: req.ned ? "ned" : "normal",`, `priority: "normal",`, "ned priority"],
  [D, `return e.state === "granted" ? launch(state, e) : queued(state, e);`, `return false ? launch(state, e) : queued(state, e);`, "immediate launch"],
  [D, `            recompute(state, ctx);\n            return e.state === "granted"`, `            return e.state === "granted"`, "new entry recompute"],
  [D, `            const token = claim(state, e.id, ctx.nowMs);`, `            const token = "t";`, "launch claims"],
  [D, `        if (req.ned && !req.queueEntry) {`, `        if (false) {`, "ned logged"],
  [D, `        if (!this.store.read().entries.some(holdsQueue))\n            return;`, ``, "tick skips idle"],
  [D, `        if (Date.now() - this.lastShellAt < this.shellIntervalMs)\n            return;`, ``, "shell throttled"],
  [D, `        this.lastShellAt = Date.now();`, ``, "shell time recorded"],
  [D, `            if (e.lane !== lane) {\n                throw new Error(\`Queue entry \${id} belongs`, `            if (false) {\n                throw new Error(\`Queue entry \${id} belongs`, "cancel lane check"],
  [D, `            if (e.state !== "waiting" && e.state !== "granted") {`, `            if (false) {`, "cancel active only"],
  [D, `        if (!isLeadLane(lane, this.leadLane)) {`, `        if (false) {`, "move lead only"],
  [D, `        this.store.logEvent({ type: "queue_move", id, before, lane });`, ``, "move logged"],
  [D, `        expireEntries(state, nowMs);\n        const memory`, `        const memory`, "view expiry"],
  [D, `            free: Math.max(0, this.cap - used),`, `            free: Math.max(0, this.cap - runningIds.length),`, "free counts grants and launches"],
  [D, `belongs to lane \${untrusted(e.lane)}, not`, `belongs to lane \${e.lane}, not`, "lane untrusted in error"],
  [D, `belongs to lane \${untrusted(e.lane)}; a lane`, `belongs to lane \${e.lane}; a lane`, "cancel lane untrusted in error"],
  // tools
  [U, `.replace(/</g, "&lt;").replace(/>/g, "&gt;")`, ``, "untrusted escape"],
  [T, `                if (entry.state !== "waiting") {`, `                if (entry.state === "expired") {`, "wait returns on grant"],
  [T, `                if (Date.now() >= deadline) {`, `                if (Date.now() >= deadline + 60000) {`, "wait timeout"],
  [T, `                await desk.maybeTick(getClient());`, `                await desk.tickOnce(getClient());`, "wait uses throttled tick"],
  [T, `    const call = e.kind === "resume"`, `    const call = false`, "wait note per kind"],
  [P2, `    if (sel.options !== undefined && !Array.isArray(sel.options)) {`, `    if (false) {`, "record options"],
  [P2, `.filter((o) => o.id !== "effort");`, `;`, "effort replaced"],
  [P2, `if (args.effort === "max" && args.ned_requested !== true) {`, `if (false) {`, "max refused"],
  [P2, `withEffort(modelSelection, args.effort ?? "high")`, `withEffort(modelSelection, args.effort ?? "max")`, "effort default high"],
  [P2, `                return queuedResult(admission, "create_thread");`, `                ;`, "queued does not launch"],
  [P2, `                ned: args.ned_requested === true,`, `                ned: false,`, "ned passed"],
  [P2, `            }, runningThreadIds(shell));`, `            }, []);`, "running passed"],
  [P2, `                projectId: project.id,\n                project: project.title,`, `                projectId: "p1",\n                project: project.title,`, "project id passed"],
  [P1, `            const live = LIVE_SESSION_STATES.includes(t.session?.status ?? "");`, `            const live = true;`, "send_message gated"],
  [P1, `            const live = LIVE_SESSION_STATES.includes(t.session?.status ?? "");`, `            const live = false;`, "running thread not gated"],
  [P1, `                if (!args.lane) {`, `                if (false) {`, "send_message needs lane"],
  [P1, `                    return queuedResult(admission, "send_message");`, `                    ;`, "send_message queues"],
  [P1, `                    targetThreadId: t.id,`, ``, "resume tied to thread"],
  [P1, `                    kind: "resume",`, ``, "resume kind"],
  [R, `["running", "ready", "starting", "interrupted"]`, `["running", "ready", "starting"]`, "interrupted counts"],
  [R, `["running", "ready", "starting", "interrupted"]`, `["running", "ready", "interrupted"]`, "starting counts"],
  [R, `["running", "ready", "starting", "interrupted"]`, `["running", "starting", "interrupted"]`, "ready counts"],
  [C, `        this.notSent = opts.notSent ?? false;`, `        this.notSent = opts.notSent ?? true;`, "notSent default false"],
  [C, `    return e instanceof T3Error && e.notSent;`, `    return e instanceof T3Error;`, "wasNotSent reads the flag"],
  [C, `    return e instanceof T3Error && e.notSent;`, `    return !!e?.notSent;`, "wasNotSent needs T3Error"],
  [C, `    if (cause.code === "ECONNREFUSED")\n        return true;`, ``, "refused detected"],
  [C, `    return Array.isArray(cause.errors) && cause.errors.length > 0 && cause.errors.every((x) => x?.code === "ECONNREFUSED");`, `    return false;`, "refused detected in AggregateError"],
  [C, `{ notSent: refused(e) }`, `{}`, "fetch failure marked"],
  [P2, `                    createSent = !wasNotSent(e);`, `                    createSent = true;`, "refused create keeps grant"],
  [P2, `                    createSent = !wasNotSent(e);`, `                    createSent = false;`, "sent create fails entry"],
  [P2, `                createSent = true;\n                result =`, `                result =`, "turn start after create is sent"],
  [P2, `            const warning = recordLaunch(desk, admission.entry.id, admission.claim, threadId);`, `            const warning = undefined;`, "create records launch"],
  [P2, `                ...(warning ? { warning } : {}),`, ``, "create returns warning"],
  [P1, `                if (!gate)\n                    throw e;`, ``, "ungated error unchanged"],
  [P1, `sent: !wasNotSent(e), threadId: t.id`, `sent: true, threadId: t.id`, "refused restart keeps grant"],
  [P1, `            const warning = gate ? recordLaunch(gate.desk, gate.id, gate.claim, t.id) : undefined;`, `            const warning = undefined;`, "restart records launch"],
  [P1, `                ...(warning ? { warning } : {}),`, ``, "restart returns warning"],
  [T, `        desk.markLaunched(id, claim, threadId);\n        return undefined;`, `        return undefined;`, "recordLaunch marks launched"],
  [T, `        desk.launchFailed(id, claim, { createSent: out.sent, threadId: out.threadId });`, ``, "failLaunch releases"],
  [T, `    if (out.sent)\n        return err`, `    if (true)\n        return err`, "not-sent error says retry"],
  [T, `    if (out.sent)\n        return err`, `    if (false)\n        return err`, "sent error unchanged"],
  // F-44: launch events for Host Guard
  [D, `        const e = this.store.update((state) => ({ ...markLaunched(state, id, threadId, this.now(), token) }));`, `        const e = this.store.read().entries.find((x) => x.id === id);`, "F44 launch recorded before the event"],
  [D, `        this.store.logEvent({\n            type: "launched",`, `        ({\n            type: "launched",`, "F44 launched event written"],
  [D, `            type: "launched",`, `            type: "launch",`, "F44 launched type"],
  [D, `            id: e.id,\n            lane: e.lane,`, `            lane: e.lane,`, "F44 launched id"],
  [D, `            lane: e.lane,\n            project: e.project,`, `            project: e.project,`, "F44 launched lane"],
  [D, `            project: e.project,\n            thread_id: e.thread_id,`, `            thread_id: e.thread_id,`, "F44 launched project"],
  [D, `            thread_id: e.thread_id,\n            kind: e.kind,`, `            kind: e.kind,`, "F44 launched thread_id"],
  [D, `            kind: e.kind,\n            launched_at: e.launched_at,`, `            launched_at: e.launched_at,`, "F44 launched kind"],
  [D, `            launched_at: e.launched_at,\n        });`, `        });`, "F44 launched launched_at"],
  [T, `        desk.store.logEvent({ type: "launch_warning", id, thread_id: threadId });`, ``, "F44 warning event written"],
  [T, `        desk.store.logEvent({ type: "launch_warning", id, thread_id: threadId });`, `        desk.store.logEvent({ type: "launch_warning", thread_id: threadId });`, "F44 warning id"],
  [T, `        desk.store.logEvent({ type: "launch_warning", id, thread_id: threadId });`, `        desk.store.logEvent({ type: "launch_warning", id });`, "F44 warning thread_id"],
  [T, `        desk.store.logEvent({ type: "launch_warning", id, thread_id: threadId });`, `        desk.store.logEvent({ type: "launch_warning", id, thread_id: threadId, extra: 1 });`, "F44 warning exact fields"],
  // F-45: phase 2 extra slots from Host Guard headroom
  [H, `export const HARD_CAP_MAX = 20;`, `export const HARD_CAP_MAX = 21;`, "F45 hard cap 20"],
  [H, `export const DEFAULT_STALE_AFTER_S = 120;`, `export const DEFAULT_STALE_AFTER_S = 121;`, "F45 default stale 120 s"],
  [H, `    const home = env.HOST_GUARD_HOME || join(profile, ".host-guard");`, `    const home = join(profile, ".host-guard");`, "F45 HOST_GUARD_HOME"],
  [H, `    const profile = env.USERPROFILE || env.HOME || ".";`, `    const profile = env.HOME || ".";`, "F45 USERPROFILE"],
  [H, `const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);`, `const num = (v) => (Number.isFinite(Number(v)) && v !== null ? Number(v) : null);`, "F45 numbers only"],
  [H, `        if (!rec || typeof rec !== "object")`, `        if (!rec)`, "F45 record is an object"],
  [H, `    if (rec.schema !== HEADROOM_SCHEMA)\n        return none("schema"`, `    if (false)\n        return none("schema"`, "F45 schema checked"],
  [H, `    if (!Number.isFinite(at))\n        return none("unreadable"`, `    if (false)\n        return none("unreadable"`, "F45 time checked"],
  [H, `(staleS !== null && staleS > 0 ? staleS : DEFAULT_STALE_AFTER_S)`, `(staleS ?? DEFAULT_STALE_AFTER_S)`, "F45 stale default for bad values"],
  [H, `        status: nowMs - at > staleMs ? "stale" : "ok",`, `        status: nowMs - at >= staleMs ? "stale" : "ok",`, "F45 stale bound"],
  [H, `        baseCap: num(rec.baseCap),`, `        baseCap: rec.baseCap ?? null,`, "F45 baseCap number"],
  [H, `        hardCap: num(rec.hardCap),`, `        hardCap: 20,`, "F45 hardCap read"],
  [H, `        allowedExtra: allowed !== null && allowed > 0 ? Math.floor(allowed) : 0,`, `        allowedExtra: allowed ?? 0,`, "F45 reader floors allowedExtra"],
  [H, `        measuring: typeof rec.measuring === "string" ? rec.measuring : null,`, `        measuring: rec.measuring ?? null,`, "F45 measuring string"],
  [H, `    if (reading.status === "stale")\n        reading.detail`, `    if (false)\n        reading.detail`, "F45 stale detail"],
  [H, `    const ceiling = Math.max(HARD_CAP_MAX, floor);`, `    const ceiling = HARD_CAP_MAX;`, "F45 floor above 20 kept"],
  [H, `    const clamp = (n) => Math.min(Math.max(n, floor), ceiling);`, `    const clamp = (n) => Math.min(n, ceiling);`, "F45 never below floor"],
  [H, `    const clamp = (n) => Math.min(Math.max(n, floor), ceiling);`, `    const clamp = (n) => Math.max(n, floor);`, "F45 never above ceiling"],
  [H, `    if (reading.status !== "ok")\n        return flat(floor, reading.status);`, ``, "F45 not ok means floor"],
  [H, `    const base = clamp(reading.baseCap ?? floor);`, `    const base = floor;`, "F45 base from file"],
  [H, `    if (reading.measuring !== null)\n        return flat(base, "measuring");`, ``, "F45 measuring means no extra"],
  [H, `    if (input.lastExtraAt !== null && !(reading.at !== null && reading.at > input.lastExtraAt)) {`, `    if (false) {`, "F45 pending measurement"],
  [H, `reading.at > input.lastExtraAt)) {`, `reading.at >= input.lastExtraAt)) {`, "F45 newer record needed"],
  [H, `    const allowed = Math.max(0, Math.floor(reading.allowedExtra));`, `    const allowed = reading.allowedExtra;`, "F45 decision floors allowedExtra"],
  [H, `Math.min(Math.max(base, reading.live ?? 0) + allowed, reading.hardCap ?? ceiling)`, `(Math.max(base, reading.live ?? 0) + allowed)`, "F45 hardCap limits"],
  [H, `Math.max(base, reading.live ?? 0) + allowed`, `base + allowed`, "F45B live counts (Host Guard formula)"],
  [H, `Math.max(base, reading.live ?? 0) + allowed`, `(reading.live ?? 0) + allowed`, "F45B base when live is low"],
  [H, `    if (allowed === 0)
        return flat(base, "base");`, ``, "F45B allowedExtra 0 means no extra"],
  [H, `        live: num(rec.t3?.live),`, `        live: null,`, "F45B live read"],
  [H, `        live: num(rec.t3?.live),`, `        live: rec.t3?.live ?? null,`, "F45B live is a number"],
  [H, `{ effective, base, extra, reason: "extra", extraGrants: 1 }`, `{ effective, base, extra, reason: "extra", extraGrants: 2 }`, "F45 one extra at a time"],
  [S, `        const isExtra = ctx.baseCap !== undefined && used >= ctx.baseCap;`, `        const isExtra = ctx.baseCap !== undefined && used > ctx.baseCap;`, "F45 extra bound"],
  [S, `        const isExtra = ctx.baseCap !== undefined && used >= ctx.baseCap;`, `        const isExtra = false;`, "F45 extra detected"],
  [S, `        if (isExtra && extraGiven >= (ctx.extraGrants ?? 0))\n            break;`, ``, "F45 extra grants limited"],
  [S, `(ctx.extraGrants ?? 0)`, `(ctx.extraGrants ?? 1)`, "F45 extra grants default 0"],
  [S, `            e.extra = true;`, ``, "F45 extra flagged"],
  [S, `            state.last_extra_at = iso(ctx.nowMs);`, ``, "F45 extra grant timed"],
  [S, `            extraGiven++;`, ``, "F45 extra counted"],
  [S, `    if (e.extra)\n        state.last_extra_at = e.launched_at;`, `    if (true)\n        state.last_extra_at = e.launched_at;`, "F45 only extra launches timed"],
  [S, `    if (e.extra)\n        state.last_extra_at = e.launched_at;`, ``, "F45 extra launch timed"],
  [S, `(x.extra === undefined || typeof x.extra === "boolean")`, `true`, "F45 valid extra"],
  [S, `(s.last_extra_at === undefined || s.last_extra_at === null || isTime(s.last_extra_at))`, `true`, "F45 valid last_extra_at"],
  [S, `(s.cap_effective === undefined || s.cap_effective === null || Number.isFinite(s.cap_effective))`, `true`, "F45 valid cap_effective"],
  [D, `            readHeadroom: () => readHeadroom({ file: headroomFile }),`, ``, "F45 fromEnv reads headroom"],
  [D, `        if (!reading)\n            return { effective: this.cap, base: this.cap, extra: 0, reason: "config", extraGrants: 0 };`, `        if (!reading)\n            return { effective: this.cap, base: this.cap, extra: 0, reason: "base", extraGrants: 0 };`, "F45 config reason"],
  [D, `        const last = state.last_extra_at ? Date.parse(state.last_extra_at) : null;`, `        const last = null;`, "F45 last extra used"],
  [D, `        ctx.cap = decision.effective;`, ``, "F45 effective cap applied"],
  [D, `            ctx.baseCap = decision.base;`, ``, "F45 base cap applied"],
  [D, `            ctx.extraGrants = decision.extraGrants;`, ``, "F45 extra grants applied"],
  [D, `        const changed = state.cap_effective !== decision.effective;`, `        const changed = true;`, "F45 cap logged on change only"],
  [D, `        state.cap_effective = decision.effective;`, ``, "F45 cap remembered"],
  [D, `        if (!cap.changed)\n            return;`, ``, "F45 unchanged cap not logged"],
  [D, `extra: d.extra, reason: d.reason });`, `extra: d.extra });`, "F45 cap event fields"],
  [D, `            cap = this.applyCap(state, ctx, reading);\n            if (req.queueEntry) {`, `            if (req.queueEntry) {`, "F45 admit applies cap"],
  [D, `        this.logCap(cap);\n        if (req.ned`, `        if (req.ned`, "F45 admit logs cap"],
  [D, `            cap: cap.decision.effective,`, `            cap: this.cap,`, "F45 queued shows effective cap"],
  [D, `            cap = this.applyCap(state, ctx, reading);\n            return recompute(state, ctx);`, `            return recompute(state, ctx);`, "F45 tick applies cap"],
  [D, `        if (cap)\n            this.logCap(cap);`, ``, "F45 tick logs cap"],
  [D, `            cap: decision.effective,\n            capDecision`, `            cap: this.cap,\n            capDecision`, "F45 view effective cap"],
  [D, `            free: Math.max(0, decision.effective - used),`, `            free: Math.max(0, this.cap - used),`, "F45 view free"],
  [T, `                cap_base: v.capDecision.base,`, ``, "F45 queue cap_base"],
  [T, `                cap_extra: v.capDecision.extra,`, ``, "F45 queue cap_extra"],
  [T, `                cap_reason: v.capDecision.reason,`, ``, "F45 queue cap_reason"],
  [T, `                        at: v.headroom.at === null ? null : new Date(v.headroom.at).toISOString(),`, `                        at: v.headroom.at,`, "F45 queue headroom at"],
  [T, `                        allowed_extra: v.headroom.allowedExtra,`, ``, "F45 queue headroom allowed_extra"],
];

function commit() {
  try {
    return JSON.parse(readFileSync(HB, "utf8")).commitPercent;
  } catch {
    return null;
  }
}
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const log = (line) => {
  console.log(line);
  if (OUT) appendFileSync(OUT, line + "\n");
};

if (OUT) writeFileSync(OUT, "");
let killed = 0, survived = 0, invalid = 0;
for (const [rel, find, replace, label] of MUTANTS) {
  if (FILTER && !label.includes(FILTER)) continue;
  for (let c = commit(); typeof c === "number" && c >= 85; c = commit()) {
    console.log(`commit ${c}% >= 85, waiting`);
    sleep(15000);
  }
  const file = join(ROOT, rel);
  const orig = readFileSync(file, "utf8");
  const text = orig.replace(/\r\n/g, "\n");
  const n = text.split(find).length - 1;
  if (n !== 1) {
    invalid++;
    log(`INVALID  ${label} (${n} matches in ${rel})`);
    continue;
  }
  writeFileSync(file, text.replace(find, replace));
  let by = null;
  try {
    for (const t of TESTS) {
      const r = spawnSync(process.execPath, ["--test", "--test-timeout=30000", t], { cwd: ROOT, encoding: "utf8", timeout: 240000 });
      if (r.status !== 0) {
        const m = /✖ (?!failing tests)(.+?) \(\d/.exec(r.stdout ?? "");
        by = `${t}: ${m ? m[1] : `exit ${r.status}`}`;
        break;
      }
    }
  } finally {
    writeFileSync(file, orig);
  }
  if (by) killed++;
  else survived++;
  log(by ? `KILLED   ${label}  <- ${by}` : `SURVIVED ${label} (${rel})`);
}
log(`TOTAL ${killed + survived + invalid}: killed ${killed}, survived ${survived}, invalid ${invalid}`);
process.exitCode = survived + invalid > 0 ? 1 : 0;
