import { WebSocket } from "ws";

import { sendSocketMessage } from "@/messaging";

export const noExtensionControlMessage =
  "No connection to the BrowseFleetMCP extension control channel. Reload the extension and keep it enabled, then retry.";

export type CreatedSession = {
  sessionId: string;
  tabId: number;
  windowId: number;
  title: string;
  url: string;
  label?: string;
  status?: string;
};

export type ExtensionReloadResult = {
  reloading: true;
};

export type ExtensionConnectionMetadata = {
  extensionId: string | null;
  extensionVersion: string | null;
  extensionRootUrl: string | null;
  buildSourceRoot: string | null;
  builtAt: string | null;
  browserVersion: string | null;
  browserUserAgent: string | null;
  transportMode: string | null;
};

export type ExtensionStatus = ExtensionConnectionMetadata & {
  connected: boolean;
  lastConnectedAt: string | null;
  activeSessionCount: number | null;
  storedSessionCount: number | null;
  sessionStatusCounts: Record<string, number>;
  sourcePathAvailable: boolean;
  sourcePathReason: string | null;
  serverMetadata?: {
    serverVersion: string;
    serverCwd: string;
    expectedExtensionRoot: string | null;
    wsPortCandidates: number[];
    brokerPortCandidates: number[];
    serverPid: number;
    connectedAt: string;
  } | null;
  warnings?: string[];
};

export type PrunedSession = {
  sessionId: string;
  tabId: number;
  windowId: number;
  label?: string;
  reason: string;
};

export type ExtensionPruneResult = {
  removedSessions: PrunedSession[];
  remainingSessionCount: number;
};

type HeartbeatMessage = {
  id?: string;
  type?: string;
};

type ConnectionWaiter = {
  resolve: (ws: WebSocket) => void;
  reject: (error: Error) => void;
  timeoutId: ReturnType<typeof setTimeout>;
};

function parseSocketMessage(rawMessage: WebSocket.RawData): HeartbeatMessage | undefined {
  try {
    return JSON.parse(rawMessage.toString()) as HeartbeatMessage;
  } catch {
    return undefined;
  }
}

function isOpen(ws?: WebSocket): ws is WebSocket {
  return ws?.readyState === WebSocket.OPEN;
}

function normalizeMetadata(
  metadata?: Partial<ExtensionConnectionMetadata>,
): ExtensionConnectionMetadata {
  return {
    extensionId: metadata?.extensionId ?? null,
    extensionVersion: metadata?.extensionVersion ?? null,
    extensionRootUrl: metadata?.extensionRootUrl ?? null,
    buildSourceRoot: metadata?.buildSourceRoot ?? null,
    builtAt: metadata?.builtAt ?? null,
    browserVersion: metadata?.browserVersion ?? null,
    browserUserAgent: metadata?.browserUserAgent ?? null,
    transportMode: metadata?.transportMode ?? null,
  };
}

export class ExtensionControl {
  private ws?: WebSocket;
  private readonly connectionWaiters = new Set<ConnectionWaiter>();
  private metadata: ExtensionConnectionMetadata = normalizeMetadata();
  private lastConnectedAt: string | null = null;

  attachConnection(
    ws: WebSocket,
    metadata?: Partial<ExtensionConnectionMetadata>,
  ): void {
    const previousWs = this.ws;
    this.ws = ws;
    this.metadata = normalizeMetadata({
      ...this.metadata,
      ...metadata,
    });
    this.lastConnectedAt = new Date().toISOString();

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
          id: crypto.randomUUID(),
          type: "heartbeatAck",
          payload: {
            requestId: message.id,
            receivedAt: new Date().toISOString(),
          },
        }),
      );
    });

    ws.once("close", () => {
      if (this.ws === ws) {
        this.ws = undefined;
      }
    });

    this.resolveWaiters(ws);
  }

  async createSession(
    payload: { url?: string; label?: string },
    options: {
      connectionTimeoutMs?: number;
      responseTimeoutMs?: number;
    } = {},
  ): Promise<CreatedSession> {
    const ws = await this.waitForConnection(options.connectionTimeoutMs);
    return await sendSocketMessage<CreatedSession>(
      ws,
      "extension_create_session",
      payload,
      { timeoutMs: options.responseTimeoutMs ?? 30_000 },
    );
  }

  async reloadExtension(
    options: {
      connectionTimeoutMs?: number;
      responseTimeoutMs?: number;
    } = {},
  ): Promise<ExtensionReloadResult> {
    const ws = await this.waitForConnection(options.connectionTimeoutMs);
    return await sendSocketMessage<ExtensionReloadResult>(
      ws,
      "extension_reload",
      undefined,
      { timeoutMs: options.responseTimeoutMs ?? 30_000 },
    );
  }

  async getStatus(
    options: {
      connectionTimeoutMs?: number;
      responseTimeoutMs?: number;
    } = {},
  ): Promise<ExtensionStatus> {
    if (!isOpen(this.ws)) {
      return {
        ...this.metadata,
        connected: false,
        lastConnectedAt: this.lastConnectedAt,
        activeSessionCount: null,
        storedSessionCount: null,
        sessionStatusCounts: {},
        sourcePathAvailable: Boolean(this.metadata.buildSourceRoot),
        sourcePathReason: this.metadata.buildSourceRoot
          ? null
          : "The current extension build did not report a source path.",
      };
    }

    const ws = await this.waitForConnection(options.connectionTimeoutMs);
    const status = await sendSocketMessage<ExtensionStatus>(
      ws,
      "extension_status",
      undefined,
      { timeoutMs: options.responseTimeoutMs ?? 5_000 },
    );

    this.metadata = normalizeMetadata({
      ...this.metadata,
      ...status,
    });
    this.lastConnectedAt = status.lastConnectedAt ?? this.lastConnectedAt;
    return status;
  }

  async pruneSessions(
    options: {
      connectionTimeoutMs?: number;
      responseTimeoutMs?: number;
    } = {},
  ): Promise<ExtensionPruneResult> {
    const ws = await this.waitForConnection(options.connectionTimeoutMs);
    return await sendSocketMessage<ExtensionPruneResult>(
      ws,
      "extension_prune_sessions",
      undefined,
      { timeoutMs: options.responseTimeoutMs ?? 30_000 },
    );
  }

  async reconnectSession(
    sessionId: string,
    options: {
      connectionTimeoutMs?: number;
      responseTimeoutMs?: number;
    } = {},
  ): Promise<CreatedSession> {
    const ws = await this.waitForConnection(options.connectionTimeoutMs);
    return await sendSocketMessage<CreatedSession>(
      ws,
      "extension_reconnect_session",
      { sessionId },
      { timeoutMs: options.responseTimeoutMs ?? 30_000 },
    );
  }

  async destroySession(
    sessionId: string,
    options: {
      connectionTimeoutMs?: number;
      responseTimeoutMs?: number;
    } = {},
  ): Promise<{ destroyed: true; sessionId: string }> {
    const ws = await this.waitForConnection(options.connectionTimeoutMs);
    return await sendSocketMessage<{ destroyed: true; sessionId: string }>(
      ws,
      "extension_destroy_session",
      { sessionId },
      { timeoutMs: options.responseTimeoutMs ?? 30_000 },
    );
  }

  async close(): Promise<void> {
    const ws = this.ws;
    this.ws = undefined;
    this.rejectWaiters(new Error(noExtensionControlMessage));

    if (!isOpen(ws)) {
      return;
    }

    await new Promise<void>((resolve) => {
      ws.once("close", () => resolve());
      ws.close();
    });
  }

  private async waitForConnection(timeoutMs = 5_000): Promise<WebSocket> {
    if (isOpen(this.ws)) {
      return this.ws;
    }

    return await new Promise<WebSocket>((resolve, reject) => {
      const waiter: ConnectionWaiter = {
        resolve: (ws) => {
          clearTimeout(waiter.timeoutId);
          this.connectionWaiters.delete(waiter);
          resolve(ws);
        },
        reject: (error) => {
          clearTimeout(waiter.timeoutId);
          this.connectionWaiters.delete(waiter);
          reject(error);
        },
        timeoutId: setTimeout(() => {
          waiter.reject(new Error(noExtensionControlMessage));
        }, timeoutMs),
      };

      this.connectionWaiters.add(waiter);
    });
  }

  private resolveWaiters(ws: WebSocket): void {
    for (const waiter of Array.from(this.connectionWaiters)) {
      waiter.resolve(ws);
    }
  }

  private rejectWaiters(error: Error): void {
    for (const waiter of Array.from(this.connectionWaiters)) {
      waiter.reject(error);
    }
  }
}
