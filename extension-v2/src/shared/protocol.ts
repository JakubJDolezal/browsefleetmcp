export const DEFAULT_WS_PORT = 9009;
export const SOCKET_RESPONSE_TYPE = "messageResponse";
export const EXTENSION_ERROR_KEY = "__extensionStackError__";
export const SESSION_STORAGE_KEY = "browsefleetmcp.multiSessions";

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
  | { type: "popup/get-current-tab" };

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
