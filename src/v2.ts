// T3 orchestration protocol 2 (T3 Code auto-update 2026-10-16). The server answers the
// orchestration HTTP routes only with the protocol header, returns V2 snapshots, and takes
// commands over the WebSocket RPC. This module maps V2 snapshots to the shapes the tools
// already use (model.ts) and builds V2 commands. Shapes checked against
// resources/server.asar (packages/contracts/src/orchestration*.ts) and the live server.
import type {
  Activity,
  LatestTurn,
  Message,
  ModelSelection,
  Project,
  Session,
  ShellSnapshot,
  ThreadDetailSnapshot,
  ThreadShell,
  TurnState,
} from "./model.js";
import { newId } from "./model.js";

export const PROTOCOL_HEADER = "x-t3-orchestration-protocol";
export const PROTOCOL_QUERY_PARAM = "orchestrationProtocol";
export const PROTOCOL_VERSION = "2";

/**
 * T3 releases an idle provider session after DEFAULT_IDLE_TIMEOUT_MS (18e5 ms = 30 min). The
 * V2 shell carries no session state, so a run that ended inside this window counts as a held
 * (ready) session for the launch cap.
 */
export const IDLE_RELEASE_MS = 30 * 60_000;

type Raw = Record<string, unknown>;

// ---------- V2 wire shapes (loose; only the fields read here) ----------

export interface V2ThreadShell {
  id: string;
  projectId: string;
  title: string;
  modelSelection?: ModelSelection | null;
  runtimeMode?: string;
  interactionMode?: string;
  branch?: string | null;
  worktreePath?: string | null;
  latestRunId?: string | null;
  latestRunRequestedAt?: string | null;
  latestRunStartedAt?: string | null;
  latestRunCompletedAt?: string | null;
  activeRunId?: string | null;
  activityRunStatus?: string | null;
  status?: string;
  lastError?: string | null;
  pendingRuntimeRequest?: { id: string; kind: string; createdAt?: string } | null;
  latestUserMessageAt?: string | null;
  hasActionableProposedPlan?: boolean;
  createdAt: string;
  updatedAt: string;
  archivedAt?: string | null;
  snoozedUntil?: string | null;
  pinnedAt?: string | null;
  deletedAt?: string | null;
}

export interface V2ShellSnapshot {
  schemaVersion: number;
  snapshotSequence: number;
  threads: V2ThreadShell[];
  archivedThreads?: V2ThreadShell[];
  projects: Project[];
}

interface V2Run {
  id: string;
  status: string;
  requestedAt?: string | null;
  startedAt?: string | null;
  completedAt?: string | null;
}

interface V2ProviderSession {
  id: string;
  providerInstanceId?: string;
  status: string;
  lastError?: string | null;
  updatedAt?: string;
}

interface V2RuntimeRequest {
  id: string;
  kind: string;
  status: string;
  createdAt: string;
}

interface V2Message {
  id: string;
  runId?: string | null;
  role: Message["role"];
  text: string;
  attachments?: unknown[];
  streaming?: boolean;
  createdAt: string;
  updatedAt: string;
}

type V2TurnItem = Raw & { id: string; type: string; ordinal?: number; title?: string | null; runId?: string | null };

export interface V2ThreadDetailSnapshot {
  snapshotSequence: number;
  projection: {
    thread: V2ThreadShell;
    runs?: V2Run[];
    providerSessions?: V2ProviderSession[];
    runtimeRequests?: V2RuntimeRequest[];
    messages?: V2Message[];
    turnItems?: V2TurnItem[];
  };
}

// ---------- detection ----------

export function isV2Shell(raw: unknown): raw is V2ShellSnapshot {
  return typeof raw === "object" && raw !== null && "schemaVersion" in raw && Array.isArray((raw as Raw).threads);
}

export function isV2Detail(raw: unknown): raw is V2ThreadDetailSnapshot {
  const p = (raw as Raw | null)?.projection as Raw | undefined;
  return typeof p === "object" && p !== null && typeof p.thread === "object";
}

// ---------- status mapping ----------

const ACTIVE_RUN = ["preparing", "queued", "starting", "running", "waiting"];
const STARTING_RUN = ["preparing", "queued", "starting"];

/** V2 run status -> legacy turn state. Unknown values -> undefined. */
export function turnStateOf(status: string | null | undefined): TurnState | undefined {
  if (!status) return undefined;
  if (ACTIVE_RUN.includes(status)) return "running";
  if (status === "completed") return "completed";
  if (status === "interrupted" || status === "cancelled" || status === "rolled_back") return "interrupted";
  if (status === "failed") return "error";
  return undefined;
}

function latestTurnFromShell(t: V2ThreadShell): LatestTurn | null {
  const state = turnStateOf(t.status);
  if (!t.latestRunId || !state) return null;
  return {
    turnId: t.latestRunId,
    state,
    requestedAt: t.latestRunRequestedAt ?? null,
    startedAt: t.latestRunStartedAt ?? null,
    completedAt: t.latestRunCompletedAt ?? null,
  };
}

/** The V2 shell has no session state; derive the closest legacy session (see IDLE_RELEASE_MS). */
function sessionFromShell(t: V2ThreadShell, now: number): Session | null {
  const base = { threadId: t.id, runtimeMode: t.runtimeMode, updatedAt: t.updatedAt };
  const activeTurnId = t.activeRunId ?? null;
  const runStatus = t.activityRunStatus ?? t.status ?? "idle";
  if (activeTurnId || t.pendingRuntimeRequest || ACTIVE_RUN.includes(runStatus)) {
    return { ...base, status: STARTING_RUN.includes(runStatus) ? "starting" : "running", activeTurnId, lastError: t.lastError ?? null };
  }
  if (!t.latestRunId) return null;
  if (t.status === "failed") return { ...base, status: "error", activeTurnId: null, lastError: t.lastError ?? null };
  const ended = Date.parse(t.latestRunCompletedAt ?? t.latestRunStartedAt ?? t.latestRunRequestedAt ?? "");
  const held = Number.isFinite(ended) && now - ended < IDLE_RELEASE_MS && turnStateOf(t.status) !== undefined;
  return { ...base, status: held ? "ready" : "stopped", activeTurnId: null, lastError: t.lastError ?? null };
}

export function threadShellFromV2(t: V2ThreadShell, now = Date.now()): ThreadShell {
  const pending = t.pendingRuntimeRequest ?? null;
  return {
    id: t.id,
    projectId: t.projectId,
    title: t.title ?? null,
    modelSelection: t.modelSelection ?? null,
    runtimeMode: t.runtimeMode,
    interactionMode: t.interactionMode,
    branch: t.branch ?? null,
    worktreePath: t.worktreePath ?? null,
    latestTurn: latestTurnFromShell(t),
    session: sessionFromShell(t, now),
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
    archivedAt: t.archivedAt ?? null,
    snoozedUntil: t.snoozedUntil ?? null,
    pinnedAt: t.pinnedAt ?? null,
    latestUserMessageAt: t.latestUserMessageAt ?? null,
    hasPendingApprovals: pending !== null && pending.kind !== "user_input",
    hasPendingUserInput: pending !== null && pending.kind === "user_input",
    hasActionableProposedPlan: t.hasActionableProposedPlan === true,
  };
}

/**
 * V2 shell -> legacy shell. Active and archived threads end up in one list (archived ones keep
 * archivedAt), deleted threads are dropped. `archived` adds threads from the RPC archived snapshot.
 */
export function shellFromV2(
  raw: V2ShellSnapshot,
  opts: { now?: number; archived?: V2ThreadShell[] } = {},
): ShellSnapshot {
  const now = opts.now ?? Date.now();
  const seen = new Set<string>();
  const threads: ThreadShell[] = [];
  for (const t of [...raw.threads, ...(raw.archivedThreads ?? []), ...(opts.archived ?? [])]) {
    if (t.deletedAt || seen.has(t.id)) continue;
    seen.add(t.id);
    threads.push(threadShellFromV2(t, now));
  }
  return {
    snapshotSequence: raw.snapshotSequence,
    projects: raw.projects ?? [],
    threads,
    updatedAt: new Date(now).toISOString(),
  };
}

// ---------- thread detail ----------

const LIVE_PROVIDER_SESSION = ["starting", "ready", "running", "waiting"];

function sessionFromDetail(t: V2ThreadShell, runs: V2Run[], sessions: V2ProviderSession[], activeRunId: string | null): Session | null {
  const live = sessions.filter((s) => LIVE_PROVIDER_SESSION.includes(s.status));
  const pick = live.at(-1) ?? sessions.at(-1);
  const base = { threadId: t.id, runtimeMode: t.runtimeMode, activeTurnId: activeRunId };
  if (pick) {
    return {
      ...base,
      status: pick.status === "waiting" ? "running" : pick.status,
      providerInstanceId: pick.providerInstanceId ?? null,
      providerName: pick.providerInstanceId ?? null,
      lastError: pick.lastError ?? t.lastError ?? null,
      updatedAt: pick.updatedAt,
    };
  }
  // Detached sessions leave the projection: a thread that ran but has none is stopped.
  if (runs.length > 0) return { ...base, status: "stopped", lastError: t.lastError ?? null };
  return null;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

/** Turn items -> legacy activities: tool items, errors, and approval / user-input requests. */
function activitiesFromItems(items: V2TurnItem[], requests: V2RuntimeRequest[]): Activity[] {
  const out: Activity[] = [];
  const requested = new Set<string>();
  const sorted = [...items].sort((a, b) => (a.ordinal ?? 0) - (b.ordinal ?? 0));
  const at = (i: V2TurnItem) => str(i.startedAt) ?? str(i.updatedAt) ?? new Date(0).toISOString();
  for (const i of sorted) {
    const base = { id: i.id, turnId: i.runId ?? null, createdAt: at(i) };
    switch (i.type) {
      case "approval_request": {
        const requestId = str(i.requestId);
        if (!requestId) break;
        requested.add(requestId);
        out.push({
          ...base,
          tone: "approval",
          kind: "approval.requested",
          summary: str(i.title) ?? str(i.prompt) ?? null,
          payload: { requestId, requestKind: i.requestKind, detail: { prompt: i.prompt ?? null, appName: i.appName ?? null, options: i.options ?? null } },
        });
        break;
      }
      case "user_input_request": {
        const requestId = str(i.requestId);
        if (!requestId) break;
        requested.add(requestId);
        out.push({
          ...base,
          tone: "approval",
          kind: "user-input.requested",
          summary: str(i.title) ?? null,
          payload: { requestId, questions: i.questions ?? [] },
        });
        break;
      }
      case "command_execution":
      case "file_change":
      case "file_search":
      case "web_search":
      case "dynamic_tool":
        out.push({
          ...base,
          tone: "tool",
          kind: `tool.${i.type}`,
          summary: str(i.title) ?? str(i.input) ?? str(i.fileName) ?? str(i.pattern) ?? str(i.toolName) ?? null,
          payload: null,
        });
        break;
      case "error":
        out.push({
          ...base,
          tone: "error",
          kind: "error",
          summary: str((i.failure as Raw | undefined)?.message) ?? str(i.title) ?? null,
          payload: null,
        });
        break;
    }
  }
  // Runtime requests are the source of truth for open/closed.
  for (const r of requests) {
    const kind = r.kind === "user_input" ? "user-input" : "approval";
    if (!requested.has(r.id)) {
      out.push({
        id: `request:${r.id}`,
        tone: "approval",
        kind: `${kind}.requested`,
        summary: null,
        payload: { requestId: r.id, requestKind: r.kind },
        createdAt: r.createdAt,
      });
    }
    if (r.status !== "pending") {
      out.push({
        id: `resolved:${r.id}`,
        tone: "info",
        kind: `${kind}.resolved`,
        summary: null,
        payload: { requestId: r.id },
        createdAt: r.createdAt,
      });
    }
  }
  return out;
}

const CURSOR_PREFIX = "m:";

/** Keep the last turnLimit turns (a turn starts at a user message) before the cursor. */
function pageMessages(messages: Message[], turnLimit: number | undefined, beforeCursor: string | undefined) {
  let end = messages.length;
  if (beforeCursor) {
    const id = beforeCursor.startsWith(CURSOR_PREFIX) ? beforeCursor.slice(CURSOR_PREFIX.length) : "";
    end = messages.findIndex((m) => m.id === id);
    if (end < 0) throw new Error(`Unknown beforeCursor ${beforeCursor}: page again from the latest turn.`);
  }
  let start = 0;
  if (turnLimit !== undefined) {
    let turns = 0;
    start = end;
    while (start > 0) {
      start--;
      if (messages[start].role === "user" && ++turns >= turnLimit) break;
    }
  }
  const hasMore = start > 0;
  return {
    messages: messages.slice(start, end),
    page: { beforeCursor: hasMore ? `${CURSOR_PREFIX}${messages[start].id}` : null, hasMore },
  };
}

export interface DetailOptions {
  turnLimit?: number;
  beforeCursor?: string;
  now?: number;
}

/** V2 thread detail -> legacy detail, plus activeRunId and providerSessionIds for commands. */
export function detailFromV2(raw: V2ThreadDetailSnapshot, opts: DetailOptions): ThreadDetailSnapshot {
  const p = raw.projection;
  const t = p.thread;
  const runs = p.runs ?? [];
  const sessions = p.providerSessions ?? [];
  const requests = p.runtimeRequests ?? [];
  const lastRun = runs.at(-1);
  const activeRun = [...runs].reverse().find((r) => ACTIVE_RUN.includes(r.status));
  const activeRunId = activeRun?.id ?? t.activeRunId ?? null;
  const allMessages: Message[] = (p.messages ?? []).map((m) => ({
    id: m.id,
    role: m.role,
    text: m.text ?? "",
    attachments: m.attachments ?? [],
    turnId: m.runId ?? null,
    streaming: m.streaming === true,
    createdAt: m.createdAt,
    updatedAt: m.updatedAt,
  }));
  const { messages, page } = pageMessages(allMessages, opts.turnLimit, opts.beforeCursor);
  const lastState = turnStateOf(lastRun?.status);
  const shell = threadShellFromV2(t, opts.now);
  const pendingKinds = requests.filter((r) => r.status === "pending").map((r) => r.kind);
  return {
    snapshotSequence: raw.snapshotSequence,
    thread: {
      ...shell,
      latestTurn:
        lastRun && lastState
          ? { turnId: lastRun.id, state: lastState, requestedAt: lastRun.requestedAt ?? null, startedAt: lastRun.startedAt ?? null, completedAt: lastRun.completedAt ?? null }
          : shell.latestTurn,
      session: sessionFromDetail(t, runs, sessions, activeRunId),
      hasPendingApprovals: shell.hasPendingApprovals || pendingKinds.some((k) => k !== "user_input"),
      hasPendingUserInput: shell.hasPendingUserInput || pendingKinds.includes("user_input"),
      activeRunId,
      providerSessionIds: sessions.map((s) => s.id),
      messages,
      activities: activitiesFromItems(p.turnItems ?? [], requests),
    },
    page,
  };
}

// ---------- commands ----------

/** Who and what created a command: an MCP client acting for the user. */
const CREATION = { createdBy: "user", creationSource: "mcp" } as const;

export const commands = {
  messageDispatch(a: { threadId: string; text: string }) {
    return {
      type: "message.dispatch",
      ...CREATION,
      commandId: newId(),
      threadId: a.threadId,
      messageId: newId(),
      text: a.text,
      attachments: [],
      // The server queues a start_immediately message behind an active run.
      dispatchMode: { type: "start_immediately" },
    };
  },
  threadCreate(a: {
    threadId: string;
    projectId: string;
    title: string;
    modelSelection: ModelSelection;
    runtimeMode: string;
    interactionMode: string;
  }) {
    return {
      type: "thread.create",
      ...CREATION,
      commandId: newId(),
      threadId: a.threadId,
      projectId: a.projectId,
      title: a.title,
      modelSelection: a.modelSelection,
      runtimeMode: a.runtimeMode,
      interactionMode: a.interactionMode,
      branch: null,
      worktreePath: null,
    };
  },
  runInterrupt: (threadId: string, runId: string) => ({ type: "run.interrupt", commandId: newId(), threadId, runId }),
  detachSession: (threadId: string, providerSessionId: string) => ({
    type: "provider-session.detach",
    commandId: newId(),
    threadId,
    providerSessionId,
    reason: "client-requested",
  }),
  respondApproval: (threadId: string, requestId: string, decision: string) => ({
    type: "runtime-request.respond",
    commandId: newId(),
    threadId,
    requestId,
    decision,
  }),
  respondUserInput: (threadId: string, requestId: string, answers: Record<string, unknown>) => ({
    type: "runtime-request.respond",
    commandId: newId(),
    threadId,
    requestId,
    answers,
  }),
  setTitle: (threadId: string, title: string) => ({ type: "thread.metadata.update", commandId: newId(), threadId, title }),
  setRuntimeMode: (threadId: string, runtimeMode: string) => ({ type: "thread.runtime-mode.set", commandId: newId(), threadId, runtimeMode }),
  setInteractionMode: (threadId: string, interactionMode: string) => ({
    type: "thread.interaction-mode.set",
    commandId: newId(),
    threadId,
    interactionMode,
  }),
  archive: (threadId: string) => ({ type: "thread.archive", commandId: newId(), threadId }),
  unarchive: (threadId: string) => ({ type: "thread.unarchive", commandId: newId(), threadId }),
};
