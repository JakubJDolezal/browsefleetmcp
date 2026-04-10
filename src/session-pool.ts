import { randomUUID } from "node:crypto";

import { WebSocket } from "ws";

import { Context, noConnectionMessage } from "@/context";
import { SerialExecutor } from "@/utils/serial";

export const noAvailableSessionMessage =
  "All connected browser sessions are currently in use. Connect another tab in the BrowseFleetMCP extension or disconnect an existing session.";

export type BrowserSessionSummary = {
  sessionId: string;
  tabId?: number;
  windowId?: number;
  status: "available" | "current" | "in-use";
};

type SessionConnectionMetadata = {
  sessionId?: string;
  tabId?: number;
  windowId?: number;
};

type BrowserSession = {
  sessionId: string;
  ws?: WebSocket;
  tabId?: number;
  windowId?: number;
  leasedTo?: string;
  executor: SerialExecutor;
};

function isOpen(session?: BrowserSession): boolean {
  return session?.ws?.readyState === WebSocket.OPEN;
}

export class SessionPool {
  private readonly sessions = new Map<string, BrowserSession>();
  private readonly clientLeases = new Map<string, string>();

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

    if (previousWs && previousWs !== ws) {
      previousWs.close();
    }

    ws.once("close", () => {
      if (session.ws !== ws) {
        return;
      }

      session.ws = undefined;
      this.releaseSessionLease(session.sessionId);
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
        return this.createLeaseResult(existingSession!);
      }

      this.releaseClient(clientId);
    }

    const connectedSessions = Array.from(this.sessions.values()).filter((session) =>
      isOpen(session),
    );
    const availableSession = connectedSessions.find((session) => !session.leasedTo);

    if (!availableSession) {
      throw new Error(
        connectedSessions.length === 0
          ? noConnectionMessage
          : noAvailableSessionMessage,
      );
    }

    availableSession.leasedTo = clientId;
    this.clientLeases.set(clientId, availableSession.sessionId);
    return this.createLeaseResult(availableSession);
  }

  listSessions(clientId: string): BrowserSessionSummary[] {
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

  switchClientSession(
    clientId: string,
    sessionId: string,
  ): BrowserSessionSummary {
    const session = this.sessions.get(sessionId);
    if (!isOpen(session)) {
      throw new Error(`Session "${sessionId}" is not currently connected.`);
    }

    const openSession = session!;

    if (openSession.leasedTo && openSession.leasedTo !== clientId) {
      throw new Error(`Session "${sessionId}" is already in use by another client.`);
    }

    const currentSessionId = this.getOpenLease(clientId);
    if (currentSessionId && currentSessionId !== sessionId) {
      this.releaseClient(clientId);
    }

    openSession.leasedTo = clientId;
    this.clientLeases.set(clientId, sessionId);
    return this.createSessionSummary(openSession, sessionId);
  }

  releaseClient(clientId: string): void {
    const leasedSessionId = this.clientLeases.get(clientId);
    if (!leasedSessionId) {
      return;
    }

    const session = this.sessions.get(leasedSessionId);
    if (session?.leasedTo === clientId) {
      session.leasedTo = undefined;
    }

    this.clientLeases.delete(clientId);
  }

  async close(): Promise<void> {
    this.clientLeases.clear();
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
    return {
      sessionId: session.sessionId,
      tabId: session.tabId,
      windowId: session.windowId,
      status:
        session.sessionId === currentSessionId
          ? "current"
          : session.leasedTo
            ? "in-use"
            : "available",
    };
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

  private releaseSessionLease(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session?.leasedTo) {
      return;
    }

    this.clientLeases.delete(session.leasedTo);
    session.leasedTo = undefined;
  }
}
