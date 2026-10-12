import { discoverOrigin, loadToken, ConfigError } from "./config.js";
import type { ShellSnapshot, ThreadDetailSnapshot } from "./model.js";

export class T3Error extends Error {
  /** True when the request never reached the server (connection refused): nothing was sent. */
  readonly notSent: boolean;
  constructor(message: string, opts: { notSent?: boolean } = {}) {
    super(message);
    this.notSent = opts.notSent ?? false;
  }
}

/** A dispatch that failed this way did not reach T3, so nothing can have started. */
export function wasNotSent(e: unknown): boolean {
  return e instanceof T3Error && e.notSent;
}

/** fetch rejects with a cause; connection refused (also inside an AggregateError) means not sent. */
export function refused(e: unknown): boolean {
  const cause = (e as { cause?: { code?: string; errors?: Array<{ code?: string }> } })?.cause;
  if (!cause) return false;
  if (cause.code === "ECONNREFUSED") return true;
  return Array.isArray(cause.errors) && cause.errors.length > 0 && cause.errors.every((x) => x?.code === "ECONNREFUSED");
}

export interface EnvironmentInfo {
  environmentId: string;
  label: string;
  serverVersion: string;
  platform?: Record<string, unknown>;
}

export interface DispatchResult {
  sequence: number;
}

export class T3Client {
  constructor(
    readonly origin: string,
    private readonly token: string,
  ) {}

  private async req<T>(path: string, init?: RequestInit): Promise<T> {
    let res: Response;
    try {
      res = await fetch(`${this.origin}${path}`, {
        ...init,
        headers: {
          authorization: `Bearer ${this.token}`,
          ...(init?.body ? { "content-type": "application/json" } : {}),
          ...init?.headers,
        },
        signal: init?.signal ?? AbortSignal.timeout(30_000),
      });
    } catch (e) {
      throw new T3Error(
        `Could not reach the T3 Code server at ${this.origin} (${(e as Error).message}). ` +
          `Is T3 Code running? Start the desktop app or \`npx t3@latest\`.`,
        { notSent: refused(e) },
      );
    }
    if (res.status === 401 || res.status === 403) {
      const body = await res.text().catch(() => "");
      throw new T3Error(
        `T3 Code rejected the auth token (${res.status}${body ? `: ${body.slice(0, 200)}` : ""}). ` +
          `Mint a fresh one with \`npx t3@latest auth session issue --token-only --label t3code-mcp --ttl 365d\` ` +
          `and update T3_TOKEN.`,
      );
    }
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new T3Error(`T3 API ${path} failed: HTTP ${res.status} ${body.slice(0, 500)}`);
    }
    return (await res.json()) as T;
  }

  /** Unauthenticated liveness + identity probe. */
  async probe(): Promise<EnvironmentInfo> {
    let res: Response;
    try {
      res = await fetch(`${this.origin}/.well-known/t3/environment`, {
        signal: AbortSignal.timeout(3_000),
      });
    } catch (e) {
      throw new T3Error(
        `T3 Code server at ${this.origin} is not responding (${(e as Error).message}). ` +
          `Start the desktop app or \`npx t3@latest\`.`,
      );
    }
    if (!res.ok) throw new T3Error(`T3 probe failed: HTTP ${res.status}`);
    return (await res.json()) as EnvironmentInfo;
  }

  shell(): Promise<ShellSnapshot> {
    return this.req<ShellSnapshot>("/api/orchestration/shell");
  }

  thread(
    threadId: string,
    opts: { turnLimit?: number; beforeCursor?: string } = {},
  ): Promise<ThreadDetailSnapshot> {
    const params = new URLSearchParams();
    if (opts.turnLimit !== undefined) params.set("turnLimit", String(opts.turnLimit));
    if (opts.beforeCursor) params.set("beforeCursor", opts.beforeCursor);
    const qs = params.size ? `?${params}` : "";
    return this.req<ThreadDetailSnapshot>(
      `/api/orchestration/threads/${encodeURIComponent(threadId)}${qs}`,
    );
  }

  dispatch(command: Record<string, unknown>): Promise<DispatchResult> {
    return this.req<DispatchResult>("/api/orchestration/dispatch", {
      method: "POST",
      body: JSON.stringify(command),
    });
  }
}

/** Build a client from env/discovery. Throws ConfigError/T3Error with actionable messages. */
export function makeClient(): T3Client {
  return new T3Client(discoverOrigin(), loadToken());
}

export { ConfigError };
