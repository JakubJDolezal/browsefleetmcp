import type {
  ConnectionSettings,
  CurrentTabInfo,
  ExtensionStatus,
  PopupRequest,
  RuntimeResponse,
  SessionRecord,
} from "../shared/protocol.js";
import {
  CONNECTION_SETTINGS_STORAGE_KEY,
  SESSION_STORAGE_KEY,
  normalizeConnectionSettings,
} from "../shared/protocol.js";

let refreshPromise: Promise<void> | undefined;
let refreshQueued = false;

function getElement<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) {
    throw new Error(`Missing popup element "${id}".`);
  }
  return element as T;
}

function formatError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

function setError(message?: string): void {
  const errorElement = getElement<HTMLParagraphElement>("error");
  if (!message) {
    errorElement.textContent = "";
    errorElement.classList.add("hidden");
    return;
  }
  errorElement.textContent = message;
  errorElement.classList.remove("hidden");
}

async function sendPopupRequest<T>(message: PopupRequest): Promise<T> {
  const response = (await chrome.runtime.sendMessage(
    message,
  )) as RuntimeResponse<T>;
  if (!response.ok) {
    throw new Error(response.error);
  }
  return response.data;
}

function formatTimestamp(value?: string | null): string {
  if (!value) {
    return "n/a";
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return value;
  }

  return parsed.toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}

function formatCloseInfo(session: SessionRecord): string {
  const parts = [];
  if (typeof session.lastCloseCode === "number") {
    parts.push(`code ${session.lastCloseCode}`);
  }
  if (session.lastCloseReason) {
    parts.push(session.lastCloseReason);
  }

  return parts.length > 0 ? parts.join(" | ") : "n/a";
}

function createDetail(label: string, value: string): HTMLElement {
  const line = document.createElement("p");
  line.className = "session-detail";
  line.textContent = `${label}: ${value}`;
  return line;
}

function renderExtensionStatus(status: ExtensionStatus): void {
  const summary = getElement<HTMLDivElement>("health-summary");
  const warnings = getElement<HTMLDivElement>("health-warnings");
  summary.innerHTML = "";
  warnings.innerHTML = "";

  const connectedLine = document.createElement("p");
  connectedLine.className = "health-line";
  connectedLine.textContent = `Extension ${status.extensionVersion} | Server ${status.serverMetadata?.serverVersion ?? "unknown"} | Sessions ${status.activeSessionCount}/${status.storedSessionCount}`;
  summary.appendChild(connectedLine);

  const sourceLine = document.createElement("p");
  sourceLine.className = "health-line";
  sourceLine.textContent = `Build root: ${status.buildSourceRoot ?? "unknown"}`;
  summary.appendChild(sourceLine);

  const serverLine = document.createElement("p");
  serverLine.className = "health-line";
  serverLine.textContent = `Server cwd: ${status.serverMetadata?.serverCwd ?? "unknown"}`;
  summary.appendChild(serverLine);

  const transportLine = document.createElement("p");
  transportLine.className = "health-line";
  transportLine.textContent = `Transport: ${status.transportMode} | Browser ${status.browserVersion ?? "unknown"}`;
  summary.appendChild(transportLine);

  if (status.warnings.length === 0) {
    warnings.classList.add("hidden");
    return;
  }

  warnings.classList.remove("hidden");
  for (const warningText of status.warnings) {
    const warning = document.createElement("p");
    warning.className = "health-warning";
    warning.textContent = warningText;
    warnings.appendChild(warning);
  }
}

function renderCurrentTab(currentTab: CurrentTabInfo): void {
  const currentTabElement = getElement<HTMLParagraphElement>("current-tab");
  currentTabElement.textContent = `${currentTab.title} (${currentTab.url || "no url"})`;

  const connectButton = getElement<HTMLButtonElement>("connect-current");
  connectButton.disabled = !currentTab.connectable;
  connectButton.textContent = currentTab.connectable
    ? "Split Into Window & Connect"
    : "Current Tab Not Supported";
}

function createSessionCard(session: SessionRecord): HTMLElement {
  const card = document.createElement("article");
  card.className = "session";

  const title = document.createElement("h3");
  title.className = "session-title";
  title.textContent = session.label || session.title || "Untitled";

  const url = document.createElement("p");
  url.className = "session-url";
  url.textContent = session.url || "No URL";

  const meta = document.createElement("div");
  meta.className = "session-meta";

  const status = document.createElement("span");
  status.className = `status-${session.status}`;
  status.textContent = session.status;
  meta.appendChild(status);

  const identity = document.createElement("span");
  identity.className = "muted";
  identity.textContent = `window ${session.windowId} tab ${session.tabId}`;
  meta.appendChild(identity);

  const actions = document.createElement("div");
  actions.className = "session-actions";

  const focusButton = document.createElement("button");
  focusButton.className = "secondary";
  focusButton.type = "button";
  focusButton.textContent = "Focus";
  focusButton.addEventListener("click", async () => {
    try {
      setError(undefined);
      await sendPopupRequest<void>({
        type: "popup/focus-session",
        payload: { sessionId: session.sessionId },
      });
    } catch (error) {
      setError(formatError(error));
    }
  });
  actions.appendChild(focusButton);

  const disconnectButton = document.createElement("button");
  disconnectButton.className = "secondary";
  disconnectButton.type = "button";
  disconnectButton.textContent = "Disconnect";
  disconnectButton.addEventListener("click", async () => {
    try {
      setError(undefined);
      await sendPopupRequest<void>({
        type: "popup/disconnect-session",
        payload: { sessionId: session.sessionId },
      });
      await refresh();
    } catch (error) {
      setError(formatError(error));
    }
  });
  actions.appendChild(disconnectButton);

  meta.appendChild(actions);
  card.append(title, url, meta);

  const details = document.createElement("div");
  details.className = "session-details";
  if (session.label && session.label !== session.title) {
    details.append(createDetail("Page", session.title || "Untitled"));
  }
  details.append(
    createDetail("Heartbeat", formatTimestamp(session.lastHeartbeatAt)),
    createDetail("Retries", String(session.retryCount ?? 0)),
    createDetail("Last close", formatCloseInfo(session)),
    createDetail("Last drop", formatTimestamp(session.lastDisconnectAt)),
  );
  card.appendChild(details);

  if (session.lastTransportError) {
    const error = document.createElement("p");
    error.className = "error";
    error.textContent = `Transport: ${session.lastTransportError}`;
    card.appendChild(error);
  }

  if (session.lastCommandError) {
    const commandError = document.createElement("p");
    commandError.className = "warning";
    commandError.textContent = `Last command: ${session.lastCommandError}`;
    card.appendChild(commandError);
  }

  return card;
}

function renderSessions(sessions: SessionRecord[]): void {
  const count = getElement<HTMLSpanElement>("session-count");
  count.textContent = String(sessions.length);

  const sessionsContainer = getElement<HTMLDivElement>("sessions");
  sessionsContainer.innerHTML = "";
  if (sessions.length === 0) {
    const empty = document.createElement("p");
    empty.className = "muted";
    empty.textContent = "No connected sessions.";
    sessionsContainer.appendChild(empty);
    return;
  }

  for (const session of sessions) {
    sessionsContainer.appendChild(createSessionCard(session));
  }
}

function renderConnectionSettings(settings: ConnectionSettings): void {
  getElement<HTMLInputElement>("primary-port").value = String(
    settings.primaryPort,
  );
  getElement<HTMLInputElement>("fallback-ports").value =
    settings.fallbackPorts.join(", ");
  getElement<HTMLInputElement>("auth-token").value = settings.authToken;
  getElement<HTMLSelectElement>("pointer-mode").value = settings.pointerMode;
}

function parsePortInput(value: string): number {
  const parsed = Number(value.trim());
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    throw new Error(`Invalid port: ${value}`);
  }
  return parsed;
}

function readConnectionSettings(): ConnectionSettings {
  const primaryPort = parsePortInput(
    getElement<HTMLInputElement>("primary-port").value,
  );
  const fallbackPorts = getElement<HTMLInputElement>("fallback-ports")
    .value
    .split(",")
    .map((candidate) => candidate.trim())
    .filter(Boolean)
    .map(parsePortInput);
  const authToken = getElement<HTMLInputElement>("auth-token").value;
  const pointerMode =
    getElement<HTMLSelectElement>("pointer-mode").value === "human"
      ? "human"
      : "direct";

  return normalizeConnectionSettings({
    primaryPort,
    fallbackPorts,
    authToken,
    pointerMode,
  });
}

async function runRefresh(): Promise<void> {
  const [
    currentTabResult,
    sessionsResult,
    connectionSettingsResult,
    extensionStatusResult,
  ] =
    await Promise.allSettled([
      sendPopupRequest<CurrentTabInfo>({ type: "popup/get-current-tab" }),
      sendPopupRequest<SessionRecord[]>({ type: "popup/list-sessions" }),
      sendPopupRequest<ConnectionSettings>({
        type: "popup/get-connection-settings",
      }),
      sendPopupRequest<ExtensionStatus>({
        type: "popup/get-extension-status",
      }),
    ]);

  const refreshErrors = [];

  if (currentTabResult.status === "fulfilled") {
    renderCurrentTab(currentTabResult.value);
  } else {
    refreshErrors.push(formatError(currentTabResult.reason));
  }

  if (sessionsResult.status === "fulfilled") {
    renderSessions(sessionsResult.value);
  } else {
    refreshErrors.push(formatError(sessionsResult.reason));
  }

  if (connectionSettingsResult.status === "fulfilled") {
    renderConnectionSettings(connectionSettingsResult.value);
  } else {
    refreshErrors.push(formatError(connectionSettingsResult.reason));
  }

  if (extensionStatusResult.status === "fulfilled") {
    renderExtensionStatus(extensionStatusResult.value);
  } else {
    refreshErrors.push(formatError(extensionStatusResult.reason));
  }

  setError(refreshErrors.length > 0 ? refreshErrors.join(" | ") : undefined);
}

async function refresh(): Promise<void> {
  if (refreshPromise) {
    refreshQueued = true;
    return await refreshPromise;
  }

  refreshPromise = runRefresh().finally(() => {
    refreshPromise = undefined;
    if (refreshQueued) {
      refreshQueued = false;
      void refresh().catch((error) => setError(formatError(error)));
    }
  });

  return await refreshPromise;
}

async function connectCurrentTab(): Promise<void> {
  try {
    setError(undefined);
    const currentTab = await sendPopupRequest<CurrentTabInfo>({
      type: "popup/get-current-tab",
    });
    await sendPopupRequest<SessionRecord>({
      type: "popup/connect-tab",
      payload: { tabId: currentTab.tabId },
    });
    await refresh();
  } catch (error) {
    setError(formatError(error));
  }
}

async function saveConnectionSettings(): Promise<void> {
  try {
    setError(undefined);
    const settings = readConnectionSettings();
    await sendPopupRequest<ConnectionSettings>({
      type: "popup/update-connection-settings",
      payload: settings,
    });
    await refresh();
  } catch (error) {
    setError(formatError(error));
  }
}

function wireEvents(): void {
  getElement<HTMLButtonElement>("connect-current").addEventListener(
    "click",
    () => {
      void connectCurrentTab();
    },
  );

  getElement<HTMLButtonElement>("refresh").addEventListener("click", () => {
    void refresh();
  });

  getElement<HTMLButtonElement>("save-ports").addEventListener("click", () => {
    void saveConnectionSettings();
  });

  chrome.storage.onChanged.addListener((changes: any, areaName: string) => {
    if (
      areaName === "local" &&
      (SESSION_STORAGE_KEY in changes ||
        CONNECTION_SETTINGS_STORAGE_KEY in changes)
    ) {
      void refresh();
    }
  });
}

wireEvents();
void refresh().catch((error) => setError(formatError(error)));
