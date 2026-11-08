import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { ServerRuntime } from "./model.js";

const RUNTIME_PATH = join(homedir(), ".t3", "userdata", "server-runtime.json");

export class ConfigError extends Error {}

/** Parse a minimal KEY=VALUE .env file (no quoting rules needed here). */
function parseDotEnv(path: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
    if (m && !line.trimStart().startsWith("#")) out[m[1]] = m[2];
  }
  return out;
}

function dotEnvCandidates(): string[] {
  const pkgRoot = dirname(dirname(fileURLToPath(import.meta.url))); // dist/.. = package root
  return [join(process.cwd(), ".env"), join(pkgRoot, ".env")];
}

export function discoverOrigin(): string {
  if (process.env.T3_ORIGIN) return process.env.T3_ORIGIN.replace(/\/$/, "");
  if (!existsSync(RUNTIME_PATH)) {
    throw new ConfigError(
      `T3 Code doesn't appear to be running: ${RUNTIME_PATH} not found. ` +
        `Start the T3 Code desktop app or run \`npx t3@latest\`, or set T3_ORIGIN.`,
    );
  }
  try {
    const runtime = JSON.parse(readFileSync(RUNTIME_PATH, "utf8")) as ServerRuntime;
    if (!runtime.origin) throw new Error("no origin field");
    return runtime.origin.replace(/\/$/, "");
  } catch (e) {
    throw new ConfigError(`Could not read T3 server runtime file (${RUNTIME_PATH}): ${e}`);
  }
}

export function loadToken(): string {
  if (process.env.T3_TOKEN) return process.env.T3_TOKEN;
  for (const path of dotEnvCandidates()) {
    if (existsSync(path)) {
      const env = parseDotEnv(path);
      if (env.T3_TOKEN) return env.T3_TOKEN;
    }
  }
  throw new ConfigError(
    "No T3 auth token found. Mint one with " +
      "`npx t3@latest auth session issue --token-only --label t3code-mcp --ttl 365d` " +
      "and set it as T3_TOKEN (env var, or .env next to t3code-mcp).",
  );
}

/**
 * Timeouts for calls to T3. Every value comes from the environment (or `.env`), so the build
 * and its deployment cannot drift into a hardcoded value again.
 */
export interface Timeouts {
  /** HTTP reads (`/api/orchestration/*`). */
  httpMs: number;
  /** Unauthenticated liveness probe (`/.well-known/t3/environment`). */
  probeMs: number;
  /** One WebSocket RPC call (commands, archived snapshot). */
  rpcMs: number;
}

export const DEFAULT_TIMEOUTS: Readonly<Timeouts> = Object.freeze({ httpMs: 30_000, probeMs: 3_000, rpcMs: 30_000 });

/** Environment variable for each timeout. */
export const TIMEOUT_ENV: Readonly<Record<keyof Timeouts, string>> = Object.freeze({
  httpMs: "T3_HTTP_TIMEOUT_MS",
  probeMs: "T3_PROBE_TIMEOUT_MS",
  rpcMs: "T3_RPC_TIMEOUT_MS",
});

export const MIN_TIMEOUT_MS = 100;
export const MAX_TIMEOUT_MS = 600_000;

/** Read KEY from the process environment, else from the first `.env` that sets it. */
function envValue(key: string): string | undefined {
  const direct = process.env[key];
  if (direct !== undefined && direct !== "") return direct;
  for (const path of dotEnvCandidates()) {
    if (existsSync(path)) {
      const env = parseDotEnv(path);
      if (env[key] !== undefined && env[key] !== "") return env[key];
    }
  }
  return undefined;
}

/** A timeout setting: unset gives the default; anything but an integer in range is an error. */
export function parseTimeoutMs(name: string, raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) {
    throw new ConfigError(`${name}=${JSON.stringify(raw)} is not a whole number of milliseconds.`);
  }
  const value = Number(trimmed);
  if (value < MIN_TIMEOUT_MS || value > MAX_TIMEOUT_MS) {
    throw new ConfigError(`${name}=${value} is outside ${MIN_TIMEOUT_MS}..${MAX_TIMEOUT_MS} ms.`);
  }
  return value;
}

export function loadTimeouts(): Timeouts {
  return {
    httpMs: parseTimeoutMs(TIMEOUT_ENV.httpMs, envValue(TIMEOUT_ENV.httpMs), DEFAULT_TIMEOUTS.httpMs),
    probeMs: parseTimeoutMs(TIMEOUT_ENV.probeMs, envValue(TIMEOUT_ENV.probeMs), DEFAULT_TIMEOUTS.probeMs),
    rpcMs: parseTimeoutMs(TIMEOUT_ENV.rpcMs, envValue(TIMEOUT_ENV.rpcMs), DEFAULT_TIMEOUTS.rpcMs),
  };
}

/** Threads whose queues the connector never starts or releases (comma or whitespace separated). */
export function loadParkedThreads(): Set<string> {
  const raw = envValue("T3_PARKED_THREADS") ?? "";
  return new Set(raw.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean));
}

/** Folder of the delivery journal (in-flight and uncertain sends). */
export function deliveryStateDir(): string {
  const override = envValue("T3_DELIVERY_STATE_DIR");
  if (override) return override;
  if (process.platform === "win32") {
    const base = process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local");
    return join(base, "OttoSystems", "t3code-mcp", "delivery");
  }
  const state = process.env.XDG_STATE_HOME || join(homedir(), ".local", "state");
  return join(state, "t3code-mcp", "delivery");
}

export function loadHttpToken(): string | undefined {
  if (process.env.MCP_HTTP_TOKEN) return process.env.MCP_HTTP_TOKEN;
  for (const path of dotEnvCandidates()) {
    if (existsSync(path)) {
      const env = parseDotEnv(path);
      if (env.MCP_HTTP_TOKEN) return env.MCP_HTTP_TOKEN;
    }
  }
  return undefined;
}
