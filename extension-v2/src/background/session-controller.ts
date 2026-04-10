import {
  captureTabScreenshot,
  clickPoint,
  detachDebugger,
  dragBetweenPoints,
  moveMouse,
  pressKeyCombo,
  typeText,
} from "./cdp.js";
import { captureDesktopScreenshot } from "./desktop-capture.js";
import {
  ensureContentScript,
  errorMessage,
  runTabHistoryNavigation,
  sendTabMessage,
  wait,
  waitForTabComplete,
  withPossibleNavigation,
} from "./runtime.js";
import {
  DEFAULT_WS_PORT,
  SOCKET_RESPONSE_TYPE,
  type ConsoleEntry,
  type SessionRecord,
  type SocketRequestMessage,
  type SocketResponseMessage,
  isConnectableUrl,
  nowIso,
} from "../shared/protocol.js";

type SessionControllerOptions = {
  record: SessionRecord;
  onUpdate: (record: SessionRecord) => void;
  onDisposed: (sessionId: string) => void;
};

export class SessionController {
  private socket?: WebSocket;
  private reconnectTimer?: number;
  private disposed = false;
  private record: SessionRecord;

  constructor(private readonly options: SessionControllerOptions) {
    this.record = options.record;
  }

  get recordSnapshot(): SessionRecord {
    return { ...this.record };
  }

  get tabId(): number {
    return this.record.tabId;
  }

  async connect(): Promise<void> {
    if (this.disposed) {
      return;
    }

    if (
      this.socket &&
      (this.socket.readyState === WebSocket.OPEN ||
        this.socket.readyState === WebSocket.CONNECTING)
    ) {
      return;
    }

    const tab = await this.getTab();
    const url = tab.url ?? "";
    if (!isConnectableUrl(url)) {
      this.updateRecord({
        status: "error",
        url,
        title: tab.title ?? this.record.title,
        lastError: "This tab cannot host a BrowseFleetMCP session.",
      });
      return;
    }

    this.updateRecord({
      status: "connecting",
      title: tab.title ?? this.record.title,
      url,
      windowId: tab.windowId ?? this.record.windowId,
      lastError: undefined,
    });

    const socketUrl = new URL(`ws://127.0.0.1:${DEFAULT_WS_PORT}`);
    socketUrl.searchParams.set("sessionId", this.record.sessionId);
    socketUrl.searchParams.set("tabId", String(this.record.tabId));
    socketUrl.searchParams.set("windowId", String(this.record.windowId));

    const socket = new WebSocket(socketUrl.toString());
    this.socket = socket;

    socket.addEventListener("open", () => {
      this.updateRecord({
        status: "connected",
        lastError: undefined,
      });
    });

    socket.addEventListener("message", (event) => {
      void this.handleSocketMessage(socket, event.data);
    });

    socket.addEventListener("error", () => {
      this.updateRecord({
        status: "error",
        lastError: "Failed to connect to the local BrowseFleetMCP server.",
      });
    });

    socket.addEventListener("close", () => {
      if (this.socket === socket) {
        this.socket = undefined;
      }

      if (this.disposed) {
        this.updateRecord({ status: "disconnected" });
        return;
      }

      this.updateRecord({
        status: "error",
        lastError: "BrowseFleetMCP session disconnected. Retrying.",
      });
      this.scheduleReconnect();
    });
  }

  async disconnect(): Promise<void> {
    this.disposed = true;
    this.clearReconnectTimer();
    await detachDebugger(this.record.tabId);

    if (this.socket) {
      const socket = this.socket;
      this.socket = undefined;
      if (
        socket.readyState === WebSocket.OPEN ||
        socket.readyState === WebSocket.CONNECTING
      ) {
        socket.close();
      }
    }

    this.updateRecord({
      status: "disconnected",
      lastError: undefined,
    });
    this.options.onDisposed(this.record.sessionId);
  }

  async refreshFromTab(): Promise<void> {
    const tab = await this.getTab();
    this.updateRecord({
      title: tab.title ?? this.record.title,
      url: tab.url ?? this.record.url,
      windowId: tab.windowId ?? this.record.windowId,
    });
  }

  private async handleSocketMessage(
    socket: WebSocket,
    data: string,
  ): Promise<void> {
    let message: SocketRequestMessage;
    try {
      message = JSON.parse(data) as SocketRequestMessage;
    } catch {
      return;
    }

    let result: unknown;
    let error: string | undefined;
    try {
      result = await this.routeSocketRequest(message.type, message.payload);
    } catch (caughtError) {
      error = errorMessage(caughtError);
      this.updateRecord({ status: "error", lastError: error });
    }

    if (socket.readyState !== WebSocket.OPEN) {
      return;
    }

    const response: SocketResponseMessage = {
      id: crypto.randomUUID(),
      type: SOCKET_RESPONSE_TYPE,
      payload: {
        requestId: message.id,
        result,
        error,
      },
    };
    socket.send(JSON.stringify(response));
  }

  private async routeSocketRequest(
    type: string,
    payload: any,
  ): Promise<unknown> {
    switch (type) {
      case "getTitle":
        return this.record.title;
      case "getUrl":
        return this.record.url;
      case "browser_navigate":
        await this.navigate(payload.url);
        return null;
      case "browser_go_back":
        await this.goBack();
        return null;
      case "browser_go_forward":
        await this.goForward();
        return null;
      case "browser_wait":
        await wait(Number(payload.time) * 1_000);
        return null;
      case "browser_press_key":
        await this.pressKey(String(payload.key));
        return null;
      case "browser_snapshot":
        return await this.captureSnapshot();
      case "browser_click":
        await this.click(String(payload.ref));
        return null;
      case "browser_drag":
        await this.drag(String(payload.startRef), String(payload.endRef));
        return null;
      case "browser_hover":
        await this.hover(String(payload.ref));
        return null;
      case "browser_type":
        await this.type(
          String(payload.ref),
          String(payload.text),
          Boolean(payload.submit),
        );
        return null;
      case "browser_select_option":
        await this.selectOption(String(payload.ref), payload.values);
        return null;
      case "browser_screenshot":
        return await captureTabScreenshot(this.record.tabId);
      case "browser_screen_screenshot":
        return await captureDesktopScreenshot();
      case "browser_get_console_logs":
        return await this.getConsoleLogs();
      default:
        throw new Error(`Unsupported socket request type "${type}".`);
    }
  }

  private async getTab(): Promise<any> {
    return await chrome.tabs.get(this.record.tabId);
  }

  private async navigate(url: string): Promise<void> {
    await chrome.tabs.update(this.record.tabId, { url });
    await waitForTabComplete(this.record.tabId);
    await ensureContentScript(this.record.tabId);
    await this.refreshFromTab();
    await this.waitForStableDom();
  }

  private async goBack(): Promise<void> {
    await runTabHistoryNavigation(this.record.tabId, "back");
    await waitForTabComplete(this.record.tabId);
    await ensureContentScript(this.record.tabId);
    await this.refreshFromTab();
    await this.waitForStableDom();
  }

  private async goForward(): Promise<void> {
    await runTabHistoryNavigation(this.record.tabId, "forward");
    await waitForTabComplete(this.record.tabId);
    await ensureContentScript(this.record.tabId);
    await this.refreshFromTab();
    await this.waitForStableDom();
  }

  private async captureSnapshot(): Promise<string> {
    await ensureContentScript(this.record.tabId);
    return await sendTabMessage<string>(this.record.tabId, {
      type: "generateAriaSnapshot",
    });
  }

  private async click(ref: string): Promise<void> {
    await ensureContentScript(this.record.tabId);
    const selector = await this.getSelectorForRef(ref);
    await sendTabMessage(this.record.tabId, {
      type: "scrollIntoView",
      payload: { selector },
    });
    const coordinates = await sendTabMessage<{ x: number; y: number }>(
      this.record.tabId,
      {
        type: "getElementCoordinates",
        payload: { selector, options: { clickable: true } },
      },
    );

    const navigated = await withPossibleNavigation(this.record.tabId, async () =>
      clickPoint(this.record.tabId, coordinates),
    );

    await this.afterInteraction(navigated);
  }

  private async drag(startRef: string, endRef: string): Promise<void> {
    await ensureContentScript(this.record.tabId);
    const startSelector = await this.getSelectorForRef(startRef);
    const endSelector = await this.getSelectorForRef(endRef);

    const start = await sendTabMessage<{ x: number; y: number }>(
      this.record.tabId,
      {
        type: "getElementCoordinates",
        payload: { selector: startSelector, options: { clickable: true } },
      },
    );
    const end = await sendTabMessage<{ x: number; y: number }>(
      this.record.tabId,
      {
        type: "getElementCoordinates",
        payload: { selector: endSelector, options: { clickable: true } },
      },
    );

    await dragBetweenPoints(this.record.tabId, start, end);
    await this.waitForStableDom();
  }

  private async hover(ref: string): Promise<void> {
    await ensureContentScript(this.record.tabId);
    const selector = await this.getSelectorForRef(ref);
    await sendTabMessage(this.record.tabId, {
      type: "scrollIntoView",
      payload: { selector },
    });
    const coordinates = await sendTabMessage<{ x: number; y: number }>(
      this.record.tabId,
      {
        type: "getElementCoordinates",
        payload: { selector },
      },
    );
    await moveMouse(this.record.tabId, coordinates);
    await this.waitForStableDom();
  }

  private async type(
    ref: string,
    text: string,
    submit: boolean,
  ): Promise<void> {
    await ensureContentScript(this.record.tabId);
    const selector = await this.getSelectorForRef(ref);
    await sendTabMessage(this.record.tabId, {
      type: "scrollIntoView",
      payload: { selector },
    });

    const inputType = await sendTabMessage<string | null>(this.record.tabId, {
      type: "getInputType",
      payload: { selector },
    });
    if (
      inputType &&
      ["date", "time", "datetime-local", "month", "range", "week"].includes(
        inputType,
      )
    ) {
      await sendTabMessage(this.record.tabId, {
        type: "setInputValue",
        payload: { selector, value: text },
      });
    } else {
      await sendTabMessage(this.record.tabId, {
        type: "selectText",
        payload: { selector },
      });
      await pressKeyCombo(this.record.tabId, "Backspace");
      await typeText(this.record.tabId, text);
    }

    if (submit) {
      const navigated = await withPossibleNavigation(
        this.record.tabId,
        async () => {
          await pressKeyCombo(this.record.tabId, "Enter");
        },
      );
      await this.afterInteraction(navigated);
      return;
    }

    await this.waitForStableDom();
  }

  private async selectOption(ref: string, values: unknown): Promise<void> {
    await ensureContentScript(this.record.tabId);
    const selector = await this.getSelectorForRef(ref);
    await sendTabMessage(this.record.tabId, {
      type: "selectOption",
      payload: {
        selector,
        values: Array.isArray(values) ? values.map(String) : [],
      },
    });
    await this.waitForStableDom();
  }

  private async pressKey(key: string): Promise<void> {
    const navigated = await withPossibleNavigation(this.record.tabId, async () => {
      await pressKeyCombo(this.record.tabId, key);
    });
    await this.afterInteraction(navigated);
  }

  private async getSelectorForRef(ref: string): Promise<string> {
    return await sendTabMessage<string>(this.record.tabId, {
      type: "getSelectorForAriaRef",
      payload: { ariaRef: ref },
    });
  }

  private async getConsoleLogs(): Promise<ConsoleEntry[]> {
    await ensureContentScript(this.record.tabId);
    return await sendTabMessage<ConsoleEntry[]>(this.record.tabId, {
      type: "getConsoleLogs",
    });
  }

  private async waitForStableDom(): Promise<void> {
    await ensureContentScript(this.record.tabId);
    await sendTabMessage(this.record.tabId, {
      type: "waitForStableDOM",
      payload: {
        minStableMs: 1_000,
        maxMutations: 0,
        maxWaitMs: 3_000,
      },
    });
  }

  private async afterInteraction(navigated: boolean): Promise<void> {
    if (navigated) {
      await waitForTabComplete(this.record.tabId);
      await ensureContentScript(this.record.tabId);
      await this.refreshFromTab();
    }
    await this.waitForStableDom();
  }

  private updateRecord(patch: Partial<SessionRecord>): void {
    const hasChanged = Object.entries(patch).some(
      ([key, value]) => this.record[key as keyof SessionRecord] !== value,
    );
    if (!hasChanged) {
      return;
    }

    this.record = {
      ...this.record,
      ...patch,
      updatedAt: nowIso(),
    };
    this.options.onUpdate(this.recordSnapshot);
  }

  private scheduleReconnect(): void {
    this.clearReconnectTimer();
    this.reconnectTimer = setTimeout(() => {
      void this.connect();
    }, 1_000) as unknown as number;
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
  }
}
