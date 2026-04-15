import {
  SOCKET_RESPONSE_TYPE,
  getSocketPortCandidates,
  type BackgroundRequest,
  type ConnectionSettings,
} from "../shared/protocol.js";
import {
  EXTENSION_BUILD_SOURCE_ROOT,
  EXTENSION_BUILD_TIMESTAMP,
} from "../generated/build-info.js";
import {
  HEARTBEAT_INTERVAL_MS,
  SOCKET_CONNECT_TIMEOUT_MS,
  HEARTBEAT_TIMEOUT_MS,
  computeReconnectDelayMs,
  errorMessage,
} from "./transport-shared.js";

type BackgroundRequester = <T>(message: BackgroundRequest) => Promise<T>;
type WebSocketClass = typeof WebSocket;

type ExtensionControlTransportOptions = {
  requestBackground: BackgroundRequester;
  getConnectionSettings?: () => Promise<ConnectionSettings>;
  webSocketClass?: WebSocketClass;
  setTimeout?: typeof globalThis.setTimeout;
  clearTimeout?: typeof globalThis.clearTimeout;
  setInterval?: typeof globalThis.setInterval;
  clearInterval?: typeof globalThis.clearInterval;
  random?: () => number;
};

function getGlobalWebSocketClass(): WebSocketClass | undefined {
  return (globalThis as typeof globalThis & { WebSocket?: WebSocketClass })
    .WebSocket;
}

function createControlSocketUrl(
  port: number,
  settings: ConnectionSettings,
): string {
  const socketUrl = new URL(`ws://127.0.0.1:${port}`);
  socketUrl.searchParams.set("channel", "control");
  const runtime = typeof chrome !== "undefined" ? chrome.runtime : undefined;
  if (runtime?.id) {
    socketUrl.searchParams.set("extensionId", runtime.id);
  }
  if (runtime?.getManifest) {
    socketUrl.searchParams.set(
      "extensionVersion",
      runtime.getManifest().version,
    );
  }
  if (runtime?.getURL) {
    socketUrl.searchParams.set("extensionRootUrl", runtime.getURL(""));
  }
  socketUrl.searchParams.set(
    "transportMode",
    "direct-background-websocket",
  );
  if (EXTENSION_BUILD_SOURCE_ROOT) {
    socketUrl.searchParams.set("buildSourceRoot", EXTENSION_BUILD_SOURCE_ROOT);
  }
  if (EXTENSION_BUILD_TIMESTAMP) {
    socketUrl.searchParams.set("builtAt", EXTENSION_BUILD_TIMESTAMP);
  }
  const browserVersionMatch =
    typeof navigator !== "undefined"
      ? navigator.userAgent.match(/Chrome\/([\d.]+)/)
      : null;
  if (browserVersionMatch?.[1]) {
    socketUrl.searchParams.set("browserVersion", browserVersionMatch[1]);
  }
  if (typeof navigator !== "undefined" && navigator.userAgent) {
    socketUrl.searchParams.set("browserUserAgent", navigator.userAgent);
  }
  if (settings.authToken) {
    socketUrl.searchParams.set("authToken", settings.authToken);
  }

  return socketUrl.toString();
}

export class ExtensionControlTransport {
  private readonly webSocketClass?: WebSocketClass;
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

  constructor(private readonly options: ExtensionControlTransportOptions) {
    this.webSocketClass = options.webSocketClass;
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

    const webSocketClass = this.resolveWebSocketClass();
    if (this.socket) {
      const openState = webSocketClass.OPEN;
      const connectingState = webSocketClass.CONNECTING;
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

  async close(): Promise<void> {
    this.disposed = true;
    this.clearReconnectTimer();
    this.clearHeartbeatTimers();

    const socket = this.socket;
    this.socket = undefined;
    const webSocketClass = this.webSocketClass ?? getGlobalWebSocketClass();
    if (
      socket &&
      webSocketClass &&
      (socket.readyState === webSocketClass.OPEN ||
        socket.readyState === webSocketClass.CONNECTING)
    ) {
      socket.close();
    }
  }

  private async performConnect(): Promise<void> {
    try {
      const settings = await this.requestConnectionSettings();
      const socket = await this.openSocketWithFallbacks(settings);
      if (this.disposed) {
        socket.close();
        return;
      }

      this.bindSocket(socket);
      this.socket = socket;
      this.retryCount = 0;
      this.startHeartbeat(socket);
    } catch (error) {
      if (this.disposed) {
        return;
      }

      this.scheduleReconnect(errorMessage(error));
      throw error;
    }
  }

  private bindSocket(socket: WebSocket): void {
    socket.addEventListener("message", (event) => {
      void this.handleSocketMessage(socket, event.data);
    });

    socket.addEventListener("close", () => {
      this.handleSocketClose(socket);
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
      this.handleHeartbeatAck(message.payload?.requestId);
      return;
    }

    if (message.type === "server_metadata") {
      await this.options.requestBackground({
        type: "background/update-server-metadata",
        payload: message.payload,
      });
      return;
    }

    if (typeof message.id !== "string" || typeof message.type !== "string") {
      return;
    }

    let result: unknown;
    let error: string | undefined;
    try {
      switch (message.type) {
        case "extension_create_session":
          result = await this.options.requestBackground({
            type: "background/create-session",
            payload: {
              url: message.payload?.url,
            },
          });
          break;
        case "extension_reload":
          result = await this.options.requestBackground({
            type: "background/reload-extension",
          });
          break;
        case "extension_status":
          result = await this.options.requestBackground({
            type: "background/get-extension-status",
          });
          break;
        case "extension_prune_sessions":
          result = await this.options.requestBackground({
            type: "background/prune-sessions",
          });
          break;
        case "extension_reconnect_session":
          result = await this.options.requestBackground({
            type: "background/reconnect-session",
            payload: {
              sessionId: String(message.payload?.sessionId ?? ""),
            },
          });
          break;
        case "extension_destroy_session":
          result = await this.options.requestBackground({
            type: "background/destroy-session",
            payload: {
              sessionId: String(message.payload?.sessionId ?? ""),
            },
          });
          break;
        default:
          throw new Error(
            `Unsupported extension control command "${message.type}".`,
          );
      }
    } catch (caughtError) {
      error = errorMessage(caughtError);
    }

    if (
      socket !== this.socket ||
      socket.readyState !== this.resolveWebSocketClass().OPEN
    ) {
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
  }

  private handleSocketClose(socket: WebSocket): void {
    this.clearHeartbeatTimers();
    if (this.socket !== socket) {
      return;
    }

    this.socket = undefined;
    if (this.disposed) {
      return;
    }

    this.scheduleReconnect("BrowseFleetMCP control connection disconnected. Retrying.");
  }

  private async requestConnectionSettings(): Promise<ConnectionSettings> {
    if (this.options.getConnectionSettings) {
      return await this.options.getConnectionSettings();
    }

    return await this.options.requestBackground<ConnectionSettings>({
      type: "background/get-connection-settings",
    });
  }

  private async openSocketWithFallbacks(
    settings: ConnectionSettings,
  ): Promise<WebSocket> {
    let lastError: unknown;

    for (const port of getSocketPortCandidates(settings)) {
      try {
        return await this.openSocket(port, settings);
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
    settings: ConnectionSettings,
  ): Promise<WebSocket> {
    const socketUrl = createControlSocketUrl(port, settings);
    const webSocketClass = this.resolveWebSocketClass();

    return await new Promise<WebSocket>((resolve, reject) => {
      const socket = new webSocketClass(socketUrl);
      const connectTimeoutId = this.setTimeoutFn(() => {
        cleanup();
        try {
          socket.close();
        } catch {
          // Ignore close failures during stalled connection cleanup.
        }
        reject(
          new Error(
            `Timed out opening BrowseFleetMCP control socket on port ${port}.`,
          ),
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
        reject(new Error(`Unable to open BrowseFleetMCP control socket on port ${port}.`));
      };
      const handleClose = () => {
        cleanup();
        reject(
          new Error(
            `BrowseFleetMCP control socket on port ${port} closed during connect.`,
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
    if (
      socket !== this.socket ||
      socket.readyState !== this.resolveWebSocketClass().OPEN
    ) {
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
          sentAt: new Date().toISOString(),
        },
      }),
    );
  }

  private resolveWebSocketClass(): WebSocketClass {
    const webSocketClass = this.webSocketClass ?? getGlobalWebSocketClass();
    if (!webSocketClass) {
      throw new Error("WebSocket is not available in this runtime.");
    }

    return webSocketClass;
  }

  private handleHeartbeatAck(requestId?: string): void {
    if (!requestId || requestId !== this.pendingHeartbeatRequestId) {
      return;
    }

    this.pendingHeartbeatRequestId = undefined;
    if (this.heartbeatTimeout !== undefined) {
      this.clearTimeoutFn(this.heartbeatTimeout);
      this.heartbeatTimeout = undefined;
    }
  }

  private scheduleReconnect(_message: string): void {
    if (this.disposed) {
      return;
    }

    this.clearReconnectTimer();
    this.retryCount += 1;
    const delayMs = computeReconnectDelayMs(this.retryCount, this.random);
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
