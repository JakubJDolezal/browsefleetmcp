import { randomUUID } from "node:crypto";

import { WebSocket } from "ws";

import { Context, noConnectionMessage } from "@/context";
import { SerialExecutor } from "@/utils/serial";

export const noAvailableSessionMessage =
  "All connected browser sessions are currently in use. Connect another tab in the BrowseFleetMCP extension or disconnect an existing session.";

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
    const existingLease = this.clientLeases.get(clientId);
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

  private releaseSessionLease(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session?.leasedTo) {
      return;
    }

    this.clientLeases.delete(session.leasedTo);
    session.leasedTo = undefined;
  }
}
