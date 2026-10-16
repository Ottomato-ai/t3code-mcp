// Synthetic orchestration protocol 2 payloads. Key sets follow the live T3 server
// (OrchestrationV2ThreadShell, OrchestrationV2ThreadDetailSnapshot); values are made up.
import { createHash } from "node:crypto";

export const NOW = Date.parse("2026-10-16T12:00:00Z");
export const iso = (msAgo) => new Date(NOW - msAgo).toISOString();
export const MIN = 60_000;

export function v2Thread(over = {}) {
  return {
    createdBy: "user",
    creationSource: "web",
    id: "t-1",
    projectId: "p1",
    title: "synthetic thread",
    providerInstanceId: "codex",
    modelSelection: { instanceId: "codex", model: "model-a" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    linkedPullRequest: null,
    pullRequests: [],
    branchPullRequest: null,
    lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: over.id ?? "t-1" },
    forkedFrom: null,
    activeProviderThreadId: null,
    historyOrigin: "native",
    latestRunId: null,
    latestRunRequestedAt: null,
    latestRunStartedAt: null,
    latestRunCompletedAt: null,
    activeRunId: null,
    activityRunStartedAt: null,
    activityRunStatus: null,
    status: "idle",
    lastError: null,
    lastErrorClass: null,
    usageLimitResetAt: null,
    pendingRuntimeRequest: null,
    latestVisibleMessage: null,
    latestUserMessageAt: null,
    latestUserAuthoredMessageAt: null,
    hasActionableProposedPlan: false,
    pendingBackgroundTasks: [],
    providerInstanceHistory: [],
    goal: null,
    itemCount: 0,
    visibleItemCount: 0,
    createdAt: iso(120 * MIN),
    updatedAt: iso(60 * MIN),
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    unsettledAt: null,
    snoozedUntil: null,
    snoozedAt: null,
    limitRecovery: null,
    pinnedAt: null,
    autoSettleDisabledAt: null,
    pinOrderKey: null,
    activeOrderKey: null,
    lastVisitedAt: null,
    titleRegeneration: null,
    deletedAt: null,
    ...over,
  };
}

export const v2Project = (over = {}) => ({
  id: "p1",
  title: "Synthetic project",
  workspaceRoot: "C:/synthetic",
  repositoryIdentity: null,
  defaultModelSelection: { instanceId: "codex", model: "model-a" },
  defaultThreadEnvMode: "local",
  autoPull: false,
  faviconPath: null,
  projectIcon: null,
  scripts: [],
  createdAt: iso(1000 * MIN),
  updatedAt: iso(1000 * MIN),
  ...over,
});

export function v2Shell(threads, archivedThreads = []) {
  return { schemaVersion: 2, snapshotSequence: 42, threads, archivedThreads, projects: [v2Project()] };
}

export function v2Run(over = {}) {
  return {
    id: "run-1",
    threadId: "t-1",
    ordinal: 1,
    providerInstanceId: "codex",
    modelSelection: { instanceId: "codex", model: "model-a" },
    providerThreadId: "pt-1",
    userMessageId: "m-u1",
    rootNodeId: "n-1",
    activeAttemptId: "a-1",
    status: "completed",
    requestedAt: iso(30 * MIN),
    startedAt: iso(30 * MIN),
    completedAt: iso(20 * MIN),
    checkpointId: null,
    contextHandoffId: null,
    ...over,
  };
}

export function v2Message(over = {}) {
  return {
    createdBy: "user",
    creationSource: "web",
    id: "m-1",
    threadId: "t-1",
    runId: null,
    nodeId: null,
    role: "user",
    text: "synthetic text",
    attachments: [],
    streaming: false,
    createdAt: iso(30 * MIN),
    updatedAt: iso(30 * MIN),
    ...over,
  };
}

export function v2Session(over = {}) {
  return {
    id: "ps-1",
    driver: "codex",
    providerInstanceId: "codex",
    status: "ready",
    cwd: "C:/synthetic",
    model: "model-a",
    capabilities: {},
    createdAt: iso(30 * MIN),
    updatedAt: iso(20 * MIN),
    lastError: null,
    ...over,
  };
}

export function v2Item(over = {}) {
  return {
    id: "ti-1",
    threadId: "t-1",
    runId: "run-1",
    nodeId: "n-1",
    providerThreadId: "pt-1",
    providerTurnId: "pturn-1",
    nativeItemRef: null,
    parentItemId: null,
    ordinal: 1,
    status: "completed",
    title: null,
    startedAt: iso(25 * MIN),
    completedAt: iso(25 * MIN),
    updatedAt: iso(25 * MIN),
    ...over,
  };
}

export function v2Request(over = {}) {
  return {
    id: "rr-1",
    nodeId: "n-1",
    providerTurnId: "pturn-1",
    nativeRequestRef: null,
    kind: "command",
    status: "pending",
    responseCapability: { type: "live", providerSessionId: "ps-1" },
    createdAt: iso(5 * MIN),
    resolvedAt: null,
    ...over,
  };
}

export function v2Detail(proj = {}) {
  const { thread, ...rest } = proj;
  return {
    snapshotSequence: 7,
    projection: {
      thread: v2Thread(thread ?? {}),
      runs: [],
      attempts: [],
      nodes: [],
      subagents: [],
      providerSessions: [],
      providerThreads: [],
      providerTurns: [],
      runtimeRequests: [],
      messages: [],
      plans: [],
      turnItems: [],
      checkpointScopes: [],
      checkpoints: [],
      contextHandoffs: [],
      contextTransfers: [],
      visibleTurnItems: [],
      updatedAt: iso(1 * MIN),
      ...rest,
    },
  };
}

/**
 * Minimal WebSocket server on a node:http server (RFC 6455 text frames only), enough to
 * act as a T3 RPC endpoint in tests. onMessage(obj, send, req) handles each JSON frame.
 */
export function attachWs(server, onMessage) {
  server.on("upgrade", (req, socket) => {
    const key = req.headers["sec-websocket-key"];
    const accept = createHash("sha1").update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
        `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
    const send = (obj) => {
      const data = Buffer.from(JSON.stringify(obj));
      const head = data.length < 126 ? Buffer.from([0x81, data.length]) : Buffer.from([0x81, 126, data.length >> 8, data.length & 255]);
      socket.write(Buffer.concat([head, data]));
    };
    let buf = Buffer.alloc(0);
    socket.on("data", (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      while (buf.length >= 2) {
        const op = buf[0] & 0x0f;
        let len = buf[1] & 0x7f;
        let off = 2;
        if (len === 126) { len = buf.readUInt16BE(2); off = 4; }
        if (buf.length < off + 4 + len) return;
        const mask = buf.subarray(off, off + 4);
        const payload = Buffer.from(buf.subarray(off + 4, off + 4 + len)).map((b, i) => b ^ mask[i % 4]);
        buf = buf.subarray(off + 4 + len);
        if (op === 8) { socket.end(Buffer.from([0x88, 0])); return; }
        if (op === 1) onMessage(JSON.parse(payload.toString("utf8")), send, req);
      }
    });
    socket.on("error", () => {});
  });
}
