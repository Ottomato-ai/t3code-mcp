// Usage: node scripts/set-effort-high.mjs <threadId>... Sets claudeAgent_claude_2 / claude-opus-5-5 at effort high on existing T3 threads.
import * as c from "file:///O:/Development/Infra/t3code-mcp/dist/client.js";
import { randomUUID } from "node:crypto";
const client = c.makeClient();
const ids = process.argv.slice(2);
for (const id of ids) {
  try {
    await client.dispatch({ type: "thread.model-selection.set", commandId: randomUUID(), threadId: id,
      modelSelection: { instanceId: "claudeAgent_claude_2", model: "claude-opus-5-5", options: [{ id: "effort", value: "high" }, { id: "fastMode", value: false }] } });
  } catch (e) { console.log(id.slice(0,8), "ERR", String(e).slice(0,200)); }
}
const shell = await client.shell();
for (const t of shell.threads.filter(t => ids.includes(t.id))) console.log(t.id.slice(0,8), JSON.stringify(t.modelSelection?.options ?? null));
process.exit(0);
