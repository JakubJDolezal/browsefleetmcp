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

type ClickFallbackCandidate = {
  selector: string;
  reason: "target" | "descendant" | "ancestor";
  text?: string;
  name?: string;
  href?: string;
};

type PointerMotionPreference = {
  pointerMode: ConnectionSettings["pointerMode"];
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
        case "browser_page_snapshot":
          return await this.capturePageSnapshot();
        case "browser_extract_product_cards":
          return await this.extractProductCards(payload);
        case "browser_find_element":
          return await this.findElement(payload);
        case "browser_click":
          await this.click(
            String(payload.ref),
            typeof payload?.element === "string" ? payload.element : "",
            payload?.followHref !== false,
          );
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
        case "browser_set_input_by_label":
          await this.setInputByLabel(payload);
          return null;
        case "browser_select_option_by_label":
          await this.selectOptionByLabel(payload);
          return null;
        case "browser_click_by_text":
          await this.clickByText(payload);
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

  private async capturePageSnapshot(): Promise<unknown> {
    await ensureContentScript(this.record.tabId);
    await this.refreshFromTab();
    return await sendTabMessage(this.record.tabId, {
      type: "generatePageSnapshot",
    });
  }

  private async extractProductCards(payload: any): Promise<unknown> {
    await ensureContentScript(this.record.tabId);
    await this.refreshFromTab();
    return await sendTabMessage(this.record.tabId, {
      type: "extractProductCards",
      payload: {
        query: typeof payload?.query === "string" ? payload.query : undefined,
        maxCards:
          typeof payload?.maxCards === "number" ? payload.maxCards : undefined,
      },
    });
  }

  private async findElement(payload: any): Promise<unknown> {
    await ensureContentScript(this.record.tabId);
    return await sendTabMessage(this.record.tabId, {
      type: "findElement",
      payload: {
        label: typeof payload?.label === "string" ? payload.label : undefined,
        text: typeof payload?.text === "string" ? payload.text : undefined,
        role: typeof payload?.role === "string" ? payload.role : undefined,
        exact: Boolean(payload?.exact),
      },
    });
  }

  private async click(
    ref: string,
    elementText = "",
    followHref = true,
  ): Promise<void> {
    await ensureContentScript(this.record.tabId);
    const selector = await this.getSelectorForRef(ref);
    const pointerMotion = await this.getPointerMotionOptions();
    const failures: string[] = [];

    const recordFailure = (label: string, error: unknown) => {
      failures.push(`${label}: ${errorMessage(error)}`);
    };

    try {
      await this.clickSelector(selector, pointerMotion);
      return;
    } catch (error) {
      recordFailure("ref", error);
    }

    let fallbackCandidates: ClickFallbackCandidate[] = [];
    try {
      fallbackCandidates = await sendTabMessage<ClickFallbackCandidate[]>(
        this.record.tabId,
        {
          type: "getClickFallbackCandidates",
          payload: { selector },
        },
      );
    } catch (error) {
      recordFailure("fallback-discovery", error);
    }

    const seenSelectors = new Set([selector]);
    for (const candidate of fallbackCandidates) {
      if (!candidate.selector || seenSelectors.has(candidate.selector)) {
        continue;
      }
      seenSelectors.add(candidate.selector);

      try {
        await this.clickSelector(candidate.selector, pointerMotion);
        return;
      } catch (error) {
        recordFailure(`${candidate.reason}:${candidate.selector}`, error);
      }
    }

    for (const text of this.getTextClickFallbacks(
      elementText,
      fallbackCandidates,
    )) {
      for (const exact of [true, false]) {
        try {
          await this.clickByText({ text, exact });
          return;
        } catch (error) {
          recordFailure(`text:${exact ? "exact" : "contains"}:${text}`, error);
        }
      }
    }

    const href = fallbackCandidates.find(
      (candidate) => candidate.href && isConnectableUrl(candidate.href),
    )?.href;
    if (followHref && href) {
      await this.navigate(href);
      return;
    }

    throw new Error(
      [
        `Unable to click ref "${ref}".`,
        failures.length > 0
          ? `Fallback attempts failed: ${failures.slice(0, 8).join(" | ")}`
          : "No fallback click targets were available.",
      ].join(" "),
    );
  }

  private async clickSelector(
    selector: string,
    pointerMotion: PointerMotionPreference,
  ): Promise<void> {
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
      clickPoint(this.record.tabId, coordinates, pointerMotion),
    );

    await this.afterInteraction(navigated);
  }

  private getTextClickFallbacks(
    elementText: string,
    candidates: ClickFallbackCandidate[],
  ): string[] {
    const values = [
      elementText,
      ...candidates.flatMap((candidate) => [candidate.name, candidate.text]),
    ];
    const seen = new Set<string>();
    const normalized: string[] = [];

    for (const value of values) {
      const candidate = String(value ?? "").replace(/\s+/g, " ").trim();
      if (!candidate || candidate.length > 300 || seen.has(candidate)) {
        continue;
      }
      seen.add(candidate);
      normalized.push(candidate);
    }

    return normalized.slice(0, 6);
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

  private async setInputByLabel(payload: any): Promise<void> {
    await ensureContentScript(this.record.tabId);
    await sendTabMessage(this.record.tabId, {
      type: "setInputByLabel",
      payload: {
        label: String(payload?.label ?? ""),
        value: String(payload?.value ?? ""),
        exact: Boolean(payload?.exact),
      },
    });
    await this.waitForStableDom();
  }

  private async selectOptionByLabel(payload: any): Promise<void> {
    await ensureContentScript(this.record.tabId);
    await sendTabMessage(this.record.tabId, {
      type: "selectOptionByLabel",
      payload: {
        label: String(payload?.label ?? ""),
        option: String(payload?.option ?? ""),
        exact: Boolean(payload?.exact),
      },
    });
    await this.waitForStableDom();
  }

  private async clickByText(payload: any): Promise<void> {
    await ensureContentScript(this.record.tabId);
    const navigated = await withPossibleNavigation(this.record.tabId, async () => {
      await sendTabMessage(this.record.tabId, {
        type: "clickByText",
        payload: {
          text: String(payload?.text ?? ""),
          role: typeof payload?.role === "string" ? payload.role : undefined,
          exact: Boolean(payload?.exact),
        },
      });
    });
    await this.afterInteraction(navigated);
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
