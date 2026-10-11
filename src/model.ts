// Loose mirrors of T3 Code wire shapes (packages/contracts/src/orchestration.ts).
// Parsed defensively: unknown fields ignored, optional fields may be absent on
// older/newer server versions.

export interface ServerRuntime {
  version: number;
  pid: number;
  host: string;
  port: number;
  origin: string;
  startedAt: string;
}

export interface ModelSelection {
  instanceId: string;
  model: string;
  options?: Array<{ id: string; value: unknown }> | Record<string, unknown>;
}

export type TurnState = "running" | "interrupted" | "completed" | "error";

export interface LatestTurn {
  turnId: string;
  state: TurnState;
  requestedAt?: string | null;
  startedAt?: string | null;
  completedAt?: string | null;
  assistantMessageId?: string | null;
}

export interface Session {
  threadId: string;
  status:
    | "idle"
    | "starting"
    | "running"
    | "ready"
    | "interrupted"
    | "stopped"
    | "error"
    | (string & {});
  providerName?: string | null;
  providerInstanceId?: string | null;
  runtimeMode?: string;
  activeTurnId?: string | null;
  lastError?: unknown;
  updatedAt?: string;
}

export interface ThreadShell {
  id: string;
  projectId: string;
  title: string | null;
  modelSelection?: ModelSelection | null;
  runtimeMode?: string;
  interactionMode?: string;
  branch?: string | null;
  worktreePath?: string | null;
  latestTurn?: LatestTurn | null;
  session?: Session | null;
  createdAt: string;
  updatedAt: string;
  archivedAt?: string | null;
  snoozedUntil?: string | null;
  pinnedAt?: string | null;
  latestUserMessageAt?: string | null;
  hasPendingApprovals?: boolean;
  hasPendingUserInput?: boolean;
  hasActionableProposedPlan?: boolean;
  backgroundLiveness?: "working" | "monitoring" | null;
  planProgress?: { step?: string | null; completedSteps: number; totalSteps: number } | null;
}

export interface Project {
  id: string;
  title: string;
  workspaceRoot: string;
  defaultModelSelection?: ModelSelection | null;
  defaultThreadEnvMode?: "local" | "worktree";
  createdAt?: string;
  updatedAt?: string;
  deletedAt?: string | null;
}

export interface ShellSnapshot {
  snapshotSequence: number;
  projects: Project[];
  threads: ThreadShell[];
  updatedAt: string;
}

export interface Message {
  id: string;
  role: "user" | "assistant" | "system";
  text: string;
  attachments?: unknown[];
  turnId?: string | null;
  streaming?: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface Activity {
  id: string;
  tone: "info" | "tool" | "approval" | "error" | (string & {});
  kind: string;
  summary?: string | null;
  payload?: Record<string, unknown> | null;
  turnId?: string | null;
  createdAt: string;
}

export interface ThreadDetail extends ThreadShell {
  messages: Message[];
  activities: Activity[];
  proposedPlans?: unknown[];
  checkpoints?: unknown[];
}

export interface ThreadDetailSnapshot {
  snapshotSequence: number;
  thread: ThreadDetail;
  page?: { beforeCursor?: string | null; hasMore?: boolean } & Record<string, unknown>;
}

export type Attention =
  | "needs-approval"
  | "needs-input"
  | "plan-ready"
  | "working"
  | "error"
  | "done"
  | "idle";

/** Collapse a thread's state into the single question: does it need me? */
export function attentionOf(t: ThreadShell): Attention {
  if (t.hasPendingApprovals) return "needs-approval";
  if (t.hasPendingUserInput) return "needs-input";
  if (t.session?.status === "error" || t.latestTurn?.state === "error") return "error";
  if (t.hasActionableProposedPlan) return "plan-ready";
  if (t.latestTurn?.state === "running" || t.session?.status === "running") return "working";
  if (t.latestTurn?.state === "completed" || t.latestTurn?.state === "interrupted") return "done";
  return "idle";
}

export interface PendingRequest {
  requestId: string;
  kind: "approval" | "user-input";
  requestKind?: string; // command | file-read | file-change (approvals)
  summary?: string | null;
  detail?: unknown;
  turnId?: string | null;
  createdAt: string;
}

/**
 * Open approval / user-input requests are derived by folding `*.requested`
 * activities against `*.resolved` ones (same reducer the T3 web UI uses).
 */
export function pendingRequests(activities: Activity[]): PendingRequest[] {
  const open = new Map<string, PendingRequest>();
  for (const a of activities) {
    const p = a.payload ?? {};
    const requestId = typeof p.requestId === "string" ? p.requestId : undefined;
    if (!requestId) continue;
    if (a.kind === "approval.requested" || a.kind === "user-input.requested") {
      open.set(requestId, {
        requestId,
        kind: a.kind === "approval.requested" ? "approval" : "user-input",
        requestKind: typeof p.requestKind === "string" ? p.requestKind : undefined,
        summary: a.summary ?? null,
        detail: p.detail ?? p.questions ?? p,
        turnId: a.turnId ?? null,
        createdAt: a.createdAt,
      });
    } else if (a.kind === "approval.resolved" || a.kind === "user-input.resolved") {
      open.delete(requestId);
    }
  }
  return [...open.values()];
}

export function newId(): string {
  return crypto.randomUUID();
}

export function nowIso(): string {
  return new Date().toISOString();
}
