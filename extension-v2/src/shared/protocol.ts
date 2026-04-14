export const DEFAULT_WS_PORT = 9150;
export const DEFAULT_WS_FALLBACK_PORTS = [9152, 9154];
export const SOCKET_RESPONSE_TYPE = "messageResponse";
export const BACKGROUND_BRIDGE_PORT_NAME = "browsefleet-background-bridge";
export const EXTENSION_ERROR_KEY = "__extensionStackError__";
export const SESSION_STORAGE_KEY = "browsefleetmcp.multiSessions";
export const CONNECTION_SETTINGS_STORAGE_KEY =
  "browsefleetmcp.connectionSettings";
export const TEST_DESKTOP_CAPTURE_STORAGE_KEY =
  "__browsefleetmcp.testDesktopCaptureImage";

export type ExtensionError = {
  [EXTENSION_ERROR_KEY]: true;
  message: string;
};

export type SessionStatus =
  | "connecting"
  | "connected"
  | "disconnected"
  | "error";

export type ConsoleEntry = {
  type: string;
  timestamp: number;
  message: string;
};

export type PointerMode = "direct" | "human";

export type ConnectionSettings = {
  primaryPort: number;
  fallbackPorts: number[];
  authToken: string;
  pointerMode: PointerMode;
};

export type SessionRecord = {
  sessionId: string;
  tabId: number;
  windowId: number;
  label?: string;
  title: string;
  url: string;
  status: SessionStatus;
  lastTransportError?: string;
  lastCommandError?: string;
  retryCount?: number;
  lastHeartbeatAt?: string | null;
  lastDisconnectAt?: string | null;
  lastCloseCode?: number;
  lastCloseReason?: string;
  connectedAt: string;
  updatedAt: string;
};

export type SessionTransportPatch = Partial<
  Pick<
    SessionRecord,
    | "status"
    | "lastTransportError"
    | "retryCount"
    | "lastHeartbeatAt"
    | "lastDisconnectAt"
    | "lastCloseCode"
    | "lastCloseReason"
  >
>;

export type SessionSocketDescriptor = Pick<
  SessionRecord,
  "sessionId" | "tabId" | "windowId" | "label"
>;

export type SessionSetup = {
  session: SessionSocketDescriptor;
  settings: ConnectionSettings;
};

export type ExtensionStatus = {
  connected: true;
  lastConnectedAt: string | null;
  extensionId: string;
  extensionVersion: string;
  extensionRootUrl: string;
  buildSourceRoot: string | null;
  builtAt: string | null;
  browserVersion: string | null;
  browserUserAgent: string | null;
  transportMode: string;
  activeSessionCount: number;
  storedSessionCount: number;
  sessionStatusCounts: Record<string, number>;
  sourcePathAvailable: boolean;
  sourcePathReason: string | null;
  serverMetadata: ServerMetadata | null;
  warnings: string[];
};

export type ServerMetadata = {
  serverVersion: string;
  serverCwd: string;
  expectedExtensionRoot: string | null;
  wsPortCandidates: number[];
  brokerPortCandidates: number[];
  serverPid: number;
  connectedAt: string;
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

export type SocketRequestMessage = {
  id: string;
  type: string;
  payload?: unknown;
};

export type SocketResponsePayload = {
  requestId: string;
  result?: unknown;
  error?: string;
};

export type SocketResponseMessage = {
  id: string;
  type: typeof SOCKET_RESPONSE_TYPE;
  payload: SocketResponsePayload;
};

export type RuntimeSuccess<T> = {
  ok: true;
  data: T;
};

export type RuntimeFailure = {
  ok: false;
  error: string;
};

export type RuntimeResponse<T> = RuntimeSuccess<T> | RuntimeFailure;

export type PopupRequest =
  | { type: "popup/list-sessions" }
  | { type: "popup/connect-tab"; payload: { tabId: number } }
  | { type: "popup/disconnect-session"; payload: { sessionId: string } }
  | { type: "popup/focus-session"; payload: { sessionId: string } }
  | { type: "popup/get-current-tab" }
  | { type: "popup/get-extension-status" }
  | { type: "popup/get-connection-settings" }
  | { type: "popup/update-connection-settings"; payload: ConnectionSettings };

export type OffscreenRequest =
  | {
      type: "offscreen/capture-desktop";
      payload: { streamId: string };
    }
  | {
      type: "offscreen/connect-session";
      payload: { sessionId: string };
    }
  | {
      type: "offscreen/disconnect-session";
      payload: { sessionId: string };
    }
  | {
      type: "offscreen/get-status";
    };

export type BackgroundRequest =
  | {
      type: "background/get-connection-settings";
    }
  | {
      type: "background/get-extension-status";
    }
  | {
      type: "background/update-server-metadata";
      payload: ServerMetadata;
    }
  | {
      type: "background/reload-extension";
    }
  | {
      type: "background/prune-sessions";
    }
  | {
      type: "background/get-session-setup";
      payload: { sessionId: string };
    }
  | {
      type: "background/create-session";
      payload: { url?: string; label?: string };
    }
  | {
      type: "background/reconnect-session";
      payload: { sessionId: string };
    }
  | {
      type: "background/destroy-session";
      payload: { sessionId: string };
    }
  | {
      type: "background/run-session-command";
      payload: {
        sessionId: string;
        commandType: string;
        commandPayload?: unknown;
      };
    }
  | {
      type: "background/update-session-transport";
      payload: {
        sessionId: string;
        patch: SessionTransportPatch;
      };
    };

export type OffscreenStatus = {
  activeSessionCount: number;
  keepAlive: boolean;
};

export type CurrentTabInfo = {
  tabId: number;
  title: string;
  url: string;
  connectable: boolean;
};

export type ContentRequest =
  | { type: "ping" }
  | { type: "generateAriaSnapshot" }
  | { type: "getSelectorForAriaRef"; payload: { ariaRef: string } }
  | { type: "scrollIntoView"; payload: { selector: string } }
  | {
      type: "getElementCoordinates";
      payload: { selector: string; options?: { clickable?: boolean } };
    }
  | { type: "selectText"; payload: { selector: string } }
  | {
      type: "waitForStableDOM";
      payload: { minStableMs: number; maxMutations: number; maxWaitMs: number };
    }
  | { type: "getInputType"; payload: { selector: string } }
  | { type: "getInputValue"; payload: { selector: string } }
  | { type: "setInputValue"; payload: { selector: string; value: string } }
  | {
      type: "selectOption";
      payload: { selector: string; values: string[] };
    }
  | { type: "getConsoleLogs" };

export function createExtensionError(message: string): ExtensionError {
  return {
    [EXTENSION_ERROR_KEY]: true,
    message,
  };
}

export function isExtensionError(value: unknown): value is ExtensionError {
  return (
    typeof value === "object" &&
    value !== null &&
    EXTENSION_ERROR_KEY in value &&
    "message" in value
  );
}

export function isControllableUrl(url?: string | null): boolean {
  if (!url) {
    return false;
  }

  try {
    const parsed = new URL(url);
    return ["http:", "https:", "about:"].includes(parsed.protocol);
  } catch {
    return false;
  }
}

export function isChromeWebStoreUrl(url?: string | null): boolean {
  if (!url) {
    return false;
  }

  try {
    const parsed = new URL(url);
    return parsed.host === "chromewebstore.google.com";
  } catch {
    return false;
  }
}

export function isConnectableUrl(url?: string | null): boolean {
  return isControllableUrl(url) && !isChromeWebStoreUrl(url);
}

export function nowIso(): string {
  return new Date().toISOString();
}

function normalizePort(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isInteger(value) && value > 0 && value <= 65535) {
    return value;
  }

  if (typeof value === "string") {
    const parsed = Number(value.trim());
    if (Number.isInteger(parsed) && parsed > 0 && parsed <= 65535) {
      return parsed;
    }
  }

  return fallback;
}

function normalizePortList(values: unknown, fallback: number[]): number[] {
  if (!Array.isArray(values)) {
    return fallback;
  }

  const ports = values
    .map((value) => normalizePort(value, Number.NaN))
    .filter((value) => Number.isInteger(value) && value > 0 && value <= 65535);
  return ports.length > 0 ? Array.from(new Set(ports)) : fallback;
}

function normalizeAuthToken(value: unknown): string {
  if (typeof value !== "string") {
    return "";
  }

  return value.trim();
}

function normalizePointerMode(value: unknown): PointerMode {
  return value === "human" ? "human" : "direct";
}

export function normalizeConnectionSettings(
  settings?: Partial<ConnectionSettings> | null,
): ConnectionSettings {
  const primaryPort = normalizePort(settings?.primaryPort, DEFAULT_WS_PORT);
  const fallbackPorts = normalizePortList(
    settings?.fallbackPorts,
    DEFAULT_WS_FALLBACK_PORTS,
  ).filter((port) => port !== primaryPort);

  return {
    primaryPort,
    fallbackPorts,
    authToken: normalizeAuthToken(settings?.authToken),
    pointerMode: normalizePointerMode(settings?.pointerMode),
  };
}

export function getSocketPortCandidates(
  settings?: Partial<ConnectionSettings> | null,
): number[] {
  const normalized = normalizeConnectionSettings(settings);
  return [normalized.primaryPort, ...normalized.fallbackPorts];
}
