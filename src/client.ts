import { discoverOrigin, loadToken, ConfigError } from "./config.js";
import type { ShellSnapshot, ThreadDetailSnapshot } from "./model.js";
import {
  PROTOCOL_HEADER,
  PROTOCOL_QUERY_PARAM,
  PROTOCOL_VERSION,
  detailFromV2,
  isV2Detail,
  isV2Shell,
  shellFromV2,
  type V2ThreadShell,
} from "./v2.js";

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
  private rpcSeq = 0;

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
          // Orchestration protocol 2: without it the orchestration routes answer HTTP 400.
          [PROTOCOL_HEADER]: PROTOCOL_VERSION,
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

  /**
   * Workspace shell in the legacy shape. Active threads come over HTTP; archived threads only
   * over the RPC archived snapshot, so they are fetched only when asked for.
   */
  async shell(opts: { includeArchived?: boolean } = {}): Promise<ShellSnapshot> {
    const raw = await this.req<unknown>("/api/orchestration/shell");
    if (!isV2Shell(raw)) return raw as ShellSnapshot;
    const archived = opts.includeArchived
      ? ((await this.rpc("orchestration.getArchivedShellSnapshot", {})) as { threads?: V2ThreadShell[] }).threads ?? []
      : [];
    return shellFromV2(raw, { archived });
  }

  /** Thread detail in the legacy shape. Protocol 2 returns the full projection; paging is client-side. */
  async thread(
    threadId: string,
    opts: { turnLimit?: number; beforeCursor?: string } = {},
  ): Promise<ThreadDetailSnapshot> {
    const raw = await this.req<unknown>(`/api/orchestration/threads/${encodeURIComponent(threadId)}`);
    if (!isV2Detail(raw)) return raw as ThreadDetailSnapshot;
    try {
      return detailFromV2(raw, opts);
    } catch (e) {
      throw new T3Error((e as Error).message);
    }
  }

  /** Send one orchestration command (protocol 2: WebSocket RPC orchestration.dispatchCommand). */
  async dispatch(command: Record<string, unknown>): Promise<DispatchResult> {
    return (await this.rpc("orchestration.dispatchCommand", command)) as DispatchResult;
  }

  /**
   * One Effect RPC request over a short-lived WebSocket (JSON frames, the server's layerJson):
   * send {_tag: "Request"}, wait for the matching {_tag: "Exit"}. The request frame goes out
   * only after the socket opens, so a failure before open means nothing was sent (notSent).
   */
  rpc(tag: string, payload: unknown, opts: { timeoutMs?: number } = {}): Promise<unknown> {
    const url = `${this.origin.replace(/^http/, "ws")}/ws?${PROTOCOL_QUERY_PARAM}=${PROTOCOL_VERSION}`;
    const timeoutMs = opts.timeoutMs ?? 30_000;
    const requestId = String(++this.rpcSeq);
    return new Promise((resolve, reject) => {
      let opened = false;
      let settled = false;
      const WS = WebSocket as unknown as new (url: string, init: { headers: Record<string, string> }) => WebSocket;
      const ws = new WS(url, { headers: { authorization: `Bearer ${this.token}` } });
      const finish = (err: T3Error | null, value?: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try {
          ws.close();
        } catch {
          // already closed
        }
        if (err) reject(err);
        else resolve(value);
      };
      const timer = setTimeout(
        () => finish(new T3Error(`T3 RPC ${tag} timed out after ${timeoutMs} ms.`, { notSent: !opened })),
        timeoutMs,
      );
      ws.onopen = () => {
        opened = true;
        ws.send(JSON.stringify({ _tag: "Request", id: requestId, tag, payload, headers: [] }));
      };
      ws.onmessage = (ev: MessageEvent) => {
        let frames: unknown[];
        try {
          const parsed = JSON.parse(String(ev.data));
          frames = Array.isArray(parsed) ? parsed : [parsed];
        } catch {
          return;
        }
        for (const f of frames as Array<Record<string, unknown>>) {
          if (f._tag === "Defect") return finish(new T3Error(`T3 RPC ${tag} failed: ${rpcDetail(f.defect)}`));
          if (f._tag !== "Exit" || f.requestId !== requestId) continue;
          const exit = f.exit as { _tag?: string; value?: unknown; cause?: unknown } | undefined;
          if (exit?._tag === "Success") return finish(null, exit.value);
          return finish(new T3Error(`T3 RPC ${tag} failed: ${rpcCauseDetail(exit?.cause)}`));
        }
      };
      ws.onerror = () => {
        finish(
          new T3Error(
            opened
              ? `T3 RPC ${tag}: the connection to ${this.origin} failed after the request was sent; it may have run.`
              : `Could not open the T3 Code RPC socket at ${this.origin}. Is T3 Code running, and is T3_TOKEN valid? ` +
                  `Start the desktop app or \`npx t3@latest\`.`,
            { notSent: !opened },
          ),
        );
      };
      ws.onclose = () => {
        finish(
          new T3Error(
            opened
              ? `T3 RPC ${tag}: the connection closed before T3 answered; the request may have run.`
              : `T3 Code closed the RPC socket at ${this.origin} before it opened.`,
            { notSent: !opened },
          ),
        );
      };
    });
  }
}

function rpcDetail(v: unknown): string {
  if (typeof v === "string") return v.slice(0, 500);
  const o = v as { message?: unknown; _tag?: unknown } | null;
  if (o && typeof o.message === "string") return o.message.slice(0, 500);
  return (JSON.stringify(v) ?? String(v)).slice(0, 500);
}

/** Effect Cause as encoded by the RPC JSON serializer: [{_tag: "Fail", error} | {_tag: "Die", defect} | ...]. */
function rpcCauseDetail(cause: unknown): string {
  const parts = (Array.isArray(cause) ? cause : [cause]).map((c) => {
    const x = c as { _tag?: string; error?: unknown; defect?: unknown } | null;
    if (x?._tag === "Fail") return rpcDetail(x.error);
    if (x?._tag === "Die") return rpcDetail(x.defect);
    if (x?._tag === "Interrupt") return "interrupted";
    return rpcDetail(c);
  });
  return parts.join("; ").slice(0, 800) || "unknown error";
}

/** Build a client from env/discovery. Throws ConfigError/T3Error with actionable messages. */
export function makeClient(): T3Client {
  return new T3Client(discoverOrigin(), loadToken());
}

export { ConfigError };
