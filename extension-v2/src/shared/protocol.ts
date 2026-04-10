export const DEFAULT_WS_PORT = 9150;
export const DEFAULT_WS_FALLBACK_PORTS = [9152, 9154];
export const SOCKET_RESPONSE_TYPE = "messageResponse";
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

export type ConnectionSettings = {
  primaryPort: number;
  fallbackPorts: number[];
};

export type SessionRecord = {
  sessionId: string;
  tabId: number;
  windowId: number;
  title: string;
  url: string;
  status: SessionStatus;
  lastError?: string;
  connectedAt: string;
  updatedAt: string;
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
  | { type: "popup/get-connection-settings" }
  | { type: "popup/update-connection-settings"; payload: ConnectionSettings };

export type OffscreenRequest = {
  type: "offscreen/capture-desktop";
  payload: { streamId: string };
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
  };
}

export function getSocketPortCandidates(
  settings?: Partial<ConnectionSettings> | null,
): number[] {
  const normalized = normalizeConnectionSettings(settings);
  return [normalized.primaryPort, ...normalized.fallbackPorts];
}
