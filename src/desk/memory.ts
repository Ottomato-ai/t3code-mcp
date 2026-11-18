// Memory guard input: the host-guard supervisor's heartbeat file, the same file the
// hostguard MCP (hostguard_status / hostguard_pressure) reads. Read-only.
import { readFileSync } from "node:fs";
import { join } from "node:path";

export interface MemoryReading {
  /** ok: fresh heartbeat; stale: heartbeat too old; unreadable: missing or invalid. */
  status: "ok" | "stale" | "unreadable";
  commitPercent: number | null;
  /** The block percent this reading was judged against (T3_LAUNCH_MEMORY_BLOCK_PERCENT). */
  blockPercent: number;
  /** True only for a fresh heartbeat at or above blockPercent. */
  blocks: boolean;
  detail: string | null;
}

/** host-guard beats every few seconds; a beat this old means the supervisor is not running. */
export const HEARTBEAT_STALE_MS = 120_000;

/** Same rule as host-guard's paths(): HOST_GUARD_HOME, else %USERPROFILE%\.host-guard. */
export function defaultHostGuardFile(env: NodeJS.ProcessEnv = process.env): string {
  const profile = env.USERPROFILE || env.HOME || ".";
  const home = env.HOST_GUARD_HOME || join(profile, ".host-guard");
  return join(home, "heartbeat.json");
}

/** blockPercent comes from the desk (LaunchDesk.memoryBlockPercent); there is no default here. */
export function readHostGuardMemory(opts: { file?: string; nowMs?: number; blockPercent: number }): MemoryReading {
  const file = opts.file ?? defaultHostGuardFile();
  const nowMs = opts.nowMs ?? Date.now();
  const blockPercent = opts.blockPercent;
  let hb: { at?: unknown; commitPercent?: unknown };
  try {
    hb = JSON.parse(readFileSync(file, "utf8"));
  } catch (e) {
    return { status: "unreadable", commitPercent: null, blockPercent, blocks: false, detail: `${file}: ${(e as Error).message}` };
  }
  const at = typeof hb.at === "string" ? Date.parse(hb.at) : NaN;
  if (typeof hb.commitPercent !== "number" || !Number.isFinite(hb.commitPercent) || !Number.isFinite(at)) {
    return { status: "unreadable", commitPercent: null, blockPercent, blocks: false, detail: `${file}: no commitPercent or time` };
  }
  const commitPercent = hb.commitPercent;
  if (nowMs - at >= HEARTBEAT_STALE_MS) {
    return {
      status: "stale",
      commitPercent,
      blockPercent,
      blocks: false,
      detail: `host-guard heartbeat is ${Math.round((nowMs - at) / 1000)} s old`,
    };
  }
  return { status: "ok", commitPercent, blockPercent, blocks: commitPercent >= blockPercent, detail: null };
}
