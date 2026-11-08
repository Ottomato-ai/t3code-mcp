import { discoverOrigin, loadToken, loadTimeouts, ConfigError, DEFAULT_TIMEOUTS, type Timeouts } from "./config.js";
import type { ShellSnapshot, ThreadDetailSnapshot } from "./model.js";
import {
  PROTOCOL_HEADER,
  PROTOCOL_QUERY_PARAM,
  PROTOCOL_VERSION,
  detailFromV2,
  isV2Detail,
  isV2Shell,
  shellFromV2,
  type V2ThreadDetailSnapshot,
  type V2ThreadShell,
} from "./v2.js";
import {
  MalformedResponseError,
  assertArchivedSnapshot,
  assertDispatchResult,
  assertShellSnapshot,
  assertThreadDetail,
} from "./validate.js";

/**
 * What a failed call says about its effect on T3:
 * - `not_sent`: the request never reached T3 (connection refused, socket never opened).
 * - `rejected`: proven not applied: an HTTP error on a read, an authorization refusal (checked
 *   before T3 runs the command), or T3's receipt answering a replay with "previously rejected".
 * - `ambiguous`: anything else after the request was sent: no answer (timeout, socket closed), a
 *   defect, or a failure exit. T3 commits a command's receipt before some of its follow-up work
 *   (e.g. starting a queued run), so a failure answer alone does not prove nothing changed.
 *   Reconcile (state, then a replay with the same commandId) before acting on it again.
 */
export type T3Outcome = "not_sent" | "rejected" | "ambiguous";

export class T3Error extends Error {
  readonly outcome: T3Outcome;
  /** Error tag or code T3 sent, when it sent one. */
  readonly code: string | undefined;
  /** HTTP status, for HTTP reads. */
  readonly status: number | undefined;
  /** T3 sent an answer (a failure exit or defect), as opposed to no answer at all. */
  readonly answered: boolean;
  constructor(
    message: string,
    opts: { notSent?: boolean; outcome?: T3Outcome; code?: string; status?: number; answered?: boolean } = {},
  ) {
    super(message);
    this.outcome = opts.outcome ?? (opts.notSent ? "not_sent" : "ambiguous");
    this.code = opts.code;
    this.status = opts.status;
    this.answered = opts.answered ?? false;
  }
  /** True when the request never reached the server (connection refused): nothing was sent. */
  get notSent(): boolean {
    return this.outcome === "not_sent";
  }
}

/** A dispatch that failed this way did not reach T3, so nothing can have started. */
export function wasNotSent(e: unknown): boolean {
  return e instanceof T3Error && e.notSent;
}

/** T3 definitively did not apply the command (refused connection or an explicit rejection). */
export function definitelyNotApplied(e: unknown): boolean {
  return e instanceof T3Error && (e.outcome === "not_sent" || e.outcome === "rejected");
}

/**
 * T3's receipt says this command id was rejected and never applied. This is the only proof that
 * holds for a retry or replay of an earlier, unproven send: a refused connection or an
 * authorization refusal only proves that this attempt was not applied, not the original.
 */
export function rejectedByReceipt(e: unknown): boolean {
  return e instanceof T3Error && e.outcome === "rejected" && /\bwas previously rejected\b/.test(e.message);
}

/** The command may have been applied: only a T3Error marked ambiguous says so. */
export function isAmbiguous(e: unknown): boolean {
  return e instanceof T3Error && e.outcome === "ambiguous";
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

/** A raw protocol 2 thread projection and where it came from. */
export interface ProjectionRead {
  snapshot: V2ThreadDetailSnapshot;
  /** `bounded`: the server's bounded window (all queued and active runs, recent history). */
  source: "bounded" | "full";
  /** The bounded window leaves out older history. */
  hasMoreHistory: boolean;
}

export class T3Client {
  private rpcSeq = 0;
  /** Unset until a bounded read answers; false once the server proved it has no bounded route. */
  private boundedSupported: boolean | undefined;
  readonly timeouts: Readonly<Timeouts>;

  constructor(
    readonly origin: string,
    private readonly token: string,
    timeouts: Partial<Timeouts> = {},
  ) {
    this.timeouts = Object.freeze({ ...DEFAULT_TIMEOUTS, ...timeouts });
  }

  private async req(path: string, init?: RequestInit & { timeoutMs?: number }): Promise<unknown> {
    const timeoutMs = init?.timeoutMs ?? this.timeouts.httpMs;
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
        signal: init?.signal ?? AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      const timedOut = (e as Error)?.name === "TimeoutError";
      throw new T3Error(
        timedOut
          ? `T3 API ${path} did not answer within ${timeoutMs} ms${timeoutMs === this.timeouts.httpMs ? " (T3_HTTP_TIMEOUT_MS)" : " (deadline of the calling tool)"}.`
          : `Could not reach the T3 Code server at ${this.origin} (${(e as Error).message}). ` +
              `Is T3 Code running? Start the desktop app or \`npx t3@latest\`.`,
        { notSent: refused(e), code: timedOut ? "timeout" : undefined },
      );
    }
    if (res.status === 401 || res.status === 403) {
      const body = await res.text().catch(() => "");
      throw new T3Error(
        `T3 Code rejected the auth token (${res.status}${body ? `: ${body.slice(0, 200)}` : ""}). ` +
          `Mint a fresh one with \`npx t3@latest auth session issue --token-only --label t3code-mcp --ttl 365d\` ` +
          `and update T3_TOKEN.`,
        { outcome: "rejected", status: res.status },
      );
    }
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new T3Error(`T3 API ${path} failed: HTTP ${res.status} ${body.slice(0, 500)}`, {
        outcome: "rejected",
        status: res.status,
      });
    }
    const text = await res.text();
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new T3Error(`T3 API ${path} answered with a body that is not JSON: ${text.slice(0, 200)}`, {
        outcome: "rejected",
        code: "malformed_response",
        status: res.status,
      });
    }
  }

  private malformed(e: unknown): never {
    if (e instanceof MalformedResponseError) {
      throw new T3Error(e.message, { outcome: "rejected", code: "malformed_response" });
    }
    throw e;
  }

  /** Unauthenticated liveness + identity probe. */
  async probe(): Promise<EnvironmentInfo> {
    let res: Response;
    try {
      res = await fetch(`${this.origin}/.well-known/t3/environment`, {
        signal: AbortSignal.timeout(this.timeouts.probeMs),
      });
    } catch (e) {
      throw new T3Error(
        `T3 Code server at ${this.origin} is not responding (${(e as Error).message}; ` +
          `probe timeout ${this.timeouts.probeMs} ms, T3_PROBE_TIMEOUT_MS). Start the desktop app or \`npx t3@latest\`.`,
        { notSent: refused(e) },
      );
    }
    if (!res.ok) throw new T3Error(`T3 probe failed: HTTP ${res.status}`, { outcome: "rejected", status: res.status });
    return (await res.json()) as EnvironmentInfo;
  }

  /**
   * Workspace shell in the legacy shape. Active threads come over HTTP; archived threads only
   * over the RPC archived snapshot, so they are fetched only when asked for. A malformed answer
   * (missing lists, threads without ids or times) is an error, never an empty workspace.
   */
  async shell(opts: { includeArchived?: boolean } = {}): Promise<ShellSnapshot> {
    const raw = await this.req("/api/orchestration/shell");
    try {
      assertShellSnapshot(raw);
    } catch (e) {
      this.malformed(e);
    }
    if (!isV2Shell(raw)) return raw as ShellSnapshot;
    let archived: V2ThreadShell[] = [];
    if (opts.includeArchived) {
      const result = await this.rpc("orchestration.getArchivedShellSnapshot", {});
      try {
        assertArchivedSnapshot(result);
      } catch (e) {
        this.malformed(e);
      }
      archived = result.threads as unknown as V2ThreadShell[];
    }
    return shellFromV2(raw, { archived });
  }

  /**
   * GET a thread snapshot: the bounded window when asked and supported, else the full projection.
   * A 404 from the bounded route is either "no such route" (an older server) or "no such
   * thread"; the full read tells them apart, and only a successful full read marks the bounded
   * route as unsupported.
   */
  private async readDetail(
    threadId: string,
    bounded: boolean,
    timeoutMs?: number,
  ): Promise<{ raw: unknown; source: "bounded" | "full" }> {
    const base = `/api/orchestration/threads/${encodeURIComponent(threadId)}`;
    // One deadline for the whole read, fallback included.
    const deadline = Date.now() + (timeoutMs ?? this.timeouts.httpMs);
    if (bounded && this.boundedSupported !== false) {
      try {
        const raw = await this.req(`${base}/bounded`, { timeoutMs });
        this.boundedSupported = true;
        return { raw, source: "bounded" };
      } catch (e) {
        if (!(e instanceof T3Error && e.status === 404)) throw e;
        const left = deadline - Date.now();
        if (left <= 0) {
          throw new T3Error(`T3 API ${base} was not read: the read's deadline passed during the bounded-route fallback.`, { code: "timeout" });
        }
        const raw = await this.req(base, { timeoutMs: left });
        if (this.boundedSupported === undefined) this.boundedSupported = false;
        return { raw, source: "full" };
      }
    }
    return { raw: await this.req(base, { timeoutMs }), source: "full" };
  }

  /**
   * The raw protocol 2 projection of one thread. `bounded` asks for the server's bounded window
   * (`/api/orchestration/threads/:id/bounded`): it always carries every queued and active run
   * with its user message, the provider sessions and runtime requests, plus recent history, so
   * queue and run-state reads do not pull the whole history. A server without that route falls
   * back to the full projection, and is remembered.
   */
  async projection(threadId: string, opts: { bounded?: boolean; timeoutMs?: number } = {}): Promise<ProjectionRead> {
    const { raw, source } = await this.readDetail(threadId, opts.bounded === true, opts.timeoutMs);
    const what = source === "bounded" ? "bounded thread snapshot" : "thread snapshot";
    const snapshot = this.checkedDetail(raw, what);
    return { snapshot, source, hasMoreHistory: source === "bounded" && (raw as { hasMoreHistory?: unknown }).hasMoreHistory === true };
  }

  private checkedDetail(raw: unknown, what: string): V2ThreadDetailSnapshot {
    try {
      assertThreadDetail(raw, what);
    } catch (e) {
      this.malformed(e);
    }
    if (!isV2Detail(raw)) {
      throw new T3Error(`T3 returned a ${what} without a protocol 2 projection.`, {
        outcome: "rejected",
        code: "malformed_response",
      });
    }
    return raw;
  }

  /**
   * Thread detail in the legacy shape. `window: "bounded"` reads the bounded snapshot (enough
   * for run state, queue, pending requests and the latest turns); the default reads the full
   * projection, which paging back through history needs.
   */
  async thread(
    threadId: string,
    opts: { turnLimit?: number; beforeCursor?: string; window?: "bounded" | "full" } = {},
  ): Promise<ThreadDetailSnapshot> {
    const { raw, source } = await this.readDetail(threadId, opts.window === "bounded" && opts.beforeCursor === undefined);
    try {
      assertThreadDetail(raw);
    } catch (e) {
      this.malformed(e);
    }
    if (!isV2Detail(raw)) return raw as ThreadDetailSnapshot;
    try {
      const detail = detailFromV2(raw, opts);
      if (source === "bounded" && (raw as { hasMoreHistory?: unknown }).hasMoreHistory === true && detail.page) {
        // Older history exists beyond the window; paging continues on the full projection.
        detail.page = { ...detail.page, hasMore: true };
      }
      return detail;
    } catch (e) {
      throw new T3Error((e as Error).message);
    }
  }

  /** Send one orchestration command (protocol 2: WebSocket RPC orchestration.dispatchCommand). */
  async dispatch(command: Record<string, unknown>, opts: { timeoutMs?: number; sendBy?: number } = {}): Promise<DispatchResult> {
    const result = await this.rpc("orchestration.dispatchCommand", command, opts);
    try {
      assertDispatchResult(result);
    } catch (e) {
      // T3 answered, but not with a result: whether the command ran is unknown.
      throw new T3Error((e as Error).message, { outcome: "ambiguous", code: "malformed_response" });
    }
    return result;
  }

  /**
   * One Effect RPC request over a short-lived WebSocket (JSON frames, the server's layerJson):
   * send {_tag: "Request"}, wait for the matching {_tag: "Exit"}. The request frame goes out
   * only after the socket opens, so a failure before open means nothing was sent (not_sent); an
   * Exit failure or a Defect is T3's answer (rejected); silence or a drop after the send is
   * ambiguous. With `sendBy` (epoch ms), a socket that opens later sends nothing (not_sent).
   */
  rpc(tag: string, payload: unknown, opts: { timeoutMs?: number; sendBy?: number } = {}): Promise<unknown> {
    const url = `${this.origin.replace(/^http/, "ws")}/ws?${PROTOCOL_QUERY_PARAM}=${PROTOCOL_VERSION}`;
    const timeoutMs = opts.timeoutMs ?? this.timeouts.rpcMs;
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
        () =>
          finish(
            new T3Error(
              opened
                ? `T3 RPC ${tag} timed out after ${timeoutMs} ms (T3_RPC_TIMEOUT_MS); the request was sent and may have run.`
                : `T3 RPC ${tag} timed out after ${timeoutMs} ms before the socket opened; nothing was sent.`,
              { outcome: opened ? "ambiguous" : "not_sent", code: "timeout" },
            ),
          ),
        timeoutMs,
      );
      ws.onopen = () => {
        if (opts.sendBy !== undefined && Date.now() > opts.sendBy) {
          finish(
            new T3Error(`T3 RPC ${tag} was not sent: the socket opened after the send deadline.`, {
              outcome: "not_sent",
              code: "deadline",
            }),
          );
          return;
        }
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
          if (f._tag === "Defect") {
            return finish(new T3Error(`T3 RPC ${tag} failed: ${rpcDetail(f.defect)}`, { outcome: "ambiguous", code: "defect", answered: true }));
          }
          if (f._tag !== "Exit" || f.requestId !== requestId) continue;
          const exit = f.exit as { _tag?: string; value?: unknown; cause?: unknown } | undefined;
          if (exit?._tag === "Success") return finish(null, exit.value);
          const detail = rpcCauseDetail(exit?.cause);
          const code = rpcCauseTag(exit?.cause);
          return finish(
            new T3Error(`T3 RPC ${tag} failed: ${detail}`, {
              outcome: provenNotApplied(code, detail) ? "rejected" : "ambiguous",
              code,
              answered: true,
            }),
          );
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

/** The tag of the first typed failure (e.g. OrchestrationV2DispatchCommandError). */
function rpcCauseTag(cause: unknown): string | undefined {
  for (const c of Array.isArray(cause) ? cause : [cause]) {
    const x = c as { _tag?: string; error?: { _tag?: unknown } } | null;
    if (x?._tag === "Fail" && typeof x.error?._tag === "string") return x.error._tag;
    if (x?._tag === "Die") return "defect";
  }
  return undefined;
}

/**
 * Failure answers that prove a command was not applied. An authorization refusal happens before
 * T3 runs the command. "Command <id> was previously rejected" is T3 answering from its receipt
 * (Orchestrator.dispatchWithReceipt): the command id was recorded as rejected and never applied.
 */
export function provenNotApplied(code: string | undefined, detail: string): boolean {
  if (code === "EnvironmentAuthorizationError") return true;
  return /\bwas previously rejected\b/.test(detail);
}

/** Build a client from env/discovery. Throws ConfigError/T3Error with actionable messages. */
export function makeClient(): T3Client {
  return new T3Client(discoverOrigin(), loadToken(), loadTimeouts());
}

export { ConfigError };
