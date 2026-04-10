import type {
  CurrentTabInfo,
  PopupRequest,
  RuntimeResponse,
  SessionRecord,
} from "../shared/protocol.js";
import { SESSION_STORAGE_KEY } from "../shared/protocol.js";

let refreshPromise: Promise<void> | undefined;
let refreshQueued = false;

function getElement<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) {
    throw new Error(`Missing popup element "${id}".`);
  }
  return element as T;
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
  title.textContent = session.title || "Untitled";

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
      setError(String(error));
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
      setError(String(error));
    }
  });
  actions.appendChild(disconnectButton);

  meta.appendChild(actions);
  card.append(title, url, meta);

  if (session.lastError) {
    const error = document.createElement("p");
    error.className = "error";
    error.textContent = session.lastError;
    card.appendChild(error);
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

async function runRefresh(): Promise<void> {
  setError(undefined);
  const [currentTab, sessions] = await Promise.all([
    sendPopupRequest<CurrentTabInfo>({ type: "popup/get-current-tab" }),
    sendPopupRequest<SessionRecord[]>({ type: "popup/list-sessions" }),
  ]);
  renderCurrentTab(currentTab);
  renderSessions(sessions);
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
      void refresh().catch((error) => setError(String(error)));
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
    setError(String(error));
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

  chrome.storage.onChanged.addListener((changes: any, areaName: string) => {
    if (areaName === "local" && SESSION_STORAGE_KEY in changes) {
      void refresh();
    }
  });
}

wireEvents();
void refresh().catch((error) => setError(String(error)));
