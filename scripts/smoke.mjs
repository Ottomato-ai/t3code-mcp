#!/usr/bin/env node
// Drives the built MCP server over stdio JSON-RPC against the live T3 instance.
// Read-only by default. `--mutate <projectId>` additionally runs the full
// write loop (create disposable thread -> wait -> interrupt -> rename -> archive).
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const child = spawn(process.execPath, [join(root, "dist/index.js")], {
  stdio: ["pipe", "pipe", "inherit"],
  cwd: root,
});

let buf = "";
const pending = new Map();
let nextId = 0;
child.stdout.on("data", (d) => {
  buf += d.toString();
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    const msg = JSON.parse(line);
    if (msg.id !== undefined && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  }
});

function rpc(method, params) {
  const id = ++nextId;
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout waiting for ${method}`)), 180_000);
    pending.set(id, (m) => {
      clearTimeout(t);
      m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result);
    });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
}
function notify(method, params) {
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
}

async function call(name, args = {}) {
  const res = await rpc("tools/call", { name, arguments: args });
  const text = res.content?.[0]?.text ?? "";
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    value = text;
  }
  if (res.isError) throw new Error(`${name} returned error: ${text}`);
  return value;
}

const ok = (label, cond, extra = "") => {
  if (!cond) {
    console.error(`FAIL ${label} ${extra}`);
    process.exitCode = 1;
  } else console.log(`ok   ${label}${extra ? ` — ${extra}` : ""}`);
};

const mutateIdx = process.argv.indexOf("--mutate");
const mutateProjectId = mutateIdx >= 0 ? process.argv[mutateIdx + 1] : null;

try {
  await rpc("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "smoke", version: "0" },
  });
  notify("notifications/initialized");

  const tools = await rpc("tools/list", {});
  ok("tools/list", tools.tools.length >= 18, `${tools.tools.length} tools`);

  const status = await call("t3_status");
  ok("t3_status", status.running === true && status.authOk === true,
    `v${status.serverVersion}, ${status.projects} projects, ${status.threads?.active} active threads`);

  const projects = await call("list_projects");
  ok("list_projects", projects.projects.length > 0, `${projects.projects.length} projects`);

  const threads = await call("list_threads", { limit: 5 });
  ok("list_threads", threads.threads.length > 0, `top: "${threads.threads[0]?.title}" [${threads.threads[0]?.attention}]`);

  const tid = threads.threads[0].threadId;
  const thread = await call("get_thread", { threadId: tid, turnLimit: 2 });
  ok("get_thread", Array.isArray(thread.messages) && thread.messages.length > 0,
    `${thread.messages.length} msgs, attention=${thread.attention}`);

  const pendingActions = await call("pending_actions");
  ok("pending_actions", typeof pendingActions.needsAttention === "number",
    `${pendingActions.needsAttention} threads need attention`);

  const digest = await call("thread_digest", { threadId: tid });
  ok("thread_digest", typeof digest.spoken === "string" && digest.spoken.length > 20,
    digest.spoken.slice(0, 100));

  const wsDigest = await call("workspace_digest", { sinceHours: 168 });
  ok("workspace_digest", typeof wsDigest.spoken === "string", wsDigest.spoken.slice(0, 120));

  const search = await call("search_threads", { query: threads.threads[0].title.split(" ")[0] ?? "a" });
  ok("search_threads", search.matches >= 1, `${search.matches} matches`);

  const wfc = await call("wait_for_change", { timeoutSeconds: 5 });
  ok("wait_for_change", typeof wfc.changed === "number", `changed=${wfc.changed}`);

  if (mutateProjectId) {
    console.log(`--- mutation loop in project ${mutateProjectId} ---`);
    const created = await call("create_thread", {
      projectId: mutateProjectId,
      message:
        "This is an automated smoke test of an external control surface. Reply with exactly: SMOKE-OK. Do not run any tools or commands.",
      title: "t3code-mcp smoke test (disposable)",
      runtimeMode: "approval-required",
      lane: process.env.T3_SMOKE_LANE ?? "t3code-mcp smoke",
    });
    ok("create_thread", created.created === true, `${created.threadId} on ${created.model}`);

    const waited = await call("wait_for_turn", { threadId: created.threadId, timeoutSeconds: 150 });
    ok("wait_for_turn", ["completed", "needs-you", "error", "interrupted", "timeout"].includes(waited.outcome),
      `outcome=${waited.outcome} reply=${(waited.reply?.text ?? "").slice(0, 60)}`);

    const sent = await call("send_message", {
      threadId: created.threadId,
      message: "Thanks. Reply with exactly: SMOKE-DONE. Do not run any tools.",
    });
    ok("send_message", sent.sent === true, `seq=${sent.sequence}`);

    const waited2 = await call("wait_for_turn", { threadId: created.threadId, timeoutSeconds: 150 });
    ok("wait_for_turn(2)",
      waited2.outcome === "completed" && (waited2.reply?.text ?? "").includes("SMOKE-DONE"),
      `outcome=${waited2.outcome} reply=${(waited2.reply?.text ?? "").slice(0, 60)}`);

    const renamed = await call("set_thread_title", { threadId: created.threadId, title: "smoke test — safe to delete" });
    ok("set_thread_title", renamed.renamed === true);

    const stopped = await call("stop_thread", { threadId: created.threadId });
    ok("stop_thread", stopped.stopped === true);

    const archived = await call("archive_thread", { threadId: created.threadId });
    ok("archive_thread", archived.archived === true);
  }

  console.log(process.exitCode ? "SMOKE: FAILURES" : "SMOKE: ALL PASSED");
} catch (e) {
  console.error("SMOKE fatal:", e.message);
  process.exitCode = 1;
} finally {
  child.kill();
}
