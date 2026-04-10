import { SessionController } from "./session-controller.js";
import { errorMessage } from "./runtime.js";
import {
  type CurrentTabInfo,
  type PopupRequest,
  type RuntimeResponse,
  type SessionRecord,
  SESSION_STORAGE_KEY,
  isConnectableUrl,
  nowIso,
} from "../shared/protocol.js";

type SessionControllerLike = Pick<
  SessionController,
  "connect" | "disconnect" | "refreshFromTab" | "recordSnapshot"
>;

type SessionControllerFactory = (options: {
  record: SessionRecord;
  onUpdate: (record: SessionRecord) => void;
  onDisposed: (sessionId: string) => void;
}) => SessionControllerLike;

type BackgroundServiceOptions = {
  chromeApi?: typeof chrome;
  createController?: SessionControllerFactory;
  persistDebounceMs?: number;
  setTimer?: (callback: () => void, delayMs: number) => number;
  clearTimer?: (timerId: number) => void;
};

export class BackgroundService {
  private readonly chromeApi: typeof chrome;
  private readonly createController: SessionControllerFactory;
  private readonly persistDebounceMs: number;
  private readonly setTimer: (callback: () => void, delayMs: number) => number;
  private readonly clearTimer: (timerId: number) => void;
  private readonly controllers = new Map<string, SessionControllerLike>();
  private readonly records = new Map<string, SessionRecord>();
  private readonly sessionIdByTabId = new Map<number, string>();
  private persistTimer?: number;
  private started = false;

  constructor(options: BackgroundServiceOptions = {}) {
    this.chromeApi = options.chromeApi ?? chrome;
    this.createController =
      options.createController ??
      ((controllerOptions) => new SessionController(controllerOptions));
    this.persistDebounceMs = options.persistDebounceMs ?? 100;
    this.setTimer = options.setTimer ?? globalThis.setTimeout.bind(globalThis);
    this.clearTimer =
      options.clearTimer ?? globalThis.clearTimeout.bind(globalThis);
  }

  start(): void {
    if (this.started) {
      return;
    }

    this.started = true;
    this.addRuntimeMessageListener();
    this.addTabLifecycleListeners();
    void this.restoreSessions();
  }

  private async isolateTabInWindow(tabId: number): Promise<any> {
    const tab = await this.chromeApi.tabs.get(tabId);
    if (!tab?.id) {
      throw new Error("Tab not found.");
    }

    if (typeof tab.windowId !== "number") {
      return tab;
    }

    const window = await this.chromeApi.windows.get(tab.windowId, { populate: true });
    const tabs = (window.tabs ?? []).filter(
      (candidate: any) => typeof candidate.id === "number",
    );

    if (window.type === "normal" && tabs.length === 1) {
      return tab;
    }

    const detachedWindow = await this.chromeApi.windows.create({ tabId: tab.id });
    const detachedTab = detachedWindow.tabs?.find(
      (candidate: any) => candidate.id === tab.id,
    );
    if (detachedTab?.id) {
      return detachedTab;
    }

    return await this.chromeApi.tabs.get(tab.id);
  }

  private async persistRecords(): Promise<void> {
    await this.chromeApi.storage.local.set({
      [SESSION_STORAGE_KEY]: Array.from(this.records.values()),
    });
  }

  private schedulePersist(): void {
    if (this.persistTimer !== undefined) {
      this.clearTimer(this.persistTimer);
    }

    this.persistTimer = this.setTimer(() => {
      this.persistTimer = undefined;
      void this.persistRecords();
    }, this.persistDebounceMs);
  }

  private handleRecordUpdate = (record: SessionRecord): void => {
    const previous = this.records.get(record.sessionId);
    if (previous && previous.tabId !== record.tabId) {
      this.sessionIdByTabId.delete(previous.tabId);
    }

    this.records.set(record.sessionId, record);
    this.sessionIdByTabId.set(record.tabId, record.sessionId);
    this.schedulePersist();
  };

  private handleDisposed = (sessionId: string): void => {
    const record = this.records.get(sessionId);
    if (record) {
      this.sessionIdByTabId.delete(record.tabId);
    }
    this.controllers.delete(sessionId);
    this.records.delete(sessionId);
    this.schedulePersist();
  };

  private async listSessions(): Promise<SessionRecord[]> {
    return Array.from(this.records.values()).sort((left, right) =>
      left.connectedAt.localeCompare(right.connectedAt),
    );
  }

  private async getCurrentTabInfo(): Promise<CurrentTabInfo> {
    const tabs = await this.chromeApi.tabs.query({
      active: true,
      currentWindow: true,
    });
    const tab = tabs[0];
    if (!tab?.id) {
      throw new Error("No active tab found.");
    }

    return {
      tabId: tab.id,
      title: tab.title ?? "Untitled",
      url: tab.url ?? "",
      connectable: isConnectableUrl(tab.url),
    };
  }

  private findSessionByTabId(tabId: number): SessionRecord | undefined {
    const sessionId = this.sessionIdByTabId.get(tabId);
    return sessionId ? this.records.get(sessionId) : undefined;
  }

  private async connectTab(tabId: number): Promise<SessionRecord> {
    const existing = this.findSessionByTabId(tabId);
    if (existing) {
      const controller = this.controllers.get(existing.sessionId);
      if (!controller) {
        throw new Error("Existing session controller is missing.");
      }
      await controller.connect();
      return controller.recordSnapshot;
    }

    const tab = await this.isolateTabInWindow(tabId);
    if (!tab?.id) {
      throw new Error("Tab not found.");
    }

    const timestamp = nowIso();
    const record: SessionRecord = {
      sessionId: crypto.randomUUID(),
      tabId: tab.id,
      windowId: tab.windowId ?? -1,
      title: tab.title ?? "Untitled",
      url: tab.url ?? "",
      status: "connecting",
      connectedAt: timestamp,
      updatedAt: timestamp,
    };

    const controller = this.createController({
      record,
      onUpdate: this.handleRecordUpdate,
      onDisposed: this.handleDisposed,
    });
    this.controllers.set(record.sessionId, controller);
    this.records.set(record.sessionId, record);
    this.sessionIdByTabId.set(record.tabId, record.sessionId);
    this.schedulePersist();
    await controller.connect();
    return controller.recordSnapshot;
  }

  private async disconnectSession(sessionId: string): Promise<void> {
    const controller = this.controllers.get(sessionId);
    if (!controller) {
      const record = this.records.get(sessionId);
      if (record) {
        this.sessionIdByTabId.delete(record.tabId);
      }
      this.records.delete(sessionId);
      this.schedulePersist();
      return;
    }

    await controller.disconnect();
  }

  private async focusSession(sessionId: string): Promise<void> {
    const record = this.records.get(sessionId);
    if (!record) {
      throw new Error("Session not found.");
    }
    await this.chromeApi.tabs.update(record.tabId, { active: true });
    await this.chromeApi.windows.update(record.windowId, { focused: true });
  }

  private async restoreSessions(): Promise<void> {
    const stored = (await this.chromeApi.storage.local.get(SESSION_STORAGE_KEY))[
      SESSION_STORAGE_KEY
    ] as SessionRecord[] | undefined;

    for (const record of stored ?? []) {
      try {
        await this.chromeApi.tabs.get(record.tabId);
      } catch {
        continue;
      }

      const controller = this.createController({
        record,
        onUpdate: this.handleRecordUpdate,
        onDisposed: this.handleDisposed,
      });
      this.controllers.set(record.sessionId, controller);
      this.records.set(record.sessionId, record);
      this.sessionIdByTabId.set(record.tabId, record.sessionId);
      void controller.connect();
    }

    this.schedulePersist();
  }

  private addRuntimeMessageListener(): void {
    this.chromeApi.runtime.onMessage.addListener(
      (
        message: PopupRequest | { type?: string },
        _sender: unknown,
        sendResponse: (response: RuntimeResponse<unknown>) => void,
      ) => {
        if (
          typeof message?.type !== "string" ||
          !message.type.startsWith("popup/")
        ) {
          return undefined;
        }

        const popupMessage = message as PopupRequest;

        (async () => {
          switch (popupMessage.type) {
            case "popup/list-sessions":
              return await this.listSessions();
            case "popup/get-current-tab":
              return await this.getCurrentTabInfo();
            case "popup/connect-tab":
              return await this.connectTab(popupMessage.payload.tabId);
            case "popup/disconnect-session":
              await this.disconnectSession(popupMessage.payload.sessionId);
              return null;
            case "popup/focus-session":
              await this.focusSession(popupMessage.payload.sessionId);
              return null;
          }
        })()
          .then((data) => sendResponse({ ok: true, data }))
          .catch((error) =>
            sendResponse({ ok: false, error: errorMessage(error) }),
          );

        return true;
      },
    );
  }

  private addTabLifecycleListeners(): void {
    this.chromeApi.tabs.onRemoved.addListener((tabId: number) => {
      const session = this.findSessionByTabId(tabId);
      if (session) {
        void this.disconnectSession(session.sessionId);
      }
    });

    this.chromeApi.tabs.onUpdated.addListener(
      (tabId: number, changeInfo: any) => {
        const session = this.findSessionByTabId(tabId);
        if (!session) {
          return;
        }

        const controller = this.controllers.get(session.sessionId);
        if (!controller) {
          return;
        }

        if (
          changeInfo.title ||
          changeInfo.url ||
          changeInfo.status === "complete"
        ) {
          void controller.refreshFromTab();
        }
      },
    );
  }
}
