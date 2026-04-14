import {
  SOCKET_RESPONSE_TYPE,
  getSocketPortCandidates,
  nowIso,
  type BackgroundRequest,
  type ConnectionSettings,
  type OffscreenStatus,
  type SessionSetup,
  type SessionTransportPatch,
} from "../shared/protocol.js";
import { socketRequestRequiresFocus } from "../background/focus-lock.js";
import {
  HEARTBEAT_INTERVAL_MS,
  SOCKET_CONNECT_TIMEOUT_MS,
  HEARTBEAT_TIMEOUT_MS,
  computeReconnectDelayMs,
  describeDisconnect,
  errorMessage,
  normalizeCloseCode,
  normalizeCloseReason,
} from "./transport-shared.js";

type BackgroundRequester = <T>(message: BackgroundRequest) => Promise<T>;

type SessionTransportOptions = {
  sessionId: string;
  requestBackground: BackgroundRequester;
  runSerializedFocusTask?: <T>(task: () => Promise<T>) => Promise<T>;
  webSocketClass?: typeof WebSocket;
  setTimeout?: typeof globalThis.setTimeout;
  clearTimeout?: typeof globalThis.clearTimeout;
  setInterval?: typeof globalThis.setInterval;
  clearInterval?: typeof globalThis.clearInterval;
  random?: () => number;
};

function createSocketUrl(
  port: number,
  session: SessionSetup["session"],
  authToken: string,
): string {
  const socketUrl = new URL(`ws://127.0.0.1:${port}`);
  socketUrl.searchParams.set("sessionId", session.sessionId);
  socketUrl.searchParams.set("tabId", String(session.tabId));
  socketUrl.searchParams.set("windowId", String(session.windowId));
  if (session.label) {
    socketUrl.searchParams.set("label", session.label);
  }
  if (authToken) {
    socketUrl.searchParams.set("authToken", authToken);
  }

  return socketUrl.toString();
}


export class SessionTransport {
  private readonly webSocketClass: typeof WebSocket;
  private readonly setTimeoutFn: typeof globalThis.setTimeout;
  private readonly clearTimeoutFn: typeof globalThis.clearTimeout;
  private readonly setIntervalFn: typeof globalThis.setInterval;
  private readonly clearIntervalFn: typeof globalThis.clearInterval;
  private readonly random: () => number;
  private socket?: WebSocket;
  private connectPromise?: Promise<void>;
  private reconnectTimer?: number;
  private heartbeatInterval?: number;
  private heartbeatTimeout?: number;
  private pendingHeartbeatRequestId?: string;
  private retryCount = 0;
  private disposed = false;

  constructor(private readonly options: SessionTransportOptions) {
    this.webSocketClass = options.webSocketClass ?? WebSocket;
    this.setTimeoutFn = options.setTimeout ?? globalThis.setTimeout.bind(globalThis);
    this.clearTimeoutFn =
      options.clearTimeout ?? globalThis.clearTimeout.bind(globalThis);
    this.setIntervalFn =
      options.setInterval ?? globalThis.setInterval.bind(globalThis);
    this.clearIntervalFn =
      options.clearInterval ?? globalThis.clearInterval.bind(globalThis);
    this.random = options.random ?? Math.random;
  }

  async connect(): Promise<void> {
    if (this.disposed) {
      return;
    }

    if (this.socket) {
      const openState = this.webSocketClass.OPEN;
      const connectingState = this.webSocketClass.CONNECTING;
      if (
        this.socket.readyState === openState ||
        this.socket.readyState === connectingState
      ) {
        return;
      }
    }

    if (this.connectPromise) {
      return await this.connectPromise;
    }

    this.clearReconnectTimer();
    const attempt = this.performConnect();
    const connectPromise = attempt.finally(() => {
      if (this.connectPromise === connectPromise) {
        this.connectPromise = undefined;
      }
    });
    this.connectPromise = connectPromise;
    return await connectPromise;
  }

  async disconnect(): Promise<void> {
    this.disposed = true;
    this.clearReconnectTimer();
    this.clearHeartbeatTimers();

    const socket = this.socket;
    this.socket = undefined;
    if (
      socket &&
      (socket.readyState === this.webSocketClass.OPEN ||
        socket.readyState === this.webSocketClass.CONNECTING)
    ) {
      socket.close();
    }
  }

  private async performConnect(): Promise<void> {
    const setup = await this.requestSessionSetup();
    await this.updateTransport({
      status: "connecting",
      lastTransportError: undefined,
    });

    try {
      const socket = await this.openSocketWithFallbacks(setup);
      if (this.disposed) {
        socket.close();
        return;
      }

      this.bindSocket(socket);
      this.socket = socket;
      this.retryCount = 0;
      try {
        await this.updateTransport({
          status: "connected",
          lastTransportError: undefined,
          retryCount: 0,
        });
      } catch (error) {
        if (this.socket === socket) {
          this.socket = undefined;
        }
        try {
          socket.close();
        } catch {
          // Ignore close failures while recovering from background bridge errors.
        }
        throw error;
      }
      this.startHeartbeat(socket);
    } catch (error) {
      if (this.disposed) {
        return;
      }

      this.scheduleReconnect({
        message: errorMessage(error),
      });
      throw error;
    }
  }

  private bindSocket(socket: WebSocket): void {
    socket.addEventListener("message", (event) => {
      void this.handleSocketMessage(socket, event.data);
    });

    socket.addEventListener("close", (event: CloseEvent) => {
      void this.handleSocketClose(socket, event.code, event.reason);
    });
  }

  private async handleSocketMessage(
    socket: WebSocket,
    data: unknown,
  ): Promise<void> {
    let message: { id?: string; type?: string; payload?: any };
    try {
      message = JSON.parse(String(data)) as {
        id?: string;
        type?: string;
        payload?: any;
      };
    } catch {
      return;
    }

    if (message.type === "heartbeatAck") {
      this.handleHeartbeatAck(message.payload?.requestId, message.payload?.receivedAt);
      return;
    }

    if (typeof message.id !== "string" || typeof message.type !== "string") {
      return;
    }

    const commandType = message.type;
    const executeRequest = async () => {
      let result: unknown;
      let error: string | undefined;
      try {
        result = await this.options.requestBackground<unknown>({
          type: "background/run-session-command",
          payload: {
            sessionId: this.options.sessionId,
            commandType,
            commandPayload: message.payload,
          },
        });
      } catch (caughtError) {
        error = errorMessage(caughtError);
      }

      if (socket !== this.socket || socket.readyState !== this.webSocketClass.OPEN) {
        return;
      }

      socket.send(
        JSON.stringify({
          id: crypto.randomUUID(),
          type: SOCKET_RESPONSE_TYPE,
          payload: {
            requestId: message.id,
            result,
            error,
          },
        }),
      );
    };

    if (
      socketRequestRequiresFocus(commandType) &&
      this.options.runSerializedFocusTask
    ) {
      await this.options.runSerializedFocusTask(executeRequest);
      return;
    }

    await executeRequest();
  }

  private async handleSocketClose(
    socket: WebSocket,
    closeCode?: number,
    closeReason?: string,
  ): Promise<void> {
    this.clearHeartbeatTimers();
    if (this.socket !== socket) {
      return;
    }

    this.socket = undefined;

    if (this.disposed) {
      return;
    }

    this.scheduleReconnect({
      message: describeDisconnect(
        "BrowseFleetMCP session disconnected. Retrying.",
        closeCode,
        closeReason,
      ),
      closeCode,
      closeReason,
    });
  }

  private async requestSessionSetup(): Promise<SessionSetup> {
    return await this.options.requestBackground<SessionSetup>({
      type: "background/get-session-setup",
      payload: { sessionId: this.options.sessionId },
    });
  }

  private async updateTransport(
    patch: SessionTransportPatch,
  ): Promise<void> {
    await this.options.requestBackground<void>({
      type: "background/update-session-transport",
      payload: {
        sessionId: this.options.sessionId,
        patch,
      },
    });
  }

  private async openSocketWithFallbacks(setup: SessionSetup): Promise<WebSocket> {
    let lastError: unknown;

    for (const port of getSocketPortCandidates(setup.settings)) {
      try {
        return await this.openSocket(port, setup.session, setup.settings);
      } catch (error) {
        lastError = error;
      }
    }

    throw (
      lastError ??
      new Error("Unable to connect to the local BrowseFleetMCP server.")
    );
  }

  private async openSocket(
    port: number,
    session: SessionSetup["session"],
    settings: ConnectionSettings,
  ): Promise<WebSocket> {
    const socketUrl = createSocketUrl(port, session, settings.authToken);

    return await new Promise<WebSocket>((resolve, reject) => {
      const socket = new this.webSocketClass(socketUrl);
      const connectTimeoutId = this.setTimeoutFn(() => {
        cleanup();
        try {
          socket.close();
        } catch {
          // Ignore close failures during stalled connection cleanup.
        }
        reject(
          new Error(`Timed out opening BrowseFleetMCP socket on port ${port}.`),
        );
      }, SOCKET_CONNECT_TIMEOUT_MS) as unknown as number;
      const handleOpen = () => {
        cleanup();
        resolve(socket);
      };
      const handleError = () => {
        cleanup();
        try {
          socket.close();
        } catch {
          // Ignore close failures during connection probing.
        }
        reject(new Error(`Unable to open BrowseFleetMCP socket on port ${port}.`));
      };
      const handleClose = () => {
        cleanup();
        reject(
          new Error(
            `BrowseFleetMCP socket on port ${port} closed during connect.`,
          ),
        );
      };
      const cleanup = () => {
        this.clearTimeoutFn(connectTimeoutId);
        socket.removeEventListener("open", handleOpen);
        socket.removeEventListener("error", handleError);
        socket.removeEventListener("close", handleClose);
      };

      socket.addEventListener("open", handleOpen);
      socket.addEventListener("error", handleError);
      socket.addEventListener("close", handleClose);
    });
  }

  private startHeartbeat(socket: WebSocket): void {
    this.clearHeartbeatTimers();
    this.heartbeatInterval = this.setIntervalFn(() => {
      this.sendHeartbeat(socket);
    }, HEARTBEAT_INTERVAL_MS) as unknown as number;
  }

  private sendHeartbeat(socket: WebSocket): void {
    if (socket !== this.socket || socket.readyState !== this.webSocketClass.OPEN) {
      this.clearHeartbeatTimers();
      return;
    }

    if (this.pendingHeartbeatRequestId) {
      socket.close(4001, "heartbeat-timeout");
      return;
    }

    const requestId = crypto.randomUUID();
    this.pendingHeartbeatRequestId = requestId;
    this.heartbeatTimeout = this.setTimeoutFn(() => {
      if (this.pendingHeartbeatRequestId === requestId) {
        this.pendingHeartbeatRequestId = undefined;
        socket.close(4001, "heartbeat-timeout");
      }
    }, HEARTBEAT_TIMEOUT_MS) as unknown as number;

    socket.send(
      JSON.stringify({
        id: requestId,
        type: "heartbeat",
        payload: {
          sentAt: nowIso(),
        },
      }),
    );
  }

  private handleHeartbeatAck(
    requestId?: string,
    receivedAt?: string,
  ): void {
    if (!requestId || requestId !== this.pendingHeartbeatRequestId) {
      return;
    }

    this.pendingHeartbeatRequestId = undefined;
    if (this.heartbeatTimeout !== undefined) {
      this.clearTimeoutFn(this.heartbeatTimeout);
      this.heartbeatTimeout = undefined;
    }

    void this.updateTransport({
      lastHeartbeatAt:
        typeof receivedAt === "string" && receivedAt.length > 0
          ? receivedAt
          : nowIso(),
      lastTransportError: undefined,
    }).catch(() => undefined);
  }

  private scheduleReconnect(options: {
    message: string;
    closeCode?: number;
    closeReason?: string;
  }): void {
    if (this.disposed) {
      return;
    }

    this.clearReconnectTimer();
    this.retryCount += 1;
    const delayMs = computeReconnectDelayMs(this.retryCount, this.random);
    void this.updateTransport({
      status: "connecting",
      lastTransportError: options.message,
      retryCount: this.retryCount,
      lastDisconnectAt: nowIso(),
      lastCloseCode: normalizeCloseCode(options.closeCode),
      lastCloseReason: normalizeCloseReason(options.closeReason),
    }).catch(() => undefined);

    this.reconnectTimer = this.setTimeoutFn(() => {
      this.reconnectTimer = undefined;
      void this.connect().catch(() => undefined);
    }, delayMs) as unknown as number;
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer === undefined) {
      return;
    }

    this.clearTimeoutFn(this.reconnectTimer);
    this.reconnectTimer = undefined;
  }

  private clearHeartbeatTimers(): void {
    if (this.heartbeatInterval !== undefined) {
      this.clearIntervalFn(this.heartbeatInterval);
      this.heartbeatInterval = undefined;
    }

    if (this.heartbeatTimeout !== undefined) {
      this.clearTimeoutFn(this.heartbeatTimeout);
      this.heartbeatTimeout = undefined;
    }

    this.pendingHeartbeatRequestId = undefined;
  }
}

export class SessionTransportHub {
  private readonly transports = new Map<string, SessionTransport>();
  private focusTaskChain: Promise<void> = Promise.resolve();

  constructor(
    private readonly requestBackground: BackgroundRequester,
    private readonly transportOptions: Omit<
      SessionTransportOptions,
      "requestBackground" | "sessionId"
    > = {},
  ) {}

  private async runSerializedFocusTask<T>(task: () => Promise<T>): Promise<T> {
    const previous = this.focusTaskChain;
    let release: (() => void) | undefined;
    this.focusTaskChain = new Promise<void>((resolve) => {
      release = resolve;
    });

    await previous;

    try {
      return await task();
    } finally {
      release?.();
    }
  }

  async connectSession(sessionId: string): Promise<void> {
    let transport = this.transports.get(sessionId);
    if (!transport) {
      transport = new SessionTransport({
        ...this.transportOptions,
        sessionId,
        requestBackground: this.requestBackground,
        runSerializedFocusTask: (task) => this.runSerializedFocusTask(task),
      });
      this.transports.set(sessionId, transport);
    }

    await transport.connect();
  }

  async disconnectSession(sessionId: string): Promise<void> {
    const transport = this.transports.get(sessionId);
    if (!transport) {
      return;
    }

    await transport.disconnect();
    this.transports.delete(sessionId);
  }

  async close(): Promise<void> {
    await Promise.all(
      Array.from(this.transports.values()).map(async (transport) => {
        await transport.disconnect();
      }),
    );
    this.transports.clear();
  }

  getStatus(): OffscreenStatus {
    return {
      activeSessionCount: this.transports.size,
      keepAlive: false,
    };
  }
}
