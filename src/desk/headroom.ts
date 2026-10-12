// Phase 2 (design section 10): Host Guard measures, the desk decides. Host Guard rewrites
// %USERPROFILE%\.host-guard\headroom.json about every 30 s; the desk reads it read-only.
import { readFileSync } from "node:fs";
import { join } from "node:path";

export const HEADROOM_SCHEMA = "hostguard.headroom/v1";
/** Ned, 2026-10-12: never more than 20 live T3 threads. */
export const HARD_CAP_MAX = 20;
export const DEFAULT_STALE_AFTER_S = 120;

export interface HeadroomReading {
  status: "ok" | "stale" | "unreadable" | "schema";
  /** Record time in ms (null when unreadable). */
  at: number | null;
  baseCap: number | null;
  hardCap: number | null;
  /** Live T3 threads when Host Guard wrote the record (t3.live), or null. */
  live: number | null;
  /** Whole, non-negative number of extra agents Host Guard allows now. */
  allowedExtra: number;
  /** Thread id Host Guard is measuring, or null. */
  measuring: string | null;
  detail: string | null;
}

export type CapReason =
  | "config"
  | "base"
  | "extra"
  | "stale"
  | "unreadable"
  | "schema"
  | "measuring"
  | "pending-measurement";

export interface CapDecision {
  effective: number;
  base: number;
  extra: number;
  reason: CapReason;
  /** Grants allowed beyond the base cap in one pass: one extra launch at a time. */
  extraGrants: number;
}

/** Same home rule as host-guard's paths(): HOST_GUARD_HOME, else %USERPROFILE%\.host-guard. */
export function defaultHeadroomFile(env: NodeJS.ProcessEnv = process.env): string {
  const profile = env.USERPROFILE || env.HOME || ".";
  const home = env.HOST_GUARD_HOME || join(profile, ".host-guard");
  return join(home, "headroom.json");
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

export function readHeadroom(opts: { file?: string; nowMs?: number } = {}): HeadroomReading {
  const file = opts.file ?? defaultHeadroomFile();
  const nowMs = opts.nowMs ?? Date.now();
  const none = (status: HeadroomReading["status"], detail: string): HeadroomReading => ({
    status,
    at: null,
    baseCap: null,
    hardCap: null,
    live: null,
    allowedExtra: 0,
    measuring: null,
    detail,
  });
  let rec: Record<string, unknown>;
  try {
    rec = JSON.parse(readFileSync(file, "utf8"));
    if (!rec || typeof rec !== "object") return none("unreadable", `${file}: not an object`);
  } catch (e) {
    return none("unreadable", `${file}: ${(e as Error).message}`);
  }
  if (rec.schema !== HEADROOM_SCHEMA) return none("schema", `${file}: schema ${String(rec.schema)}`);
  const at = typeof rec.at === "string" ? Date.parse(rec.at) : NaN;
  if (!Number.isFinite(at)) return none("unreadable", `${file}: no valid time`);
  const staleS = num(rec.staleAfterSeconds);
  const staleMs = (staleS !== null && staleS > 0 ? staleS : DEFAULT_STALE_AFTER_S) * 1000;
  const allowed = num(rec.allowedExtra);
  const reading: HeadroomReading = {
    status: nowMs - at > staleMs ? "stale" : "ok",
    at,
    baseCap: num(rec.baseCap),
    hardCap: num(rec.hardCap),
    live: num((rec.t3 as { live?: unknown } | null | undefined)?.live),
    allowedExtra: allowed !== null && allowed > 0 ? Math.floor(allowed) : 0,
    measuring: typeof rec.measuring === "string" ? rec.measuring : null,
    detail: null,
  };
  if (reading.status === "stale") reading.detail = `${file}: record is ${Math.round((nowMs - at) / 1000)} s old`;
  return reading;
}

/**
 * Host Guard formula: effective cap = max(baseCap, live) + allowedExtra, at most hardCap, always
 * within [floor, 20] (floor: T3_LAUNCH_CAP, 15 by default). allowedExtra is how many more
 * agents fit now and live is the record's t3.live, from the same snapshot. allowedExtra 0
 * means no extra grant, even when more than the base cap run. No extra when the record is stale, unreadable or of
 * an unknown schema, while Host Guard measures a launch, or until a record newer than the
 * last extra launch has arrived.
 */
export function decideCap(input: { floor: number; reading: HeadroomReading; lastExtraAt: number | null }): CapDecision {
  const { floor, reading } = input;
  const ceiling = Math.max(HARD_CAP_MAX, floor);
  const clamp = (n: number) => Math.min(Math.max(n, floor), ceiling);
  const flat = (base: number, reason: CapReason): CapDecision => ({ effective: base, base, extra: 0, reason, extraGrants: 0 });
  if (reading.status !== "ok") return flat(floor, reading.status);
  const base = clamp(reading.baseCap ?? floor);
  if (reading.measuring !== null) return flat(base, "measuring");
  if (input.lastExtraAt !== null && !(reading.at !== null && reading.at > input.lastExtraAt)) {
    return flat(base, "pending-measurement");
  }
  const allowed = Math.max(0, Math.floor(reading.allowedExtra));
  if (allowed === 0) return flat(base, "base");
  const effective = clamp(Math.min(Math.max(base, reading.live ?? 0) + allowed, reading.hardCap ?? ceiling));
  const extra = effective - base;
  return extra > 0
    ? { effective, base, extra, reason: "extra", extraGrants: 1 }
    : { effective: base, base, extra: 0, reason: "base", extraGrants: 0 };
}
