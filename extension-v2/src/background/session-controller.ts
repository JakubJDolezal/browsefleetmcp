import {
  captureTabScreenshot,
  clickPoint,
  detachDebugger,
  dragBetweenPoints,
  moveMouse,
  pressKeyCombo,
  typeText,
} from "./cdp.js";
import { socketRequestRequiresFocus } from "./focus-lock.js";
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
  type ConnectionSettings,
  type ConsoleEntry,
  type SessionRecord,
  type SessionTransportPatch,
  isConnectableUrl,
  nowIso,
} from "../shared/protocol.js";

export type SessionControllerOptions = {
  record: SessionRecord;
  getConnectionSettings: () => Promise<ConnectionSettings>;
  onUpdate: (record: SessionRecord) => void;
  onDisposed: (sessionId: string) => void;
  startTransport?: (sessionId: string) => Promise<void>;
  stopTransport?: (sessionId: string) => Promise<void>;
  runWithFocusLock?: <T>(
    record: Pick<SessionRecord, "sessionId" | "tabId" | "windowId">,
    action: () => Promise<T>,
  ) => Promise<T>;
};

export class SessionController {
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

    const tab = await this.getTab();
    const url = tab.url ?? "";
    if (!isConnectableUrl(url)) {
      this.updateRecord({
        status: "error",
        url,
        title: tab.title ?? this.record.title,
        lastTransportError: "This tab cannot host a BrowseFleetMCP session.",
      });
      return;
    }

    this.updateRecord({
      status: "connecting",
      title: tab.title ?? this.record.title,
      url,
      windowId: tab.windowId ?? this.record.windowId,
      lastTransportError: undefined,
      lastCommandError: undefined,
    });

    try {
      await this.options.startTransport?.(this.record.sessionId);
    } catch (error) {
      const message = errorMessage(error);
      this.updateRecord({
        status: "error",
        lastTransportError: message,
      });
      throw new Error(message);
    }
  }

  async disconnect(): Promise<void> {
    this.disposed = true;
    let stopTransportError: unknown;
    try {
      await this.options.stopTransport?.(this.record.sessionId);
    } catch (error) {
      stopTransportError = error;
    }

    await detachDebugger(this.record.tabId);

    this.updateRecord({
      status: "disconnected",
      lastTransportError: undefined,
    });
    this.options.onDisposed(this.record.sessionId);

    if (stopTransportError) {
      throw stopTransportError;
    }
  }

  async refreshFromTab(): Promise<void> {
    const tab = await this.getTab();
    this.updateRecord({
      title: tab.title ?? this.record.title,
      url: tab.url ?? this.record.url,
      windowId: tab.windowId ?? this.record.windowId,
    });
  }

  async routeSocketRequest(
    type: string,
    payload: any,
  ): Promise<unknown> {
    const action = async (): Promise<unknown> => {
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
          return await captureTabScreenshot(this.record.tabId);
        case "browser_get_console_logs":
          return await this.getConsoleLogs();
        default:
          throw new Error(`Unsupported socket request type "${type}".`);
      }
    };

    if (!socketRequestRequiresFocus(type) || !this.options.runWithFocusLock) {
      return await action();
    }

    return await this.options.runWithFocusLock(
      {
        sessionId: this.record.sessionId,
        tabId: this.record.tabId,
        windowId: this.record.windowId,
      },
      action,
    );
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
    const pointerMotion = await this.getPointerMotionOptions();

    const navigated = await withPossibleNavigation(this.record.tabId, async () =>
      clickPoint(this.record.tabId, coordinates, pointerMotion),
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
    const pointerMotion = await this.getPointerMotionOptions();

    await dragBetweenPoints(this.record.tabId, start, end, pointerMotion);
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
    await moveMouse(
      this.record.tabId,
      coordinates,
      0,
      await this.getPointerMotionOptions(),
    );
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
    const coordinates = await sendTabMessage<{ x: number; y: number }>(
      this.record.tabId,
      {
        type: "getElementCoordinates",
        payload: { selector, options: { clickable: true } },
      },
    );
    await clickPoint(
      this.record.tabId,
      coordinates,
      await this.getPointerMotionOptions(),
    );
    const inputType = await sendTabMessage<string | null>(this.record.tabId, {
      type: "getInputType",
      payload: { selector },
    });
    await sendTabMessage(this.record.tabId, {
      type: "selectText",
      payload: { selector },
    });
    await pressKeyCombo(this.record.tabId, "Backspace");
    await typeText(this.record.tabId, text);
    if (
      inputType &&
      ["date", "time", "datetime-local", "month", "range", "week"].includes(
        inputType,
      )
    ) {
      const currentValue = await sendTabMessage<string>(this.record.tabId, {
        type: "getInputValue",
        payload: { selector },
      });
      if (currentValue !== text) {
        await sendTabMessage(this.record.tabId, {
          type: "setInputValue",
          payload: { selector, value: text },
        });
      }
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

  private async getPointerMotionOptions(): Promise<{
    pointerMode: ConnectionSettings["pointerMode"];
  }> {
    const settings = await this.options.getConnectionSettings();
    return {
      pointerMode: settings.pointerMode,
    };
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

  applyTransportUpdate(patch: SessionTransportPatch): void {
    this.updateRecord(patch);
  }

  recordCommandError(message: string): void {
    this.updateRecord({
      lastCommandError: message,
    });
  }

  recordCommandSuccess(): void {
    if (!this.record.lastCommandError) {
      return;
    }

    this.updateRecord({
      lastCommandError: undefined,
    });
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
}
