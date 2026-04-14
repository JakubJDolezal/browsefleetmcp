import { FocusLock } from "./focus-lock.js";
import {
  SessionController,
  type SessionControllerOptions,
} from "./session-controller.js";
import { ExtensionControlTransport } from "../offscreen/control-transport.js";
import { SessionTransportHub } from "../offscreen/session-hub.js";
import { errorMessage, waitForTabComplete } from "./runtime.js";
import {
  BACKGROUND_BRIDGE_PORT_NAME,
  type BackgroundRequest,
  CONNECTION_SETTINGS_STORAGE_KEY,
  type ConnectionSettings,
  type CurrentTabInfo,
  type ExtensionPruneResult,
  type ExtensionStatus,
  type PopupRequest,
  type PrunedSession,
  type RuntimeResponse,
  type ServerMetadata,
  type SessionRecord,
  type SessionSetup,
  type SessionTransportPatch,
  SESSION_STORAGE_KEY,
  isConnectableUrl,
  normalizeConnectionSettings,
  nowIso,
} from "../shared/protocol.js";
import {
  EXTENSION_BUILD_SOURCE_ROOT,
  EXTENSION_BUILD_TIMESTAMP,
} from "../generated/build-info.js";

type SessionControllerLike = Pick<
  SessionController,
  | "applyTransportUpdate"
  | "connect"
  | "disconnect"
  | "recordCommandError"
  | "recordCommandSuccess"
  | "recordSnapshot"
  | "refreshFromTab"
  | "routeSocketRequest"
>;

type SessionControllerFactory = (
  options: SessionControllerOptions,
) => SessionControllerLike;

type FocusLockLike = Pick<FocusLock, "focus" | "run">;
type TransportRequester = <T>(message: BackgroundRequest) => Promise<T>;
type SessionTransportHubLike = Pick<
  SessionTransportHub,
  "connectSession" | "disconnectSession"
>;
type ControlTransportLike = Pick<ExtensionControlTransport, "connect">;
type SessionTransportHubFactory = (
  requestBackground: TransportRequester,
) => SessionTransportHubLike;
type ControlTransportFactory = (options: {
  requestBackground: TransportRequester;
  getConnectionSettings: () => Promise<ConnectionSettings>;
}) => ControlTransportLike;

type BackgroundServiceOptions = {
  chromeApi?: typeof chrome;
  createController?: SessionControllerFactory;
  createControlTransport?: ControlTransportFactory;
  createSessionTransportHub?: SessionTransportHubFactory;
  focusLock?: FocusLockLike;
  persistDebounceMs?: number;
  setTimer?: (callback: () => void, delayMs: number) => number;
  clearTimer?: (timerId: number) => void;
};

type RuntimeRequestMessage = PopupRequest | BackgroundRequest;

type BridgeRequestMessage = {
  requestId?: string;
  message?: RuntimeRequestMessage | { type?: string };
};

type BridgeResponseMessage = {
  requestId: string;
} & RuntimeResponse<unknown>;

type RuntimePort = ReturnType<typeof chrome.runtime.connect>;

export class BackgroundService {
  private readonly chromeApi: typeof chrome;
  private readonly createController: SessionControllerFactory;
  private readonly focusLock: FocusLockLike;
  private readonly persistDebounceMs: number;
  private readonly setTimer: (callback: () => void, delayMs: number) => number;
  private readonly clearTimer: (timerId: number) => void;
  private readonly controlTransport: ControlTransportLike;
  private readonly sessionTransportHub: SessionTransportHubLike;
  private readonly controllers = new Map<string, SessionControllerLike>();
  private readonly records = new Map<string, SessionRecord>();
  private readonly sessionIdByTabId = new Map<number, string>();
  private readonly startedAt = nowIso();
  private connectionSettings?: ConnectionSettings;
  private serverMetadata: ServerMetadata | null = null;
  private persistTimer?: number;
  private started = false;

  constructor(options: BackgroundServiceOptions = {}) {
    this.chromeApi = options.chromeApi ?? chrome;
    this.focusLock = options.focusLock ?? new FocusLock(this.chromeApi, 500);
    this.createController =
      options.createController ??
      ((controllerOptions) => new SessionController(controllerOptions));
    this.persistDebounceMs = options.persistDebounceMs ?? 100;
    this.setTimer = options.setTimer ?? globalThis.setTimeout.bind(globalThis);
    this.clearTimer =
      options.clearTimer ?? globalThis.clearTimeout.bind(globalThis);
    const requestBackground: TransportRequester = (message) =>
      this.handleTransportBackgroundRequest(message);
    this.controlTransport =
      options.createControlTransport?.({
        requestBackground,
        getConnectionSettings: () => this.getConnectionSettings(),
      }) ??
      new ExtensionControlTransport({
        requestBackground,
        getConnectionSettings: () => this.getConnectionSettings(),
      });
    this.sessionTransportHub =
      options.createSessionTransportHub?.(requestBackground) ??
      new SessionTransportHub(requestBackground);
  }

  start(): void {
    if (this.started) {
      return;
    }

    this.started = true;
    console.info(
      "BrowseFleetMCP background service worker starting (direct transport, v0.0.2).",
    );
    this.addRuntimeMessageListener();
    this.addRuntimePortListener();
    this.addTabLifecycleListeners();
    void this.controlTransport.connect().catch((error) => {
      console.error(
        "BrowseFleetMCP failed to initialize the control transport.",
        errorMessage(error),
      );
    });
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

  private async getConnectionSettings(): Promise<ConnectionSettings> {
    if (this.connectionSettings) {
      return this.connectionSettings;
    }

    const stored = (await this.chromeApi.storage.local.get(
      CONNECTION_SETTINGS_STORAGE_KEY,
    ))[CONNECTION_SETTINGS_STORAGE_KEY] as ConnectionSettings | undefined;
    this.connectionSettings = normalizeConnectionSettings(stored);
    return this.connectionSettings;
  }

  private async reloadExtension(): Promise<{ reloading: true }> {
    this.setTimer(() => {
      this.chromeApi.runtime.reload();
    }, 50);

    return { reloading: true };
  }

  private async createSession(
    url?: string,
    label?: string,
  ): Promise<SessionRecord> {
    const targetUrl =
      typeof url === "string" && url.trim().length > 0
        ? url.trim()
        : "about:blank";
    const normalizedLabel =
      typeof label === "string" && label.trim().length > 0
        ? label.trim()
        : undefined;

    if (!isConnectableUrl(targetUrl)) {
      throw new Error(
        'New sessions must use an "http:", "https:", or "about:" URL.',
      );
    }

    const createdWindow = await this.chromeApi.windows.create({
      url: targetUrl,
      focused: false,
    });
    const createdTab = createdWindow.tabs?.find(
      (candidate: any) => typeof candidate.id === "number",
    );

    if (createdTab?.id) {
      const readyTab = await this.waitForConnectableTab(createdTab.id);
      return await this.connectTab(readyTab.id, normalizedLabel);
    }

    const fallbackTabs =
      typeof createdWindow.id === "number"
        ? await this.chromeApi.tabs.query({
            active: true,
            windowId: createdWindow.id,
          })
        : [];
    const fallbackTab = fallbackTabs.find(
      (candidate: any) => typeof candidate.id === "number",
    );
    if (fallbackTab?.id) {
      const readyTab = await this.waitForConnectableTab(fallbackTab.id);
      return await this.connectTab(readyTab.id, normalizedLabel);
    }

    throw new Error("Unable to create a tab for the new browser session.");
  }

  private async waitForConnectableTab(tabId: number): Promise<any> {
    let tab = await this.chromeApi.tabs.get(tabId);
    if (isConnectableUrl(tab?.url)) {
      return tab;
    }

    tab = await waitForTabComplete(tabId, 30_000, this.chromeApi);
    if (isConnectableUrl(tab?.url)) {
      return tab;
    }

    throw new Error("New session tab did not finish loading a connectable URL.");
  }

  private async updateConnectionSettings(
    settings: ConnectionSettings,
  ): Promise<ConnectionSettings> {
    this.connectionSettings = normalizeConnectionSettings(settings);
    await this.chromeApi.storage.local.set({
      [CONNECTION_SETTINGS_STORAGE_KEY]: this.connectionSettings,
    });
    return this.connectionSettings;
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
    await this.pruneStaleSessions();
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

  private createSessionController(record: SessionRecord): SessionControllerLike {
    return this.createController({
      record,
      getConnectionSettings: () => this.getConnectionSettings(),
      onUpdate: this.handleRecordUpdate,
      onDisposed: this.handleDisposed,
      startTransport: (sessionId) => this.startSessionTransport(sessionId),
      stopTransport: (sessionId) => this.stopSessionTransport(sessionId),
      runWithFocusLock: (focusRecord, action) =>
        this.focusLock.run(focusRecord, action),
    });
  }

  private async startSessionTransport(sessionId: string): Promise<void> {
    await this.sessionTransportHub.connectSession(sessionId);
  }

  private async stopSessionTransport(sessionId: string): Promise<void> {
    await this.sessionTransportHub.disconnectSession(sessionId);
  }

  private async handleTransportBackgroundRequest<T>(
    message: BackgroundRequest,
  ): Promise<T> {
    return await this.handleRuntimeRequest(message) as T;
  }

  private async getSessionSetup(sessionId: string): Promise<SessionSetup> {
    const record = this.records.get(sessionId);
    if (!record) {
      throw new Error(`Session "${sessionId}" not found.`);
    }

    return {
      session: {
        sessionId: record.sessionId,
        tabId: record.tabId,
        windowId: record.windowId,
        label: record.label,
      },
      settings: await this.getConnectionSettings(),
    };
  }

  private async runSessionCommand(
    sessionId: string,
    commandType: string,
    commandPayload: unknown,
  ): Promise<unknown> {
    const controller = this.controllers.get(sessionId);
    if (!controller) {
      throw new Error(`Session "${sessionId}" is not available in the background worker.`);
    }

    try {
      const result = await controller.routeSocketRequest(
        commandType,
        commandPayload,
      );
      controller.recordCommandSuccess();
      return result;
    } catch (error) {
      controller.recordCommandError(errorMessage(error));
      throw error;
    }
  }

  private async updateSessionTransport(
    sessionId: string,
    patch: SessionTransportPatch,
  ): Promise<SessionRecord> {
    const controller = this.controllers.get(sessionId);
    if (controller) {
      controller.applyTransportUpdate(patch);
      return controller.recordSnapshot;
    }

    const record = this.records.get(sessionId);
    if (!record) {
      throw new Error(`Session "${sessionId}" not found.`);
    }

    const nextRecord = {
      ...record,
      ...patch,
      updatedAt: nowIso(),
    };
    this.handleRecordUpdate(nextRecord);
    return nextRecord;
  }

  private async connectTab(tabId: number, label?: string): Promise<SessionRecord> {
    const existing = this.findSessionByTabId(tabId);
    if (existing) {
      const controller = this.controllers.get(existing.sessionId);
      if (!controller) {
        throw new Error("Existing session controller is missing.");
      }
      if (label && existing.label !== label) {
        this.handleRecordUpdate({
          ...existing,
          label,
          updatedAt: nowIso(),
        });
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
      label,
      title: tab.title ?? "Untitled",
      url: tab.url ?? "",
      status: "connecting",
      retryCount: 0,
      lastHeartbeatAt: null,
      lastDisconnectAt: null,
      connectedAt: timestamp,
      updatedAt: timestamp,
    };

    const controller = this.createSessionController(record);
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
      await this.stopSessionTransport(sessionId).catch(() => undefined);
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

  private async reconnectSession(sessionId: string): Promise<SessionRecord> {
    const record = this.records.get(sessionId);
    if (!record) {
      throw new Error(`Session "${sessionId}" not found.`);
    }

    const controller =
      this.controllers.get(sessionId) ?? this.createSessionController(record);
    if (!this.controllers.has(sessionId)) {
      this.controllers.set(sessionId, controller);
    }

    await this.stopSessionTransport(sessionId).catch(() => undefined);
    await controller.connect();
    return controller.recordSnapshot;
  }

  private async destroySession(
    sessionId: string,
  ): Promise<{ destroyed: true; sessionId: string }> {
    const record = this.records.get(sessionId);
    if (!record) {
      throw new Error(`Session "${sessionId}" not found.`);
    }

    await this.disconnectSession(sessionId).catch(() => undefined);

    if (typeof record.windowId === "number" && record.windowId >= 0) {
      try {
        await this.chromeApi.windows.remove(record.windowId);
        return { destroyed: true, sessionId };
      } catch {
        // Fall back to closing the tab when the isolated window is already gone.
      }
    }

    try {
      await this.chromeApi.tabs.remove(record.tabId);
    } catch {
      // Ignore missing tab errors during cleanup.
    }

    return { destroyed: true, sessionId };
  }

  private parseBrowserVersion(): string | null {
    if (typeof navigator === "undefined" || !navigator.userAgent) {
      return null;
    }

    const match = navigator.userAgent.match(/Chrome\/([\d.]+)/);
    return match?.[1] ?? null;
  }

  private normalizePath(value: string | null | undefined): string | null {
    if (!value) {
      return null;
    }

    return value.replace(/\\/g, "/").replace(/\/+$/, "");
  }

  private getStatusWarnings(): string[] {
    const warnings: string[] = [];
    if (!EXTENSION_BUILD_SOURCE_ROOT) {
      warnings.push(
        "This extension build does not report its source path, so repo mismatch detection is limited.",
      );
    }

    const expectedExtensionRoot = this.normalizePath(
      this.serverMetadata?.expectedExtensionRoot ?? null,
    );
    const buildSourceRoot = this.normalizePath(EXTENSION_BUILD_SOURCE_ROOT);

    if (expectedExtensionRoot && buildSourceRoot && expectedExtensionRoot !== buildSourceRoot) {
      warnings.push(
        `Extension path mismatch: loaded extension build is from "${buildSourceRoot}" but the connected server expects "${expectedExtensionRoot}".`,
      );
    }

    return warnings;
  }

  private async getExtensionStatus(): Promise<ExtensionStatus> {
    const statusCounts: Record<string, number> = {};
    for (const record of this.records.values()) {
      statusCounts[record.status] = (statusCounts[record.status] ?? 0) + 1;
    }

    const sourcePathAvailable = Boolean(EXTENSION_BUILD_SOURCE_ROOT);

    return {
      connected: true,
      lastConnectedAt: this.startedAt,
      extensionId: this.chromeApi.runtime.id,
      extensionVersion: this.chromeApi.runtime.getManifest().version,
      extensionRootUrl: this.chromeApi.runtime.getURL(""),
      buildSourceRoot: EXTENSION_BUILD_SOURCE_ROOT,
      builtAt: EXTENSION_BUILD_TIMESTAMP,
      browserVersion: this.parseBrowserVersion(),
      browserUserAgent:
        typeof navigator !== "undefined" ? navigator.userAgent : null,
      transportMode: "direct-background-websocket",
      activeSessionCount: Array.from(this.controllers.values()).length,
      storedSessionCount: this.records.size,
      sessionStatusCounts: statusCounts,
      sourcePathAvailable,
      sourcePathReason: sourcePathAvailable
        ? null
        : "The current build did not embed an extension source path hint.",
      serverMetadata: this.serverMetadata,
      warnings: this.getStatusWarnings(),
    };
  }

  private async pruneStaleSessions(): Promise<ExtensionPruneResult> {
    const removedSessions: PrunedSession[] = [];

    for (const record of Array.from(this.records.values())) {
      let removeReason: string | undefined;

      try {
        await this.chromeApi.tabs.get(record.tabId);
      } catch {
        removeReason = "tab-missing";
      }

      if (
        !removeReason &&
        typeof record.windowId === "number" &&
        record.windowId >= 0
      ) {
        try {
          await this.chromeApi.windows.get(record.windowId);
        } catch {
          removeReason = "window-missing";
        }
      }

      if (!removeReason) {
        continue;
      }

      await this.disconnectSession(record.sessionId).catch(() => undefined);
      removedSessions.push({
        sessionId: record.sessionId,
        tabId: record.tabId,
        windowId: record.windowId,
        label: record.label,
        reason: removeReason,
      });
    }

    return {
      removedSessions,
      remainingSessionCount: this.records.size,
    };
  }

  private async focusSession(sessionId: string): Promise<void> {
    const record = this.records.get(sessionId);
    if (!record) {
      throw new Error("Session not found.");
    }
    await this.focusLock.run(record, async () => undefined);
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

      const controller = this.createSessionController(record);
      this.controllers.set(record.sessionId, controller);
      this.records.set(record.sessionId, record);
      this.sessionIdByTabId.set(record.tabId, record.sessionId);
      void controller.connect().catch((error) => {
        console.error(
          `BrowseFleetMCP failed to restore session ${record.sessionId}.`,
          errorMessage(error),
        );
      });
    }

    this.schedulePersist();
  }

  private isRuntimeRequestMessage(
    message: PopupRequest | BackgroundRequest | { type?: string } | undefined,
  ): message is RuntimeRequestMessage {
    return (
      typeof message?.type === "string" &&
      (message.type.startsWith("popup/") ||
        message.type.startsWith("background/"))
    );
  }

  private async handleRuntimeRequest(
    runtimeMessage: RuntimeRequestMessage,
  ): Promise<unknown> {
    switch (runtimeMessage.type) {
      case "popup/list-sessions":
        return await this.listSessions();
      case "popup/get-current-tab":
        return await this.getCurrentTabInfo();
      case "popup/get-extension-status":
        return await this.getExtensionStatus();
      case "popup/get-connection-settings":
        return await this.getConnectionSettings();
      case "popup/connect-tab":
        return await this.connectTab(runtimeMessage.payload.tabId);
      case "popup/update-connection-settings":
        return await this.updateConnectionSettings(runtimeMessage.payload);
      case "popup/disconnect-session":
        await this.disconnectSession(runtimeMessage.payload.sessionId);
        return null;
      case "popup/focus-session":
        await this.focusSession(runtimeMessage.payload.sessionId);
        return null;
      case "background/get-connection-settings":
        return await this.getConnectionSettings();
      case "background/get-extension-status":
        return await this.getExtensionStatus();
      case "background/update-server-metadata":
        this.serverMetadata = runtimeMessage.payload;
        return this.serverMetadata;
      case "background/reload-extension":
        return await this.reloadExtension();
      case "background/prune-sessions":
        return await this.pruneStaleSessions();
      case "background/get-session-setup":
        return await this.getSessionSetup(runtimeMessage.payload.sessionId);
      case "background/create-session":
        return await this.createSession(
          runtimeMessage.payload.url,
          runtimeMessage.payload.label,
        );
      case "background/reconnect-session":
        return await this.reconnectSession(runtimeMessage.payload.sessionId);
      case "background/destroy-session":
        return await this.destroySession(runtimeMessage.payload.sessionId);
      case "background/run-session-command":
        return await this.runSessionCommand(
          runtimeMessage.payload.sessionId,
          runtimeMessage.payload.commandType,
          runtimeMessage.payload.commandPayload,
        );
      case "background/update-session-transport":
        return await this.updateSessionTransport(
          runtimeMessage.payload.sessionId,
          runtimeMessage.payload.patch,
        );
      default:
        return null;
    }
  }

  private addRuntimeMessageListener(): void {
    this.chromeApi.runtime.onMessage.addListener(
      (
        message: PopupRequest | BackgroundRequest | { type?: string },
        _sender: unknown,
        sendResponse: (response: RuntimeResponse<unknown>) => void,
      ) => {
        if (!this.isRuntimeRequestMessage(message)) {
          return undefined;
        }

        void this.handleRuntimeRequest(message)
          .then((data) => sendResponse({ ok: true, data }))
          .catch((error) =>
            sendResponse({ ok: false, error: errorMessage(error) }),
          );

        return true;
      },
    );
  }

  private addRuntimePortListener(): void {
    this.chromeApi.runtime.onConnect?.addListener((port: RuntimePort) => {
      if (port.name !== BACKGROUND_BRIDGE_PORT_NAME) {
        return;
      }

      let disconnected = false;
      port.onDisconnect.addListener(() => {
        disconnected = true;
      });

      port.onMessage.addListener((bridgeMessage: BridgeRequestMessage) => {
        const requestId = bridgeMessage?.requestId;
        const runtimeMessage = bridgeMessage?.message;
        if (
          typeof requestId !== "string" ||
          !this.isRuntimeRequestMessage(runtimeMessage)
        ) {
          return;
        }

        void this.handleRuntimeRequest(runtimeMessage)
          .then((data) => {
            if (disconnected) {
              return;
            }

            const response: BridgeResponseMessage = {
              requestId,
              ok: true,
              data,
            };
            try {
              port.postMessage(response);
            } catch {
              disconnected = true;
            }
          })
          .catch((error) => {
            if (disconnected) {
              return;
            }

            const response: BridgeResponseMessage = {
              requestId,
              ok: false,
              error: errorMessage(error),
            };
            try {
              port.postMessage(response);
            } catch {
              disconnected = true;
            }
          });
      });
    });
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
