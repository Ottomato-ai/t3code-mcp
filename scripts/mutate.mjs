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
const TESTS = ["test/store.test.mjs", "test/memory.test.mjs", "test/desk-tools.test.mjs"];

const S = "dist/desk/store.js", D = "dist/desk/desk.js", M = "dist/desk/memory.js", R = "dist/desk/running.js";
const T = "dist/tools/desk.js", P1 = "dist/tools/phase1.js", P2 = "dist/tools/phase2.js";

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
  [S, `        typeof x.sort_key === "number" &&`, `        true &&`, "valid sort_key"],
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
  [S, `<= this.staleLockMs)\n                return false;`, `>= 0)\n                return false;`, "stale bound used"],
  [S, `            if (Date.now() - statSync(this.lockFile).mtimeMs <= this.staleLockMs)`, `            if (Date.now() - statSync(this.lockFile).mtimeMs < 0)`, "only stale locks broken"],
  [S, `        if (got !== seen) {`, `        if (false) {`, "fresh lock put back"],
  [S, `                linkSync(aside, this.lockFile);`, ``, "put back links"],
  [S, `        this.logEvent({ type: "stale_lock_broken", holder: seen });`, ``, "stale break logged"],
  [S, `        if (readText(this.lockFile) !== token)\n            return;`, ``, "release only own lock"],
  [S, `            this.release(token);`, ``, "lock released"],
  [S, `            trimHistory(state);\n            this.write(state);`, `            this.write(state);`, "update trims"],
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
  [R, `["running", "ready", "starting"]`, `["running", "ready"]`, "starting counts"],
  [R, `["running", "ready", "starting"]`, `["running", "starting"]`, "ready counts"],
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
  [T, `.replace(/</g, "&lt;").replace(/>/g, "&gt;")`, ``, "untrusted escape"],
  [T, `                if (entry.state !== "waiting") {`, `                if (entry.state === "expired") {`, "wait returns on grant"],
  [T, `                if (Date.now() >= deadline) {`, `                if (Date.now() >= deadline + 60000) {`, "wait timeout"],
  [T, `                await desk.maybeTick(getClient());`, `                await desk.tickOnce(getClient());`, "wait uses throttled tick"],
  [T, `    const call = e.kind === "resume"`, `    const call = false`, "wait note per kind"],
  [P2, `    if (sel.options !== undefined && !Array.isArray(sel.options)) {`, `    if (false) {`, "record options"],
  [P2, `.filter((o) => o.id !== "effort");`, `;`, "effort replaced"],
  [P2, `if (args.effort === "max" && args.ned_requested !== true) {`, `if (false) {`, "max refused"],
  [P2, `withEffort(modelSelection, args.effort ?? "high")`, `withEffort(modelSelection, args.effort ?? "max")`, "effort default high"],
  [P2, `                return queuedResult(admission, "create_thread");`, `                ;`, "queued does not launch"],
  [P2, `                createSent = true;`, ``, "create marked sent"],
  [P2, `            desk.markLaunched(admission.entry.id, admission.claim, threadId);`, ``, "markLaunched called"],
  [P2, `                ned: args.ned_requested === true,`, `                ned: false,`, "ned passed"],
  [P2, `            }, runningThreadIds(shell));`, `            }, []);`, "running passed"],
  [P2, `                projectId: project.id,\n                project: project.title,`, `                projectId: "p1",\n                project: project.title,`, "project id passed"],
  [P1, `            const live = LIVE_SESSION_STATES.includes(t.session?.status ?? "");`, `            const live = true;`, "send_message gated"],
  [P1, `            const live = LIVE_SESSION_STATES.includes(t.session?.status ?? "");`, `            const live = false;`, "running thread not gated"],
  [P1, `                if (!args.lane) {`, `                if (false) {`, "send_message needs lane"],
  [P1, `                    return queuedResult(admission, "send_message");`, `                    ;`, "send_message queues"],
  [P1, `                    targetThreadId: t.id,`, ``, "resume tied to thread"],
  [P1, `                    kind: "resume",`, ``, "resume kind"],
  [P1, `            gate?.desk.markLaunched(gate.id, gate.claim, t.id);`, ``, "send_message marks launched"],
  [P1, `                gate?.desk.launchFailed(gate.id, gate.claim, { createSent: true, threadId: t.id });`, ``, "send_message failure released"],
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
