import { randomUUID } from "node:crypto";

import { WebSocket } from "ws";

import { Context, noConnectionMessage } from "@/context";
import { BrowseFleetToolError } from "@/tool-errors";
import { SerialExecutor } from "@/utils/serial";

export const noAvailableSessionMessage =
  "All connected browser sessions are currently in use. Connect another tab in the BrowseFleetMCP extension or disconnect an existing session.";
export const noSelectedSessionMessage =
  'No browser session is currently selected for this MCP client. Use "browser_list_sessions" to inspect sessions and "browser_switch_session" to select one before calling browser navigation or interaction tools.';
const RECENT_TOUCH_WINDOW_MS = 5 * 60 * 1000;
const DEFAULT_FOCUS_TASK_TIMEOUT_MS = 15_000;

export type BrowserSessionSummary = {
  sessionId: string;
  tabId?: number;
  windowId?: number;
  label?: string;
  status: "available" | "current" | "in-use";
  recentClientCount: number;
  lastTouchedAt: string | null;
};

export type SessionPoolHealth = {
  sessionCount: number;
  currentLeaseCount: number;
  retainedClosedSessionCount: number;
  focusLock: {
    queueDepth: number;
    currentOwnerClientId: string | null;
    currentSessionId: string | null;
    currentToolName: string | null;
    lastWaitDurationMs: number | null;
    lastHoldDurationMs: number | null;
    timeoutMs: number;
  };
};

type SessionConnectionMetadata = {
  sessionId?: string;
  tabId?: number;
  windowId?: number;
  label?: string;
};

type BrowserSession = {
  sessionId: string;
  ws?: WebSocket;
  tabId?: number;
  windowId?: number;
  label?: string;
  leasedTo?: string;
  recentTouches: Map<string, number>;
  executor: SerialExecutor;
};

type HeartbeatMessage = {
  id?: string;
  type?: string;
};

type FocusTask<T = unknown> = {
  clientId: string;
  sessionId: string;
  toolName: string;
  enqueuedAt: number;
  timeoutId: ReturnType<typeof setTimeout>;
  cancelled: boolean;
  task: () => Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
};

type ActiveFocusTask = {
  clientId: string;
  sessionId: string;
  toolName: string;
  startedAt: number;
};

type QueuedFocusTask = FocusTask<unknown>;

function isOpen(session?: BrowserSession): boolean {
  return session?.ws?.readyState === WebSocket.OPEN;
}

function parseSocketMessage(rawMessage: WebSocket.RawData): HeartbeatMessage | undefined {
  try {
    return JSON.parse(rawMessage.toString()) as HeartbeatMessage;
  } catch {
    return undefined;
  }
}

export class SessionPool {
  private readonly sessions = new Map<string, BrowserSession>();
  private readonly clientLeases = new Map<string, string>();
  private readonly focusQueue: QueuedFocusTask[] = [];
  private activeFocusTask?: ActiveFocusTask;
  private lastFocusWaitDurationMs: number | null = null;
  private lastFocusHoldDurationMs: number | null = null;

  constructor(
    private readonly now: () => number = () => Date.now(),
    private readonly focusTaskTimeoutMs: number = DEFAULT_FOCUS_TASK_TIMEOUT_MS,
  ) {}

  attachConnection(
    ws: WebSocket,
    metadata: SessionConnectionMetadata = {},
  ): BrowserSession {
    const sessionId = metadata.sessionId ?? randomUUID();
    const session = this.getOrCreateSession(sessionId);
    const previousWs = session.ws;

    session.ws = ws;
    session.tabId = metadata.tabId ?? session.tabId;
    session.windowId = metadata.windowId ?? session.windowId;
    session.label = metadata.label ?? session.label;

    if (previousWs && previousWs !== ws) {
      previousWs.close();
    }

    ws.on("message", (rawMessage) => {
      const message = parseSocketMessage(rawMessage);
      if (message?.type !== "heartbeat" || typeof message.id !== "string") {
        return;
      }

      if (ws.readyState !== WebSocket.OPEN) {
        return;
      }

      ws.send(
        JSON.stringify({
          id: randomUUID(),
          type: "heartbeatAck",
          payload: {
            requestId: message.id,
            receivedAt: new Date(this.now()).toISOString(),
          },
        }),
      );
    });

    ws.once("close", () => {
      if (session.ws !== ws) {
        return;
      }

      session.ws = undefined;
      this.releaseSessionLease(session.sessionId);
      this.sessions.delete(session.sessionId);
    });

    return session;
  }

  acquire(clientId: string): {
    context: Context;
    executor: SerialExecutor;
    sessionId: string;
  } {
    const existingLease = this.getOpenLease(clientId);
    if (existingLease) {
      const existingSession = this.sessions.get(existingLease);
      if (isOpen(existingSession)) {
        this.touchSession(existingSession!, clientId);
        return this.createLeaseResult(existingSession!);
      }

      this.releaseClient(clientId);
    }

    const connectedSessions = Array.from(this.sessions.values()).filter((session) =>
      isOpen(session),
    );
    if (connectedSessions.length === 0) {
      throw new Error(noConnectionMessage);
    }

    throw new Error(noSelectedSessionMessage);
  }

  runFocusSensitiveTask<T>(
    options: {
      clientId: string;
      sessionId: string;
      toolName: string;
    },
    task: () => Promise<T>,
  ): Promise<T> {
    const { clientId, sessionId, toolName } = options;

    return awaitableFocusTask({
      clientId,
      sessionId,
      toolName,
      timeoutMs: this.focusTaskTimeoutMs,
      now: this.now,
      enqueue: (entry) => {
        this.focusQueue.push(entry as QueuedFocusTask);
        this.processNextFocusTask();
      },
    }, task);
  }

  listSessions(clientId: string): BrowserSessionSummary[] {
    this.pruneDisconnectedSessions();
    const currentSessionId = this.getOpenLease(clientId);

    return Array.from(this.sessions.values())
      .filter((session) => isOpen(session))
      .sort((left, right) => {
        const leftWindowId = left.windowId ?? Number.MAX_SAFE_INTEGER;
        const rightWindowId = right.windowId ?? Number.MAX_SAFE_INTEGER;
        if (leftWindowId !== rightWindowId) {
          return leftWindowId - rightWindowId;
        }

        const leftTabId = left.tabId ?? Number.MAX_SAFE_INTEGER;
        const rightTabId = right.tabId ?? Number.MAX_SAFE_INTEGER;
        if (leftTabId !== rightTabId) {
          return leftTabId - rightTabId;
        }

        return left.sessionId.localeCompare(right.sessionId);
      })
      .map((session) => this.createSessionSummary(session, currentSessionId));
  }

  getCurrentSession(clientId: string): BrowserSessionSummary | undefined {
    const currentSessionId = this.getOpenLease(clientId);
    if (!currentSessionId) {
      return undefined;
    }

    const session = this.sessions.get(currentSessionId);
    if (!isOpen(session)) {
      return undefined;
    }

    return this.createSessionSummary(session!, currentSessionId);
  }

  getSession(sessionId: string, clientId?: string): BrowserSessionSummary | undefined {
    const session = this.sessions.get(sessionId);
    if (!isOpen(session)) {
      return undefined;
    }

    return this.createSessionSummary(
      session!,
      clientId ? this.getOpenLease(clientId) : undefined,
    );
  }

  switchClientSession(
    clientId: string,
    sessionId: string,
  ): BrowserSessionSummary {
    const session = this.getOpenSessionOrThrow(sessionId);

    if (session.leasedTo && session.leasedTo !== clientId) {
      throw new Error(`Session "${sessionId}" is already in use by another client.`);
    }

    const currentSessionId = this.getOpenLease(clientId);
    if (currentSessionId && currentSessionId !== sessionId) {
      this.releaseClient(clientId);
    }

    session.leasedTo = clientId;
    this.clientLeases.set(clientId, sessionId);
    this.touchSession(session, clientId);
    return this.createSessionSummary(session, sessionId);
  }

  pruneDisconnectedSessions(): BrowserSessionSummary[] {
    const removed: BrowserSessionSummary[] = [];

    for (const [sessionId, session] of this.sessions.entries()) {
      if (isOpen(session)) {
        continue;
      }

      removed.push(this.createSessionSummary(session));
      this.releaseSessionLease(sessionId);
      this.sessions.delete(sessionId);
    }

    return removed;
  }

  getHealth(): SessionPoolHealth {
    this.pruneDisconnectedSessions();

    return {
      sessionCount: Array.from(this.sessions.values()).filter((session) =>
        isOpen(session),
      ).length,
      currentLeaseCount: this.clientLeases.size,
      retainedClosedSessionCount: Array.from(this.sessions.values()).filter(
        (session) => !isOpen(session),
      ).length,
      focusLock: {
        queueDepth: this.focusQueue.filter((entry) => !entry.cancelled).length,
        currentOwnerClientId: this.activeFocusTask?.clientId ?? null,
        currentSessionId: this.activeFocusTask?.sessionId ?? null,
        currentToolName: this.activeFocusTask?.toolName ?? null,
        lastWaitDurationMs: this.lastFocusWaitDurationMs,
        lastHoldDurationMs: this.lastFocusHoldDurationMs,
        timeoutMs: this.focusTaskTimeoutMs,
      },
    };
  }

  releaseClient(clientId: string): void {
    const leasedSessionId = this.clientLeases.get(clientId);
    if (leasedSessionId) {
      const session = this.sessions.get(leasedSessionId);
      if (session?.leasedTo === clientId) {
        session.leasedTo = undefined;
      }

      this.clientLeases.delete(clientId);
    }

    for (const queuedTask of this.focusQueue) {
      if (queuedTask.clientId !== clientId || queuedTask.cancelled) {
        continue;
      }

      queuedTask.cancelled = true;
      clearTimeout(queuedTask.timeoutId);
      queuedTask.reject(
        new BrowseFleetToolError(
          "focus_lock_timeout",
          "The queued focus-sensitive action was cancelled because the client disconnected while waiting for the global focus lock.",
          {
            sessionId: queuedTask.sessionId,
            toolName: queuedTask.toolName,
          },
        ),
      );
    }

    this.processNextFocusTask();
  }

  async close(): Promise<void> {
    this.clientLeases.clear();

    while (this.focusQueue.length > 0) {
      const task = this.focusQueue.shift();
      if (!task) {
        continue;
      }

      clearTimeout(task.timeoutId);
      if (!task.cancelled) {
        task.reject(
          new BrowseFleetToolError(
            "transport_unavailable",
            "The BrowseFleetMCP server is shutting down.",
          ),
        );
      }
    }

    const sockets = Array.from(this.sessions.values())
      .map((session) => session.ws)
      .filter((ws): ws is WebSocket => !!ws);

    await Promise.all(
      sockets.map(
        (ws) =>
          new Promise<void>((resolve) => {
            if (
              ws.readyState === WebSocket.CLOSING ||
              ws.readyState === WebSocket.CLOSED
            ) {
              resolve();
              return;
            }

            ws.once("close", () => resolve());
            ws.close();
          }),
      ),
    );
  }

  private getOrCreateSession(sessionId: string): BrowserSession {
    let session = this.sessions.get(sessionId);
    if (!session) {
      session = {
        sessionId,
        recentTouches: new Map(),
        executor: new SerialExecutor(),
      };
      this.sessions.set(sessionId, session);
    }

    return session;
  }

  private createLeaseResult(session: BrowserSession) {
    return {
      context: new Context(() => session.ws),
      executor: session.executor,
      sessionId: session.sessionId,
    };
  }

  private createSessionSummary(
    session: BrowserSession,
    currentSessionId?: string,
  ): BrowserSessionSummary {
    this.pruneExpiredTouches(session);
    const recentTouches = Array.from(session.recentTouches.values());

    return {
      sessionId: session.sessionId,
      tabId: session.tabId,
      windowId: session.windowId,
      label: session.label,
      status:
        session.sessionId === currentSessionId
          ? "current"
          : session.leasedTo
            ? "in-use"
            : "available",
      recentClientCount: recentTouches.length,
      lastTouchedAt:
        recentTouches.length > 0
          ? new Date(Math.max(...recentTouches)).toISOString()
          : null,
    };
  }

  private touchSession(session: BrowserSession, clientId: string): void {
    this.pruneExpiredTouches(session);
    session.recentTouches.set(clientId, this.now());
  }

  private pruneExpiredTouches(session: BrowserSession): void {
    const expiresBefore = this.now() - RECENT_TOUCH_WINDOW_MS;
    for (const [clientId, touchedAt] of session.recentTouches.entries()) {
      if (touchedAt < expiresBefore) {
        session.recentTouches.delete(clientId);
      }
    }
  }

  private getOpenLease(clientId: string): string | undefined {
    const existingLease = this.clientLeases.get(clientId);
    if (!existingLease) {
      return undefined;
    }

    const existingSession = this.sessions.get(existingLease);
    if (isOpen(existingSession)) {
      return existingLease;
    }

    this.releaseClient(clientId);
    return undefined;
  }

  private getOpenSessionOrThrow(sessionId: string): BrowserSession {
    const session = this.sessions.get(sessionId);
    if (!isOpen(session)) {
      throw new Error(`Session "${sessionId}" is not currently connected.`);
    }

    return session!;
  }

  private releaseSessionLease(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session?.leasedTo) {
      return;
    }

    this.clientLeases.delete(session.leasedTo);
    session.leasedTo = undefined;
  }

  private processNextFocusTask(): void {
    if (this.activeFocusTask) {
      return;
    }

    while (this.focusQueue.length > 0) {
      const nextTask = this.focusQueue.shift();
      if (!nextTask) {
        return;
      }

      if (nextTask.cancelled) {
        continue;
      }

      clearTimeout(nextTask.timeoutId);
      const startedAt = this.now();
      const waitDurationMs = startedAt - nextTask.enqueuedAt;
      this.lastFocusWaitDurationMs = waitDurationMs;
      this.activeFocusTask = {
        clientId: nextTask.clientId,
        sessionId: nextTask.sessionId,
        toolName: nextTask.toolName,
        startedAt,
      };

      void nextTask.task()
        .then((value) => {
          nextTask.resolve(value);
        })
        .catch((error) => {
          nextTask.reject(error);
        })
        .finally(() => {
          const activeTask = this.activeFocusTask;
          this.lastFocusHoldDurationMs = activeTask
            ? this.now() - activeTask.startedAt
            : null;
          this.activeFocusTask = undefined;
          this.processNextFocusTask();
        });
      return;
    }
  }
}

function awaitableFocusTask<T>(
  options: {
    clientId: string;
    sessionId: string;
    toolName: string;
    timeoutMs: number;
    now: () => number;
    enqueue: (entry: FocusTask<T>) => void;
  },
  task: () => Promise<T>,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let queuedTask!: FocusTask<T>;
    queuedTask = {
      clientId: options.clientId,
      sessionId: options.sessionId,
      toolName: options.toolName,
      enqueuedAt: options.now(),
      cancelled: false,
      task,
      resolve,
      reject,
      timeoutId: setTimeout(() => {
        queuedTask.cancelled = true;
        reject(
          new BrowseFleetToolError(
            "focus_lock_timeout",
            `Timed out waiting for the global focus lock after ${options.timeoutMs}ms.`,
            {
              sessionId: options.sessionId,
              toolName: options.toolName,
              timeoutMs: options.timeoutMs,
            },
          ),
        );
      }, options.timeoutMs),
    };

    options.enqueue(queuedTask);
  });
}
